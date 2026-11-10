// services/erpBusiness.service.js — Phase 18. BUSINESS-CAPABILITY OVERVIEW for the monitoring / capability screens. Vendor-neutral and READ-ONLY: it never calls an ERP and
// never changes a row. Every number is computed from real rows of ONE tenant; with no data the answer is zero / null (never a made-up figure).
//
// Per connection × capability it answers, from the stored configuration and history:
//   state          READY | WARNING | BLOCKED | RUNNING | SUCCESS | PARTIAL | FAILED
//   blockers       what stops a sync RIGHT NOW (ownership, provider, endpoint, mapping, unsupported capability, outbound attestation)
//   verification   NOT_CONFIGURED < CONFIGURED < MOCK_VERIFIED < CONNECTION_TESTED < READ_VERIFIED < WRITE_VERIFIED < PRODUCTION_VERIFIED
// "Production ready" is never inferred from configuration. PRODUCTION_VERIFIED is never set automatically (it needs a documented sign-off that does not exist in
// the system); MOCK_VERIFIED means "the provider is covered by tests that use a mock transport" — NOT that any real ERP was reached.
const { Op, fn, col } = require("sequelize");
const C = require("./erp/erpConstants");
const registry = require("./erp/providerRegistry");
const { getTarget, getUnsupported, TARGETS } = require("./erp/sync/targets");
const ownershipSvc = require("./erpOwnership.service");
const outbound = require("./erpOutbound.service");
const recon = require("./erpReconciliation.service");
const docs = require("./erpDocumentStore.service");
const decisionRegister = require("./erpDecisionRegister.service");
const mappingPreflight = require("./erp/sync/mappingPreflight");

const DAY = 86400000;
const LEVELS = ["NOT_CONFIGURED", "CONFIGURED", "MOCK_VERIFIED", "CONNECTION_TESTED", "READ_VERIFIED", "WRITE_VERIFIED", "PRODUCTION_VERIFIED"];
const LEVEL_TEXT = {
  NOT_CONFIGURED: "Not configured", CONFIGURED: "Configured (nothing has been run)", MOCK_VERIFIED: "Mock verified (covered by tests that use a mock transport; no real ERP reached)",
  CONNECTION_TESTED: "Connection tested against the ERP", READ_VERIFIED: "Read verified (a sync read records from the ERP)", WRITE_VERIFIED: "Write verified (the ERP accepted a DMS → ERP write)",
  PRODUCTION_VERIFIED: "Production verified (explicit sign-off)",
};

// The code-level truth about each business capability (what this DMS can do TODAY). Consistency with the registry/targets is asserted by tests.
const CATALOG = {
  PRODUCT_MASTER: { classification: "COMPLETE", summary: "ERP → DMS product import with change handling, HSN code mapping and reconciliation. Outbound is not applicable (the ERP owns products).", decisionsRequired: [] },
  CUSTOMER_MASTER: { classification: "COMPLETE", summary: "ERP → DMS customer (retailer) import and DMS → ERP create/update, with external ids, duplicate and echo prevention, and reconciliation.", decisionsRequired: [] },
  DISTRIBUTOR_MASTER: { classification: "COMPLETE", summary: "ERP → DMS distributor import. Credit limit, terms, status and login stay DMS-controlled.", decisionsRequired: [] },
  PRICING: { classification: "COMPLETE", summary: "ERP → DMS price import. Only price rows the sync created are ever updated; manual prices are never overwritten.", decisionsRequired: ["Price ownership for rows configured by hand (today: the sync refuses to overwrite them)."] },
  STOCK: { classification: "PARTIAL", summary: "ERP on-hand snapshots become DMS ledger adjustments (delta only, through inventory.postAdjustment). A first snapshot over existing DMS stock is refused. Batches are never created. No outbound.", decisionsRequired: ["Stock ownership (ERP, DMS or shared).", "Baseline rule when the DMS already holds stock for a batch the ERP also reports.", "ERP plant / storage location → DMS warehouse mappings.", "Whether DMS-created batches may be created from ERP data (expiry / MRP)."] },
  SALES: { classification: "PARTIAL", summary: "ERP order → DMS DRAFT order (DMS pricing, schemes and GST), duplicate-proof by external id; changes apply only while DRAFT; an ERP cancellation cancels a DRAFT only. No outbound, no automatic confirmation.", decisionsRequired: ["Sales order ownership (ERP, DMS or shared).", "Whether an ERP order may ever be confirmed automatically (today: never).", "How a DMS order is represented as an ERP order (line items) for DMS → ERP."] },
  INVOICE: { classification: "BLOCKED", summary: "Not synchronised. DMS invoices come from deliveries and post accounting and receivables; importing an ERP invoice would duplicate or bypass that. Only the external-id columns exist.", decisionsRequired: [] },
  RETURN: { classification: "BLOCKED", summary: "Not synchronised. A return must reference a delivered DMS invoice and drives stock re-entry and credit notes; invoice and delivery synchronisation do not exist.", decisionsRequired: [] },
  PAYMENT: { classification: "COMPLETE", summary: "ERP → DMS payments (posted through the Accounts service, unallocated, immutable) and DMS → ERP with idempotency, code-mapped payment modes and echo prevention.", decisionsRequired: ["Whether ERP payments are auto-allocated to invoices (today: booked unallocated)."] },
  DOCUMENT: { classification: "BLOCKED", summary: "Not synchronised. Only the secure-store abstraction and its readiness check exist; no store, scanner, document record or access control is approved.", decisionsRequired: [] },
};
const DEPENDS_ON = { PRICING: ["PRODUCT_MASTER"], STOCK: ["PRODUCT_MASTER"], SALES: ["PRODUCT_MASTER", "CUSTOMER_MASTER"], PAYMENT: ["CUSTOMER_MASTER"], INVOICE: ["SALES", "CUSTOMER_MASTER"], RETURN: ["INVOICE"], DOCUMENT: [] };

