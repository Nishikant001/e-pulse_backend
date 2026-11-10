// services/erp/sync/mappingPreflight.js — Phase 19. CAPABILITY-SPECIFIC mapping preflight. Vendor-neutral: it knows only the target's own schema
// (fields / requiredFields / allowedFields) and the stored mapping rows. It never calls an ERP and never writes.
//
// Two severities, deliberately separate:
//   BLOCKERS  — static configuration defects that make EVERY record of the run fail (no key, a required target field not mapped, an empty source path, a field the
//               target does not allow, no payment mode source, no payment terms source). A sync is refused before a job exists and before any ERP call.
//   WARNINGS  — data-dependent prerequisites (no product has been synchronised yet, no plant → warehouse code mapping yet …). They can be satisfied by an earlier job in
//               the same schedule window, so they NEVER block (blocking would change Phase 14–16 behaviour); they are reported so the person can see them.
// Nothing is guessed and no default is invented: a missing source of truth is reported as a field-level reason.


const KEY_FIELD = "external_id";
const KEY_MESSAGE = "No field mapping (with a key field) is configured for this ERP and capability."; // unchanged Phase 14 wording

const blocker = (rule, field, message) => ({ code: "MAPPING_NOT_CONFIGURED", rule, field, message });
const warning = (rule, field, message) => ({ code: "PREREQUISITE_MISSING", rule, field, message });
const labelOf = (target, f) => ((target.fields || []).find((x) => x.name === f) || {}).label || f;

/**
 * Pure. @param {{capability:string, target:object, mappings:object[], scope?:object, facts?:object}} p
 * `mappings` are erp_entity_mappings rows (plain). `scope` is the RESOLVED scope ({ defaultMode, defaultPaymentTerms, … }).

 * `scopeKnown:false` (the dashboard has no run scope) skips the two rules that depend on a run's default mode / default payment terms.
 * `facts` (optional, from gatherFacts) = { links:{PRODUCT,CUSTOMER,CODE_WAREHOUSE,CODE_PAYMENT_MODE}, batches } — only used for warnings.
 * @returns {{ ok:boolean, blockers:object[], warnings:object[] }}
 */
