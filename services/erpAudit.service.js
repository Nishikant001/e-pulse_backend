// services/erpAudit.service.js — Phase 16. Persistent, append-only ERP audit trail.
//   record()      write one event (never throws, never blocks the business flow, in-order per process)
//   fromLogLine() adapter for the Phase 13–15 `audit()` calls: same event names, key=value extras become safe metadata
//   list()        tenant-scoped, filtered, paged read. There is NO update / delete function — append-only by construction.
// Credentials never enter: metadata keys that look secret are dropped, values are truncated, depth is limited.
const { Op } = require("sequelize");
const { isSecretKey, redactDeep, redactString } = require("./erp/redaction");
const reqctx = require("../utils/requestContext");
const V = require("../utils/erpValidate");
const { CAPABILITY_VALUES } = require("./erp/erpConstants");

const EVENTS = [
  "ERP_CONNECTION_CREATED", "ERP_CONNECTION_UPDATED", "ERP_ACTIVATED", "ERP_DEACTIVATED", "ERP_DEFAULT_CHANGED", "ERP_CONNECTION_TESTED", "ERP_MAPPING_UPDATED",
  "ERP_OWNERSHIP_UPDATED", "ERP_CODE_MAPPING_UPDATED",
  "ERP_SYNC_CREATED", "ERP_SYNC_STARTED", "ERP_SYNC_COMPLETED", "ERP_SYNC_PARTIAL", "ERP_SYNC_FAILED", "ERP_SYNC_RETRIED",
  "ERP_SCHEDULE_CREATED", "ERP_SCHEDULE_UPDATED", "ERP_SCHEDULE_DISABLED", "ERP_SCHEDULE_TRIGGERED", "ERP_SCHEDULE_SKIPPED",
  "ERP_OUTBOUND_STARTED", "ERP_OUTBOUND_COMPLETED", "ERP_OUTBOUND_FAILED", "ERP_OUTBOUND_BLOCKED",
  // Phase 17
  "ERP_ACCESS_DENIED", "ERP_RBAC_ROLE_CHANGED", "ERP_SECURITY_CONFIG_UPDATED", "ERP_SYNC_INTERRUPTED",
  // Phase 18
  "ERP_RECONCILIATION_RUN",
];
const STATUSES = ["OK", "FAILED", "PARTIAL", "INFO"];
// Phase 13 event names that Phase 16 renames to the documented ones.
const RENAMED = { ERP_CREATED: "ERP_CONNECTION_CREATED", ERP_UPDATED: "ERP_CONNECTION_UPDATED" };
const STATUS_OF = (ev) => (/_FAILED$|_BLOCKED$/.test(ev) ? "FAILED" : /_PARTIAL$/.test(ev) ? "PARTIAL" : /_(COMPLETED|CREATED|UPDATED|ACTIVATED)$/.test(ev) ? "OK" : "INFO");
const MAX_STR = 300;

function safeMetadata(input, depth = 0) {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") { const r = redactString(input, 0); return r.length > MAX_STR ? `${r.slice(0, MAX_STR)}…` : r; }
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => safeMetadata(v, depth + 1));
  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input).slice(0, 30)) if (!isSecretKey(k)) out[k] = safeMetadata(v, depth + 1);
    return out;
  }
  return null;
}

let chain = Promise.resolve();
const pending = new Set();
function enqueue(task) {
  const p = chain.then(task).catch(() => {}); // an audit write failure must never break (or log into) the business flow
  chain = p;
  pending.add(p); p.finally(() => pending.delete(p));
  return p;
}
const flush = () => Promise.all([...pending]);

function providerOf(conn) {
  try { const { resolveProviderKey } = require("./erp/providerRegistry"); return conn ? resolveProviderKey(conn) : null; } catch (_) { return null; }
}