// The ten questions the business must answer before invoices can be synchronised. DECIDED comes ONLY from stored configuration; there is no configuration for the
// rest, so they stay REQUIRED (nothing is assumed). READY = a technical foundation exists, not a business decision.
function invoiceDecisions(cap) {
  const own = cap && cap.ownership ? cap.ownership : null;
  const dec = (id, question, status, answer) => ({ id, question, status, answer: answer || null });
  return [
    dec("owner", "Who owns invoices?", own ? "DECIDED" : "REQUIRED", own),
    dec("erpAuthoritative", "Is the ERP invoice authoritative?", own ? "DECIDED" : "REQUIRED", own ? own === "ERP_OWNED" : null),
    dec("dmsAuthoritative", "Is the DMS invoice authoritative?", own ? "DECIDED" : "REQUIRED", own ? own === "DMS_OWNED" : null),
    dec("bidirectional", "Is invoicing bidirectional?", cap && cap.direction ? "DECIDED" : "REQUIRED", cap ? cap.direction : null),
    dec("externalId", "What is the stable ERP invoice external id?", "READY", "Columns SalesInvoiceHeaders.external_source_type / external_source_id (UNIQUE per distributor) exist; the ERP field that fills them is not chosen."),
    dec("deliveryMapping", "How does an ERP invoice map to a DMS delivery?", "REQUIRED", "A DMS invoice belongs to exactly one delivery (UNIQUE). No rule exists."),
    dec("accounting", "How must Phase 12 accounting behave for an imported invoice?", "REQUIRED", "Posting is part of the DMS invoice flow; importing must either skip it (ERP books) or run it once. Not decided."),
    dec("receivables", "How must receivables / outstanding behave?", "REQUIRED", "Outstanding is derived from DMS invoices, credit notes and payment allocations. Not decided."),
    dec("duplicates", "How are duplicate invoices prevented?", "READY", "UNIQUE (distributor, external source type, external id) and one invoice per delivery."),
    dec("existingInvoice", "What happens if the ERP invoice already exists in the DMS?", "REQUIRED", "No rule exists."),
  ];
}

const labelOf = (v) => (C.CAPABILITIES.find((c) => c.value === v) || {}).label || v;
const plain = (r) => (r && r.get ? r.get({ plain: true }) : r);
const stateRank = { BLOCKED: 0, RUNNING: 1, FAILED: 2, PARTIAL: 3, WARNING: 4, SUCCESS: 5, READY: 6 };