function evaluate({ capability, target, mappings = [], scope = {}, scopeKnown = true, facts = null }) {
  const blockers = []; const warnings = [];
  const rows = Array.isArray(mappings) ? mappings : [];
  const isKey = (m) => Boolean(m.is_key) || m.dms_field === KEY_FIELD;
  const keyRow = rows.find(isKey);

  // 1 · source key / external identity
  if (!keyRow) blockers.push(blocker("KEY_MISSING", KEY_FIELD, KEY_MESSAGE));
  else if (!String(keyRow.source_field || "").trim()) blockers.push(blocker("KEY_SOURCE_EMPTY", KEY_FIELD, "The key mapping has no ERP source field, so no record can be identified."));

  // 2 · every mapping must point at a source path and at a field the target allows
  const allowed = new Set([...(target.allowedFields || []), KEY_FIELD]);
  for (const m of rows) {
    if (isKey(m)) continue;
    if (!String(m.source_field || "").trim()) blockers.push(blocker("SOURCE_EMPTY", m.dms_field, `The mapping for "${m.dms_field}" has no ERP source field.`));
    if (!allowed.has(m.dms_field)) blockers.push(blocker("FIELD_NOT_WRITABLE", m.dms_field, `"${m.dms_field}" is not a field this capability may write (the mapping is stale). Allowed: ${(target.allowedFields || []).join(", ")}.`));
  }

  // 3 · required target fields
  const mapped = new Set(rows.filter((m) => !isKey(m) && String(m.source_field || "").trim()).map((m) => m.dms_field));
  for (const f of target.requiredFields || []) {
    if (!mapped.has(f)) blockers.push(blocker("REQUIRED_FIELD_UNMAPPED", f, `A mapping to "${labelOf(target, f)}" (${f}) is required for ${target.label}.`));
  }

  // 4 · capability-specific sources of truth that the target will otherwise refuse record by record
  if (scopeKnown && capability === "PAYMENT" && !mapped.has("mode") && !scope.defaultMode) {
    blockers.push(blocker("PAYMENT_MODE_UNDEFINED", "mode", "No payment mode source: map the ERP payment mode field, or choose a default payment mode for the sync. The DMS does not guess it."));
  }
  if (scopeKnown && capability === "SALES" && !mapped.has("payment_terms") && !scope.defaultPaymentTerms) {
    blockers.push(blocker("PAYMENT_TERMS_UNDEFINED", "payment_terms", "No payment terms source: map the ERP payment terms field, or choose default payment terms for the sync. The DMS does not guess them."));
  }

  // 5 · data-dependent prerequisites → warnings only
  if (facts) {
    const n = (k) => (facts.links && facts.links[k]) || 0;
    if (["PRICING", "STOCK", "SALES"].includes(capability) && n("PRODUCT") === 0) warnings.push(warning("PRODUCT_NOT_SYNCED", "product_external_id", "No product has been synchronised for this distributor yet; run the Product master sync first or every record will fail."));
    if (["SALES", "PAYMENT"].includes(capability) && n("CUSTOMER") === 0) warnings.push(warning("CUSTOMER_NOT_SYNCED", "customer_external_id", "No customer has been synchronised for this distributor yet; run the Customer master sync first or every record will fail."));
    if (capability === "STOCK") {
      if (n("CODE_WAREHOUSE") === 0) warnings.push(warning("WAREHOUSE_MAPPING_MISSING", "plant_code", "No plant → warehouse code mapping exists; every stock record will wait for one."));
      if (facts.batches === 0) warnings.push(warning("NO_DMS_BATCHES", "batch_no", "The distributor has no batches. A sync never creates batches, so every stock record will fail until they exist."));
    }
    if (capability === "PAYMENT" && mapped.has("mode") && n("CODE_PAYMENT_MODE") === 0) warnings.push(warning("PAYMENT_MODE_MAPPING_MISSING", "mode", "No payment-mode code mapping exists; ERP modes that are not DMS mode names will wait for one."));
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

/** Counts used for the warnings. Read-only, tenant-safe (the connection already belongs to the tenant). Never throws for a missing model. */
async function gatherFacts(db, conn, capability, resolved) {
  const did = resolved && resolved.ctx ? resolved.ctx.distributorId : null;
  const scopeKey = did ? `distributor:${did}` : null;
  const count = (entityType, scoped) => db.ErpExternalLink.count({ where: { connection_id: conn.id, entity_type: entityType, ...(scoped && scopeKey ? { scope_key: scopeKey } : {}) } });
  const facts = { links: {}, batches: null };
  const need = { PRICING: ["PRODUCT"], STOCK: ["PRODUCT", "CODE_WAREHOUSE"], SALES: ["PRODUCT", "CUSTOMER"], PAYMENT: ["CUSTOMER", "CODE_PAYMENT_MODE"] }[capability] || [];
  for (const t of need) facts.links[t] = await count(t, t !== "CODE_PAYMENT_MODE"); // the payment-mode mapping is connection-wide (scope_key "")
  if (capability === "STOCK" && did) facts.batches = await db.Batch.count({ where: { distributor_id: did } });
  return facts;
}

/** Loads the mappings of a connection + capability and evaluates them. `resolved` = target.resolveScope() output. */
async function check(db, conn, capability, target, resolved, { withFacts = true } = {}) {
  const maps = (await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability }, order: [["id", "ASC"]] })).map((m) => (m.get ? m.get({ plain: true }) : m));
  const facts = withFacts ? await gatherFacts(db, conn, capability, resolved) : null;
  return { maps, ...evaluate({ capability, target, mappings: maps, scope: (resolved && resolved.scope) || {}, facts }) };
}

module.exports = { evaluate, gatherFacts, check, KEY_MESSAGE };