/** Fire-and-forget. Resolves when written (or silently dropped). */
function record(db, e) {
  const conn = e.conn || null;
  const event = RENAMED[e.event] || e.event;
  const row = {
    tenant_key: String(e.tenantKey || "DEFAULT").slice(0, 40),
    actor_admin_id: e.adminId || null,
    event: String(event).slice(0, 40),
    connection_id: conn ? conn.id : e.connectionId || null,
    erp_code: conn ? String(conn.code || "").slice(0, 60) || null : null,
    provider: providerOf(conn),
    capability: e.capability || null,
    entity_type: e.entityType || null,
    entity_id: e.entityId !== undefined && e.entityId !== null ? String(e.entityId).slice(0, 190) : null,
    status: e.status || STATUS_OF(event),
    correlation_id: (e.correlationId || reqctx.currentCorrelationId()) ? String(e.correlationId || reqctx.currentCorrelationId()).slice(0, 40) : null,
    metadata: safeMetadata(e.metadata),
  };
  return enqueue(() => db.ErpAuditEvent.create(row));
}

// "job=5 capability=PRODUCT_MASTER status=SUCCESS cid=abc" → { job:"5", … }
function parseExtra(extra) {
  const out = {};
  for (const m of String(extra || "").matchAll(/([A-Za-z_]+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}
function fromLogLine(db, event, adminId, tenantKey, conn, extra) {
  const x = parseExtra(extra);
  const { capability, cid, job, status, ...rest } = x;
  return record(db, {
    event, adminId, tenantKey, conn, capability: capability || null, correlationId: cid || null,
    entityType: job ? "SYNC_JOB" : x.schedule ? "SCHEDULE" : conn ? "CONNECTION" : null, entityId: job || x.schedule || (conn ? conn.id : null),
    status: status === "SUCCESS" ? "OK" : status || undefined, metadata: { ...rest, ...(extra && !Object.keys(x).length ? { note: extra } : {}) },
  });
}

// ───────────────────────── read ─────────────────────────
const present = (r) => ({
  id: r.id, event: r.event, status: r.status, at: r.createdAt, actorAdminId: r.actor_admin_id,
  connectionId: r.connection_id, erpCode: r.erp_code, provider: r.provider, capability: r.capability,
  entityType: r.entity_type, entityId: r.entity_id, correlationId: r.correlation_id, metadata: redactDeep(r.metadata || {}),
});

/** Every filter is validated against an allow-list / format (400 VALIDATION_FAILED otherwise); paging is capped; no free-text SQL anywhere. */
async function list(db, tenantKey, q = {}) {
  const where = { tenant_key: tenantKey };
  const event = V.oneOf(q.event, EVENTS, "event", { upper: false }); if (event) where.event = event;
  const capability = V.oneOf(q.capability, CAPABILITY_VALUES, "capability"); if (capability) where.capability = capability;
  const status = V.oneOf(q.status, STATUSES, "status"); if (status) where.status = status;
  const connectionId = V.posInt(q.connectionId, "connectionId"); if (connectionId) where.connection_id = connectionId;
  const erp = V.text(q.erp, "erp", { max: 60 }); if (erp) where.erp_code = erp;
  const actorId = V.posInt(q.actorId, "actorId"); if (actorId) where.actor_admin_id = actorId;
  const correlationId = V.text(q.correlationId, "correlationId", { max: 40 }); if (correlationId) where.correlation_id = correlationId;
  const from = V.day(q.from, "from", false); const to = V.day(q.to, "to", true);
  if (from && to && from > to) throw V.bad("from must not be after to", "from");
  if (from || to) where.createdAt = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  const { page, pageSize, offset } = V.paging(q, { defaultSize: 25, maxSize: 100 });
  // createdAt first so the (tenant_key, createdAt) index serves both the date filter and the ordering; id breaks ties.
  const { rows, count } = await db.ErpAuditEvent.findAndCountAll({ where, order: [["createdAt", "DESC"], ["id", "DESC"]], limit: pageSize, offset });
  return { items: rows.map(present), page, pageSize, total: count, events: EVENTS };
}

module.exports = { EVENTS, STATUSES, record, fromLogLine, list, flush, safeMetadata, parseExtra };