/** Catalog of what the DMS can do per capability + the provider list. No tenant data. */
function catalog() {
  return C.CAPABILITIES.map((c) => {
    const base = CATALOG[c.value]; const target = getTarget(c.value); const u = getUnsupported(c.value);
    const inbound = target ? "IMPLEMENTED" : "NOT_IMPLEMENTED";
    const out = outbound.OUTBOUND_CAPABILITIES.includes(c.value) ? "IMPLEMENTED" : "NOT_IMPLEMENTED";
    return {
      capability: c.value, label: c.label, classification: base.classification, summary: base.summary, inbound, outbound: out,
      dependsOn: DEPENDS_ON[c.value] || [], ownershipRequired: C.OWNERSHIP_REQUIRED.includes(c.value),
      identity: target ? target.identity || null : "Not defined (no sync).", changePolicy: target ? target.changePolicy || null : null,
      reconcilable: recon.RECONCILABLE_CAPABILITIES.includes(c.value),
      blockedBecause: u ? { code: u.code, reason: u.reason } : out === "NOT_IMPLEMENTED" && C.CAPABILITIES ? (outbound.OUTBOUND_BLOCKERS[c.value] ? { code: "OUTBOUND_SYNC_BLOCKED", reason: outbound.OUTBOUND_BLOCKERS[c.value] } : null) : null,
      decisionsRequired: [...base.decisionsRequired, ...(c.value === "INVOICE" ? invoiceDecisions(null).filter((d) => d.status === "REQUIRED").map((d) => d.question) : [])],
      ...(c.value === "RETURN" ? { requiredDecisions: ["Return ownership.", "Invoice and delivery synchronisation (or an agreed alternative) so a return can reference its original invoice, delivery, batch and quantity.", "Credit-note and stock re-entry rule for an imported return."] } : {}),
    };
  });
}

function providerList() {
  return registry.listProviders().map((p) => ({ ...p, classification: p.status === "IMPLEMENTED" ? "COMPLETE" : p.status === "FOUNDATION_ONLY" ? "UNSUPPORTED" : "UNSUPPORTED", note: p.status === "IMPLEMENTED" ? (p.verification.real ? "Verified against a real ERP." : "Mock verified only; a real ERP connection has not been verified.") : "No adapter exists. This provider cannot connect to anything." }));
}

