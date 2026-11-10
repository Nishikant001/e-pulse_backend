// services/erpReconciliation.service.js — Phase 18. GENERIC, READ-ONLY reconciliation: "what the ERP says" vs "what the DMS holds", for any capability whose target
// provides reconcile(). One implementation for every ERP — it reads through the provider contract, maps with the connection's mappings, and asks the target to compare.
//
//   MATCHED · MISMATCH · MISSING_IN_DMS · MISSING_IN_ERP · BLOCKED · PENDING_REVIEW
//
// It NEVER creates, updates or deletes a DMS business record, and never posts stock or accounting. The only things it writes are the reconcile_* columns of the
// erp_external_links rows it compared (a note about the last comparison) and one audit event. Fixing a difference is always a separate, explicit act:
// a normal sync (if ownership allows) or a business decision.
//   • ownership gate: when the capability's ownership / direction does not allow importing, every difference is reported as BLOCKED (never as something a sync would fix).
//   • MISSING_IN_ERP is reported only when the whole ERP result set was read (no limit hit, no failure) — a partial read proves nothing about what is absent.
const { ErpApiError } = require("./erp/erpApiError");
const { ErpIntegrationError, normalizeError } = require("./erp/erpErrors");
const { buildProvider } = require("./erp/connectionManager");
const { resolveProviderKey, getDescriptor, hasFeature } = require("./erp/providerRegistry");
const { getTarget, getUnsupported, TARGETS } = require("./erp/sync/targets");
const { mapRecord, contentHash } = require("./erp/sync/mapper");
const { fetchWithRetry } = require("./erp/sync/syncEngine");
const ownershipSvc = require("./erpOwnership.service");
const audit = require("./erpAudit.service");
const sync = require("./erpSync.service");
const reqctx = require("../utils/requestContext");
const V = require("../utils/erpValidate");
const C = require("./erp/erpConstants");

const STATUSES = ["MATCHED", "MISMATCH", "MISSING_IN_DMS", "MISSING_IN_ERP", "BLOCKED", "PENDING_REVIEW"];
const LIMITS = { pageSize: 100, maxPages: 50, maxRecords: 5000, maxItems: 200, fetchAttempts: 2 };
const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const plain = (r) => (r ? r.get({ plain: true }) : null);
const reconcilable = (capability) => { const t = getTarget(capability); return t && typeof t.reconcile === "function" ? t : null; };
const RECONCILABLE_CAPABILITIES = Object.values(TARGETS).filter((t) => typeof t.reconcile === "function").map((t) => t.capability);

const detailText = (x) => JSON.stringify({ detail: x.detail || null, erp: x.erp || null, dms: x.dms || null, difference: x.difference ?? null, code: x.code || null }).slice(0, 2000);

/**
 * Runs one comparison. Returns null for a foreign / unknown connection (→ 404, before anything else; no ERP call).
 * @param body { connectionId, capability, scope }   deps { fetchImpl, logger, limits, correlationId }
 */
async function run(db, tenantKey, adminId, body = {}, deps = {}) {
  if (!body || typeof body !== "object") throw err(400, "VALIDATION_FAILED", "Request body must be an object");
  const conn = await sync.loadConnection(db, tenantKey, body.connectionId);
  if (!conn) return null;
  const capability = V.oneOf(body.capability, C.CAPABILITY_VALUES, "capability");
  if (!capability) throw err(400, "VALIDATION_FAILED", "capability is required", { field: "capability" });
  const target = getTarget(capability);
  if (!target) { const u = getUnsupported(capability); throw err(409, u ? u.code : "CAPABILITY_NOT_SUPPORTED", `${capability} cannot be reconciled. ${u ? u.reason : "There is no DMS target for it."}`); }
  if (typeof target.reconcile !== "function") throw err(409, "CAPABILITY_NOT_SUPPORTED", `${capability} has no reconciliation.`);
  if (conn.status === "INACTIVE") throw err(409, "INVALID_CONFIGURATION", "The ERP connection is inactive. Activate it first.");
  const cap = await db.ErpConnectionCapability.findOne({ where: { connection_id: conn.id, capability } });
  if (!cap || !cap.enabled || cap.direction === "DISABLED") throw err(409, "CAPABILITY_NOT_SUPPORTED", "This capability is not enabled for this ERP connection.");
  const key = resolveProviderKey(conn); const desc = key ? getDescriptor(key) : null;
  if (!desc || desc.status !== "IMPLEMENTED") throw err(409, "PROVIDER_NOT_SUPPORTED", desc ? `The ${desc.label} provider is not implemented yet.` : "No provider is selected for this ERP connection.");
  if (!hasFeature(desc, "READ")) throw err(409, "PROVIDER_NOT_SUPPORTED", `The ${desc.label} provider cannot read data.`);
  if (!cap.endpoint_path) throw err(409, "INVALID_CONFIGURATION", "No endpoint is configured for this capability.");
  const mappings = (await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability }, order: [["id", "ASC"]] })).map(plain);
  if (!mappings.length || !mappings.some((m) => m.is_key)) throw err(409, "MAPPING_NOT_CONFIGURED", "No field mapping (with a key field) is configured for this ERP and capability.");
  let resolved;
  try { resolved = await target.resolveScope(db, body.scope || {}); } catch (e) {
    if (e instanceof ErpIntegrationError) throw err(400, e.code === "INVALID_CONFIGURATION" ? "VALIDATION_FAILED" : e.code, e.message, { field: "scope" });
    throw e;
  }
  const gate = ownershipSvc.evaluate(plain(cap), capability, "inbound"); // comparison is allowed whatever the ownership; what a difference MEANS depends on it
  const limits = { ...LIMITS, ...(deps.limits || {}) };
  const correlationId = deps.correlationId || reqctx.currentCorrelationId() || null;
  const ctx = { ...resolved.ctx, connectionId: conn.id, tenantKey, jobId: null, adminId: adminId || null };

  const counts = Object.fromEntries(["total", ...STATUSES].map((k) => [k, 0]));
  const items = []; const seen = new Set();
  let fatal = null; let truncated = false; let index = 0; let unidentified = 0;
  const note = (item) => { counts.total += 1; counts[item.status] += 1; if (item.status !== "MATCHED" && items.length < limits.maxItems) items.push(item); };

  try {
    const capsPlain = (await db.ErpConnectionCapability.findAll({ where: { connection_id: conn.id } })).map(plain);
    const provider = await buildProvider(plain(conn), { capabilities: capsPlain, fetchImpl: deps.fetchImpl, logger: deps.logger });
    if (!provider.supports.fetch) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: "This provider cannot read data." });
    let cursor = null; let pages = 0;
    do {
      const page = await fetchWithRetry(provider, { endpointPath: cap.endpoint_path, config: cap.config || {}, cursor, pageSize: limits.pageSize, correlationId }, { attempts: limits.fetchAttempts, delayMs: deps.retryDelayMs ?? Number(process.env.ERP_SYNC_RETRY_DELAY_MS || 500) });
      pages += 1;
      for (const rec of page.records) {
        if (index >= limits.maxRecords) { truncated = true; break; }
        index += 1;
        let externalId = null;
        try {
          const mapped = mapRecord(rec, mappings); externalId = mapped.externalId; seen.add(externalId);
          const link = await db.ErpExternalLink.findOne({ where: { connection_id: conn.id, entity_type: target.entityType, external_id: externalId, scope_key: resolved.scopeKey } });
          const entity = link ? await target.find(db, link.dms_entity_id, ctx, undefined) : null;
          const values = target.validate(mapped.values, { creating: !entity, ctx });
          let res = await target.reconcile(db, values, ctx, { entity, link, hash: contentHash(values), t: undefined });
          if (!gate.ok && res.status !== "MATCHED") res = { ...res, observedStatus: res.status, status: "BLOCKED", code: gate.code, detail: `${gate.message} (observed: ${res.status}${res.detail ? ` — ${res.detail}` : ""})` };
          if (link) await link.update({ reconcile_status: res.status, reconciled_at: new Date(), reconcile_detail: detailText(res) });
          note({ externalId, status: res.status, code: res.code || null, detail: res.detail || null, erp: res.erp || null, dms: res.dms || null, difference: res.difference ?? null, lastSyncedQuantity: res.lastSyncedQuantity ?? undefined, differences: res.differences || undefined, dmsEntityId: link ? link.dms_entity_id : null });
        } catch (e) {
          const n = normalizeError(e);
          // Phase 19: a record the ERP RETURNED but that cannot be mapped now (e.g. a bad number) is present in the ERP. Its id (when the key itself is readable) counts as
          // "seen", so its link is never reported as MISSING_IN_ERP. A record whose key cannot be read cannot be matched to anything: it makes "missing" unprovable.
          const id = externalId !== null ? externalId : (e && e.externalId) || null;
          if (id !== null) seen.add(id); else unidentified += 1;
          note({ externalId: id, status: "BLOCKED", code: n.code, detail: String(n.message).slice(0, 300) });
        }
      }
      if (truncated) break;
      if (pages >= limits.maxPages) { truncated = Boolean(page.hasMore); break; }
      if (page.hasMore) {
        if (!page.nextCursor || String(page.nextCursor) === String(cursor)) throw new ErpIntegrationError("INVALID_RESPONSE", { message: "The ERP repeated the same page; the comparison was stopped." });
        cursor = page.nextCursor;
      } else cursor = null;
    } while (cursor !== null);
  } catch (e) { fatal = normalizeError(e); }

  // MISSING_IN_ERP: linked DMS records the ERP no longer returns — only provable when the ERP result set was read completely.
  const complete = !fatal && !truncated && unidentified === 0; // an unidentifiable ERP record means absence cannot be proven
  if (complete) {
    const links = await db.ErpExternalLink.findAll({ where: { tenant_key: tenantKey, connection_id: conn.id, entity_type: target.entityType, scope_key: resolved.scopeKey }, limit: 20000 });
    for (const l of links) {
      if (seen.has(l.external_id)) continue;
      const res = gate.ok ? { status: "MISSING_IN_ERP", detail: "The DMS holds this record but the ERP no longer returns it." } : { status: "BLOCKED", code: gate.code, detail: `${gate.message} (observed: MISSING_IN_ERP)` };
      await l.update({ reconcile_status: res.status, reconciled_at: new Date(), reconcile_detail: detailText(res) });
      note({ externalId: l.external_id, status: res.status, code: res.code || null, detail: res.detail, dmsEntityId: l.dms_entity_id });
    }
  }

  const problems = counts.total - counts.MATCHED;
  audit.record(db, { event: "ERP_RECONCILIATION_RUN", adminId, tenantKey, conn, capability, correlationId, status: fatal ? "FAILED" : problems ? "PARTIAL" : "OK", metadata: { ...counts, complete, truncated, unidentified, ownershipAllowsImport: gate.ok, ...(fatal ? { error: fatal.code } : {}) } });
  return {
    connectionId: conn.id, capability, scopeKey: resolved.scopeKey, ranAt: new Date(), correlationId,
    ownership: gate.ok ? { allowsImport: true, ownership: gate.ownership, implied: gate.implied } : { allowsImport: false, code: gate.code, message: gate.message },
    complete, truncated, unidentifiedRecords: unidentified, counts, items,
    ...(fatal ? { error: { code: fatal.code, message: String(fatal.message).slice(0, 300) } } : {}),
    note: "Read-only comparison. No DMS record, stock movement or accounting entry was created or changed.",
  };
}