async function overview(db, tenantKey, { now = new Date() } = {}) {
  const conns = await db.ErpConnection.findAll({ where: { tenant_key: tenantKey }, include: [{ model: db.ErpConnectionCapability, as: "capabilities", required: false }], order: [["id", "ASC"]], limit: 200 });
  const ids = conns.map((c) => c.id);
  const none = !ids.length;
  const [mapRows, jobs, bdrRows, obRows, linkRows, readRows] = none ? [[], [], [], [], [], []] : await Promise.all([
    db.ErpEntityMapping.findAll({ where: { connection_id: ids }, attributes: ["connection_id", "capability", "dms_field", "source_field", "is_key"], raw: true }),
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, connection_id: ids }, order: [["id", "DESC"]], limit: 4000, raw: true }),
    db.ErpSyncError.findAll({ where: { tenant_key: tenantKey, error_code: "BUSINESS_DECISION_REQUIRED" }, attributes: ["job_id", [fn("COUNT", col("id")), "n"]], group: ["job_id"], raw: true }),
    db.ErpOutboundEvent.findAll({ where: { tenant_key: tenantKey, connection_id: ids }, attributes: ["connection_id", "capability", "status", [fn("COUNT", col("id")), "n"]], group: ["connection_id", "capability", "status"], raw: true }),
    db.ErpExternalLink.findAll({ where: { tenant_key: tenantKey, connection_id: ids }, attributes: ["connection_id", "entity_type", "reconcile_status", [fn("COUNT", col("id")), "n"]], group: ["connection_id", "entity_type", "reconcile_status"], raw: true }),
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, connection_id: ids, status: ["SUCCESS", "PARTIAL"], [Op.or]: [{ success_count: { [Op.gt]: 0 } }, { skipped_count: { [Op.gt]: 0 } }] }, attributes: ["connection_id", "capability", [fn("COUNT", col("id")), "n"]], group: ["connection_id", "capability"], raw: true }),
  ]);
  const mapBy = new Map(); for (const m of mapRows) { const k = `${m.connection_id}:${m.capability}`; if (!mapBy.has(k)) mapBy.set(k, []); mapBy.get(k).push(m); }
  const jobBy = new Map(); for (const j of jobs) { const k = `${j.connection_id}:${j.capability}`; if (!jobBy.has(k)) jobBy.set(k, []); jobBy.get(k).push(j); }
  const bdrBy = new Map(bdrRows.map((r) => [r.job_id, Number(r.n)]));
  const readOk = new Set(readRows.map((r) => `${r.connection_id}:${r.capability}`));
  const ob = (cid, cap) => { const o = { sent: 0, failed: 0, blocked: 0, pending: 0 }; for (const r of obRows) if (r.connection_id === cid && r.capability === cap) o[({ SENT: "sent", FAILED: "failed", BLOCKED: "blocked", PENDING: "pending" })[r.status]] += Number(r.n); return o; };
  const linkCount = (cid, type) => linkRows.filter((r) => r.connection_id === cid && r.entity_type === type).reduce((t, r) => t + Number(r.n), 0);
  const recBy = (cid, entityType) => { const o = Object.fromEntries(recon.STATUSES.map((s) => [s, 0])); for (const r of linkRows) if (r.connection_id === cid && r.entity_type === entityType && r.reconcile_status) o[r.reconcile_status] += Number(r.n); return o; };

  const perConnection = [];
  for (const c of conns) {
    const conn = plain(c);
    const key = registry.resolveProviderKey(conn); const desc = key ? registry.getDescriptor(key) : null;
    const pub = desc ? registry.publicDescriptor(desc) : null;
    const caps = [];
    for (const cap of (conn.capabilities || [])) {
      const capability = cap.capability; const target = getTarget(capability); const u = getUnsupported(capability);
      const k = `${conn.id}:${capability}`; const maps = mapBy.get(k) || []; const myJobs = jobBy.get(k) || [];
      const blockers = []; const warnings = [];
      const block = (code, message) => blockers.push({ code, message });
      const dir = cap.direction; const wantsIn = ["ERP_TO_DMS", "BIDIRECTIONAL"].includes(dir); const wantsOut = ["DMS_TO_ERP", "BIDIRECTIONAL"].includes(dir);
      const enabled = Boolean(cap.enabled) && dir !== "DISABLED";
      const decisions = capability === "INVOICE" ? invoiceDecisions(cap) : undefined;
      if (!enabled) warnings.push({ code: "CAPABILITY_NOT_SUPPORTED", message: "This capability is switched off for this connection." });
      else {
        if (conn.status === "INACTIVE") block("INVALID_CONFIGURATION", "The ERP connection is inactive.");
        if (!target) block(u ? u.code : "CAPABILITY_NOT_SUPPORTED", u ? u.reason : "There is no DMS target for this capability.");
        if (wantsIn || !wantsOut) { const own = ownershipSvc.evaluate(cap, capability, "inbound"); if (!own.ok && target) block(own.code, own.message); }
        if (wantsOut) {
          const own = ownershipSvc.evaluate(cap, capability, "outbound"); if (!own.ok) block(own.code, own.message);
          if (!outbound.OUTBOUND_CAPABILITIES.includes(capability)) block("OUTBOUND_SYNC_BLOCKED", outbound.OUTBOUND_BLOCKERS[capability] || "Sending this capability to an ERP is not available.");
          else if (!((cap.config || {}).outbound || {}).idempotencySupported) block("OUTBOUND_SYNC_BLOCKED", "Outbound is blocked until the capability setting outbound.idempotencySupported confirms the ERP honours idempotency keys.");
        }
        if (!desc || desc.status !== "IMPLEMENTED") block("PROVIDER_NOT_SUPPORTED", desc ? `The ${desc.label} provider is not implemented.` : "No provider is selected.");
        else {
          if (wantsIn && !registry.hasFeature(desc, "READ")) block("PROVIDER_NOT_SUPPORTED", `${desc.label} cannot read data.`);
          if (wantsOut && !(registry.hasFeature(desc, "CREATE") && registry.hasFeature(desc, "IDEMPOTENCY"))) block("OUTBOUND_SYNC_BLOCKED", `${desc.label} cannot write with idempotency keys.`);
        }
        if (!cap.endpoint_path) block("INVALID_CONFIGURATION", "No endpoint is configured.");
        if (target && wantsIn) {
          // Phase 19: the SAME evaluator the sync preflight uses (field-level reasons). Scope-dependent rules (default payment mode / terms) need a run scope, which the dashboard
          // does not have, so they are skipped here and enforced when a sync starts.
          const pre = mappingPreflight.evaluate({ capability, target, mappings: maps, scopeKnown: false });
          for (const b of pre.blockers) block(b.code, b.field && b.field !== "external_id" ? `${b.message} [${b.field}]` : b.message);
          const need = (types, text) => { if (!types.some((t) => linkCount(conn.id, t) > 0)) warnings.push({ code: "PREREQUISITE_MISSING", message: text }); };
          if (["PRICING", "STOCK", "SALES"].includes(capability)) need(["PRODUCT"], "No product has been synchronised yet; run the Product master sync first.");
          if (["SALES", "PAYMENT"].includes(capability)) need(["CUSTOMER"], "No customer has been synchronised yet; run the Customer master sync first.");
          if (capability === "STOCK" && linkCount(conn.id, "CODE_WAREHOUSE") === 0) warnings.push({ code: "MAPPING_MISSING", message: "No plant → warehouse code mapping exists; every stock record will wait for one." });
          if (capability === "PAYMENT" && linkCount(conn.id, "CODE_PAYMENT_MODE") === 0) warnings.push({ code: "MAPPING_MISSING", message: "No payment-mode code mapping exists; ERP modes that are not DMS mode names will wait for one." });
        }
        if (capability === "INVOICE" || capability === "RETURN") warnings.push({ code: "BUSINESS_DECISION_REQUIRED", message: capability === "INVOICE" ? "Invoice synchronisation is blocked: the business has not approved the ownership, accounting and delivery rules." : "Return synchronisation is blocked: it depends on invoice and delivery synchronisation." });
      }
      // history
      const active = myJobs.find((j) => ["QUEUED", "RUNNING"].includes(j.status));
      const done = myJobs.filter((j) => ["SUCCESS", "PARTIAL", "FAILED"].includes(j.status));
      const last = done[0] || null; const lastOk = done.find((j) => j.status === "SUCCESS" || j.status === "PARTIAL") || null; const lastFail = done.find((j) => j.status === "FAILED" || j.status === "PARTIAL") || null;
      const pendingFromJob = last ? (bdrBy.get(last.id) || 0) : 0;
      const pendingDecisions = blockers.filter((b) => b.code === "BUSINESS_DECISION_REQUIRED").length + pendingFromJob;
      let state;
      if (blockers.length) state = "BLOCKED";
      else if (active) state = "RUNNING";
      else if (last) state = last.status === "SUCCESS" && warnings.length ? "WARNING" : last.status;
      else state = warnings.length ? "WARNING" : "READY";
      if (!enabled) state = "BLOCKED";
      // verification (honest ladder)
      const obc = ob(conn.id, capability);
      const configured = enabled && !blockers.some((b) => ["INVALID_CONFIGURATION", "MAPPING_NOT_CONFIGURED", "PROVIDER_NOT_SUPPORTED", "CAPABILITY_NOT_SUPPORTED"].includes(b.code)) && Boolean(target || outbound.OUTBOUND_CAPABILITIES.includes(capability));
      const tested = Boolean(conn.last_test_at && conn.last_test_ok);
      let level = "NOT_CONFIGURED";
      if (configured) level = "CONFIGURED";
      if (configured && pub && pub.verification.mock) level = "MOCK_VERIFIED";
      if (configured && tested) level = "CONNECTION_TESTED";
      if (configured && readOk.has(k)) level = "READ_VERIFIED";
      if (configured && obc.sent > 0) level = "WRITE_VERIFIED";
      const notes = [];
      if (pub && pub.verification.mock && !pub.verification.real) notes.push(`${pub.label}: mock verified; a real ERP connection has not been verified.`);
      if (!tested && configured) notes.push("The connection has not passed a real connection test.");
      notes.push("PRODUCTION_VERIFIED is never set automatically; it needs an explicit sign-off that this system does not record.");
      const ent = target ? target.entityType : null;
      caps.push({
        capability, label: labelOf(capability), enabled, direction: dir, ownership: cap.ownership || null, ownershipRequired: C.OWNERSHIP_REQUIRED.includes(capability),
        classification: CATALOG[capability] ? CATALOG[capability].classification : "UNSUPPORTED", state, blockers, warnings, ...(decisions ? { decisions } : {}),
        mapping: { total: maps.length, keyMapped: maps.some((m) => m.is_key), requiredFields: target ? target.requiredFields : [] },
        verification: { level, label: LEVEL_TEXT[level], realErpVerified: LEVELS.indexOf(level) >= LEVELS.indexOf("CONNECTION_TESTED"), notes },
        lastSync: last ? { jobId: last.id, status: last.status, at: last.completed_at || last.createdAt } : null,
        lastSuccess: lastOk ? { jobId: lastOk.id, at: lastOk.completed_at } : null,
        lastFailure: lastFail ? { jobId: lastFail.id, status: lastFail.status, at: lastFail.completed_at, errorCode: lastFail.error_code || null } : null,
        lastCounts: last ? { processed: last.processed_count, created: last.created_count, updated: last.updated_count, skipped: last.skipped_count, failed: last.failed_count } : null,
        pendingDecisions, outbound: wantsOut ? obc : null,
        reconciliation: ent && recon.RECONCILABLE_CAPABILITIES.includes(capability) ? recBy(conn.id, ent) : null,
      });
    }
    caps.sort((a, b) => C.CAPABILITY_VALUES.indexOf(a.capability) - C.CAPABILITY_VALUES.indexOf(b.capability));
    perConnection.push({ id: conn.id, name: conn.name, code: conn.code, status: conn.status, environment: conn.environment, provider: pub, capabilities: caps });
  }

  // tenant-wide monitoring per capability (all ten, even when nothing is configured: "NOT_CONFIGURED", never a made-up healthy status)
  const monitoring = C.CAPABILITIES.map((c) => {
    const rows = perConnection.flatMap((p) => p.capabilities.filter((x) => x.capability === c.value && x.enabled).map((x) => ({ p, x })));
    const worst = rows.reduce((w, r) => (w === null || stateRank[r.x.state] < stateRank[w.state] ? r.x : w), null);
    const sum = (f) => rows.reduce((t, r) => t + (f(r.x) || 0), 0);
    const latest = (f) => rows.map((r) => f(r.x)).filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
    const rec = Object.fromEntries(recon.STATUSES.map((s) => [s, sum((x) => (x.reconciliation ? x.reconciliation[s] : 0))]));
    return {
      capability: c.value, label: c.label, classification: CATALOG[c.value].classification, connections: rows.length,
      status: worst ? worst.state : "NOT_CONFIGURED",
      lastSuccess: latest((x) => x.lastSuccess), lastFailure: latest((x) => x.lastFailure),
      recordsProcessed: sum((x) => (x.lastCounts ? x.lastCounts.processed : 0)), recordsFailed: sum((x) => (x.lastCounts ? x.lastCounts.failed : 0)),
      pendingDecisions: sum((x) => x.pendingDecisions), reconciliationMismatches: rec.MISMATCH + rec.PENDING_REVIEW + rec.BLOCKED + rec.MISSING_IN_ERP + rec.MISSING_IN_DMS, reconciliation: rec,
      highestVerification: rows.reduce((h, r) => (LEVELS.indexOf(r.x.verification.level) > LEVELS.indexOf(h) ? r.x.verification.level : h), "NOT_CONFIGURED"),
    };
  });

  // Phase 19: the business decision register. Only ownership / direction can be CONFIGURED (never "approved"); every other question is REQUIRED.
  const capRowsBy = {}; for (const c of conns) for (const cp of (c.capabilities || [])) { const r = { ...plain(cp), connectionName: c.name }; (capRowsBy[r.capability] = capRowsBy[r.capability] || []).push(r); }
  const register = decisionRegister.build(capRowsBy);
  return { catalog: catalog(), providers: providerList(), monitoring, connections: perConnection, decisionRegister: { items: register, summary: decisionRegister.summary(register), meta: decisionRegister.META }, documentStore: docs.readiness(), verificationLevels: LEVELS.map((l) => ({ level: l, label: LEVEL_TEXT[l] })), asOf: now };
}

module.exports = { overview, catalog, providerList, invoiceDecisions, CATALOG, LEVELS };