/** Last stored outcome per linked record (tenant-scoped, paged). MISSING_IN_DMS rows without a link are not stored — they exist only in the run result / audit counts. */
async function list(db, tenantKey, q = {}) {
  const where = { tenant_key: tenantKey, reconcile_status: { [db.Sequelize.Op.ne]: null } };
  const connectionId = V.posInt(q.connectionId, "connectionId"); if (connectionId) where.connection_id = connectionId;
  const capability = V.oneOf(q.capability, RECONCILABLE_CAPABILITIES, "capability");
  where.entity_type = capability ? getTarget(capability).entityType : Object.values(TARGETS).map((t) => t.entityType);
  const status = V.oneOf(q.status, STATUSES, "status"); if (status) where.reconcile_status = status;
  const { page, pageSize, offset } = V.paging(q, { defaultSize: 25, maxSize: 100 });
  const { rows, count } = await db.ErpExternalLink.findAndCountAll({ where, order: [["reconciled_at", "DESC"], ["id", "DESC"]], limit: pageSize, offset });
  const by = await db.ErpExternalLink.findAll({ where: { ...where, reconcile_status: { [db.Sequelize.Op.ne]: null } }, attributes: ["reconcile_status", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "n"]], group: ["reconcile_status"], raw: true });
  const capOf = Object.fromEntries(Object.values(TARGETS).map((t) => [t.entityType, t.capability]));
  const parse = (s) => { try { return JSON.parse(s); } catch { return { detail: s }; } };
  return {
    items: rows.map((l) => ({ id: l.id, connectionId: l.connection_id, capability: capOf[l.entity_type] || null, entityType: l.entity_type, externalId: l.external_id, dmsEntityId: l.dms_entity_id, origin: l.origin || null, status: l.reconcile_status, reconciledAt: l.reconciled_at, ...parse(l.reconcile_detail) })),
    page, pageSize, total: count, byStatus: Object.fromEntries(by.map((r) => [r.reconcile_status, Number(r.n)])), statuses: STATUSES, reconcilableCapabilities: RECONCILABLE_CAPABILITIES,
  };
}

module.exports = { run, list, STATUSES, LIMITS, RECONCILABLE_CAPABILITIES, reconcilable };
