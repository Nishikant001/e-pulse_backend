// services/erpSync.service.js — Phase 14 ERP Sync Management: start / retry / history / summary / mappings.
// Vendor-neutral. Works on (tenant, connection, capability); the actual run is services/erp/sync/syncEngine.js.
// Every function takes `tenantKey` (derived server-side from the Admin session) and filters on it: a foreign connection, job,
// error list or mapping is a 404 and no ERP is ever contacted on behalf of another tenant.
const crypto = require("crypto");
const C = require("./erp/erpConstants");
const { ErpApiError } = require("./erp/erpApiError");
const { resolveProviderKey, getDescriptor, hasFeature } = require("./erp/providerRegistry");
const mappingPreflight = require("./erp/sync/mappingPreflight");
const { getTarget, getUnsupported } = require("./erp/sync/targets");
const { RETRYABLE } = require("./erp/erpErrors");
const { runSync } = require("./erp/sync/syncEngine");
const { parseTransformList } = require("./erp/sync/transforms");
const { validatePath } = require("./erp/providerConfig");
const { ErpIntegrationError } = require("./erp/erpErrors");
const { audit } = require("./erpIntegration.service");
const ownership = require("./erpOwnership.service");
const inflight = require("./erpInflight");
const reqctx = require("../utils/requestContext");
const V = require("../utils/erpValidate");
const { scheduler: schedulerCfg } = require("./erp/runtimeConfig");

const staleMs = () => schedulerCfg().staleMs; // a RUNNING job with no heartbeat this long is treated as crashed (clamped 2–240 min)
const MAX_ATTEMPTS = 3;
const ACTIVE_STATUSES = ["QUEUED", "RUNNING"]; // eslint-disable-line no-unused-vars
const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const plain = (r) => (r ? r.get({ plain: true }) : null);
const labelOf = (capability) => (C.CAPABILITIES.find((c) => c.value === capability) || {}).label || capability;

async function loadConnection(db, tenantKey, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.ErpConnection.findOne({ where: { id: n, tenant_key: tenantKey } });
}

// Fails fast (no job, no ERP call) with the neutral error code when the sync cannot possibly run.
async function preflight(db, conn, capability, scope) {
  if (!C.CAPABILITY_VALUES.includes(capability)) throw err(400, "VALIDATION_FAILED", "Unknown capability", { field: "capability" });
  if (conn.status === "INACTIVE") throw err(409, "INVALID_CONFIGURATION", "The ERP connection is inactive. Activate it first.");
  const cap = await db.ErpConnectionCapability.findOne({ where: { connection_id: conn.id, capability } });
  if (!cap || !cap.enabled) throw err(409, "CAPABILITY_NOT_SUPPORTED", "This capability is not enabled for this ERP connection.");
  const target = getTarget(capability);
  if (!target) {
    const u = getUnsupported(capability);
    throw err(409, u ? u.code : "CAPABILITY_NOT_SUPPORTED", `${labelOf(capability)} cannot be synchronised. ${u ? u.reason : "There is no DMS target for it."}`);
  }
  const own = ownership.evaluate(cap, capability, "inbound"); // Phase 16: direction + ownership decide; unknown ownership is never guessed
  if (!own.ok) throw err(409, own.code, own.message);
  const key = resolveProviderKey(conn);
  const desc = key ? getDescriptor(key) : null;
  if (!desc || desc.status !== "IMPLEMENTED") throw err(409, "PROVIDER_NOT_SUPPORTED", desc ? `The ${desc.label} provider is not implemented yet.` : "No provider is selected for this ERP connection.");
  if (!cap.endpoint_path) throw err(409, "INVALID_CONFIGURATION", "No endpoint is configured for this capability.");
  const maps = await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability } });
  if (!maps.length || !maps.some((m) => m.is_key)) throw err(409, "MAPPING_NOT_CONFIGURED", "No field mapping (with a key field) is configured for this ERP and capability.");
  let resolved;
  try { resolved = await target.resolveScope(db, scope || {}); } catch (e) {
    if (e instanceof ErpIntegrationError) throw err(400, e.code === "INVALID_CONFIGURATION" ? "VALIDATION_FAILED" : e.code, e.message, { field: "scope" });
    throw e;
  }
  // Phase 19: capability-specific mapping preflight (required target fields, empty source paths, stale fields, payment-mode / payment-terms source) plus the provider's
  // READ feature. The key check above keeps its Phase 14 precedence and wording; everything new runs AFTER the scope is valid. Data-dependent prerequisites are
  // warnings and never block.
  if (!hasFeature(desc, "READ")) throw err(409, "PROVIDER_NOT_SUPPORTED", `The ${desc.label} provider cannot read data.`);
  const check = await mappingPreflight.check(db, conn, capability, target, resolved);
  if (!check.ok) {
    const first = check.blockers.slice(0, 3).map((b) => b.message).join(" ");
    throw err(409, "MAPPING_NOT_CONFIGURED", `The mapping is not ready: ${first}${check.blockers.length > 3 ? ` (+${check.blockers.length - 3} more)` : ""}`, { blockers: check.blockers, warnings: check.warnings });
  }
  return { cap, desc, resolved, warnings: check.warnings };
}

// Maps a finished job to its audit event (events go to the server log, like every other ERP audit line — no persistent audit store exists yet).
function auditJobResult(adminId, tenantKey, conn, job) {
  const ev = !job ? "ERP_SYNC_FAILED" : job.status === "SUCCESS" ? "ERP_SYNC_COMPLETED" : job.status === "PARTIAL" ? "ERP_SYNC_PARTIAL" : "ERP_SYNC_FAILED";
  audit(ev, adminId, tenantKey, conn, `job=${job && job.id} status=${job && job.status}${job && job.error_code ? ` error=${job.error_code}` : ""}`);
}

async function releaseStale(db, activeKey) {
  const stale = await db.ErpSyncJob.findOne({ where: { active_key: activeKey } });
  if (!stale) return;
  const last = stale.heartbeat_at || stale.createdAt;
  if (Date.now() - new Date(last).getTime() > staleMs()) {
    await stale.update({ status: "FAILED", active_key: null, completed_at: new Date(), error_code: "INTERNAL_ERROR", error_message: "The sync was interrupted (no activity). It was closed so a new one can start." });
  }
}

// Creates the job. The UNIQUE active_key makes "two simultaneous syncs of the same tenant+ERP+capability" impossible even under races.
async function createJob(db, tenantKey, adminId, conn, capability, resolved, { trigger = "MANUAL", retryOf = null, attempt = 1, correlationId = null } = {}) {
  const activeKey = `${tenantKey}:${conn.id}:${capability}`;
  await releaseStale(db, activeKey);
  try {
    const job = await db.ErpSyncJob.create({
      tenant_key: tenantKey, connection_id: conn.id, provider: resolveProviderKey(conn), erp_type: conn.erp_type, capability, direction: "ERP_TO_DMS",
      trigger_type: trigger, status: "QUEUED", correlation_id: correlationId || reqctx.currentCorrelationId() || crypto.randomUUID(), scope: resolved.scope, retry_of_job_id: retryOf, attempt,
      active_key: activeKey, heartbeat_at: new Date(), requested_by_admin_id: adminId || null,
    });
    audit("ERP_SYNC_CREATED", adminId, tenantKey, conn, `job=${job.id} capability=${capability} trigger=${trigger} cid=${job.correlation_id}`);
    return job;
  } catch (e) {
    if (e instanceof db.Sequelize.UniqueConstraintError) throw err(409, "SYNC_ALREADY_RUNNING", "A synchronisation of this ERP and capability is already running.");
    throw e;
  }
}

/**
 * Start a manual sync. Returns the QUEUED job immediately; the run continues in the background (in-process — there is no
 * queue/Redis in this project). `deps.await` runs it to completion first (used by tests and by callers that want the result).
 */
async function startSync(db, tenantKey, adminId, body = {}, deps = {}) {
  if (!body || typeof body !== "object") throw err(400, "VALIDATION_FAILED", "Request body must be an object");
  const conn = await loadConnection(db, tenantKey, body.connectionId);
  if (!conn) return null;
  const capability = String(body.capability || "").toUpperCase();
  const { resolved } = await preflight(db, conn, capability, body.scope);
  const job = await createJob(db, tenantKey, adminId, conn, capability, resolved, { correlationId: deps.correlationId });
  audit("ERP_SYNC_STARTED", adminId, tenantKey, conn, `job=${job.id} capability=${capability} trigger=MANUAL`);
  const finish = () => inflight.track(runSync(db, job.id, deps).then((j) => { auditJobResult(adminId, tenantKey, conn, j); return j; }), job.id);
  if (deps.await) await finish();
  else setImmediate(() => finish().catch((e) => console.error("erp sync crashed:", e && e.name)));
  return getJob(db, tenantKey, job.id);
}

// Retry a FAILED / PARTIAL job: a NEW job (trigger RETRY) with the same scope, bounded attempts. Idempotent — unchanged records are skipped.
async function retryJob(db, tenantKey, adminId, id, deps = {}) {
  const old = await findJob(db, tenantKey, id);
  if (!old) return null;
  if (!["FAILED", "PARTIAL"].includes(old.status)) throw err(409, "INVALID_STATE", "Only a failed or partial sync can be retried.");
  if (old.attempt >= MAX_ATTEMPTS) throw err(409, "LIMIT_EXCEEDED", `This sync has already been attempted ${MAX_ATTEMPTS} times. Fix the cause and start a new sync.`);
  const conn = await loadConnection(db, tenantKey, old.connection_id);
  if (!conn) throw err(409, "INVALID_CONFIGURATION", "The ERP connection no longer exists.");
  const { resolved } = await preflight(db, conn, old.capability, old.scope);
  const job = await createJob(db, tenantKey, adminId, conn, old.capability, resolved, { trigger: "RETRY", retryOf: old.id, attempt: old.attempt + 1, correlationId: deps.correlationId });
  audit("ERP_SYNC_RETRIED", adminId, tenantKey, conn, `job=${job.id} capability=${old.capability} of=${old.id} attempt=${job.attempt}`);
  audit("ERP_SYNC_STARTED", adminId, tenantKey, conn, `job=${job.id} capability=${old.capability} trigger=RETRY of=${old.id}`);
  const finish = () => inflight.track(runSync(db, job.id, deps).then((j) => { auditJobResult(adminId, tenantKey, conn, j); return j; }), job.id);
  if (deps.await) await finish(); else setImmediate(() => finish().catch((e) => console.error("erp sync crashed:", e && e.name)));
  return getJob(db, tenantKey, job.id);
}

// ───────────────────────── reads (tenant-scoped) ─────────────────────────
async function findJob(db, tenantKey, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.ErpSyncJob.findOne({ where: { id: n, tenant_key: tenantKey } });
}
function presentJob(j, conn, lastRetryAt = null) {
  const started = j.started_at ? new Date(j.started_at).getTime() : null;
  const ended = j.completed_at ? new Date(j.completed_at).getTime() : null;
  return {
    id: j.id,
    connection: conn ? { id: conn.id, name: conn.name, code: conn.code, erpType: conn.erp_type, erpTypeLabel: C.ERP_TYPE_LABELS[conn.erp_type] || conn.erp_type } : { id: j.connection_id },
    provider: { key: j.provider, label: (getDescriptor(j.provider) || {}).label || j.provider },
    capability: j.capability, capabilityLabel: labelOf(j.capability), direction: j.direction, trigger: j.trigger_type, status: j.status,
    correlationId: j.correlation_id, scope: j.scope || null, attempt: j.attempt, retryOfJobId: j.retry_of_job_id,
    startedAt: j.started_at, completedAt: j.completed_at, durationMs: started && ended ? ended - started : null,
    counts: { total: j.total_count, processed: j.processed_count, success: j.success_count, created: j.created_count, updated: j.updated_count, skipped: j.skipped_count, failed: j.failed_count },
    error: j.error_code ? { code: j.error_code, message: j.error_message } : null,
    canRetry: ["FAILED", "PARTIAL"].includes(j.status) && j.attempt < MAX_ATTEMPTS,
    // Phase 15 retry visibility: is the run-level failure transient, how many retries led here, when was this job last retried.
    retryable: j.error_code ? RETRYABLE.has(j.error_code) : false, retryCount: Math.max(0, (j.attempt || 1) - 1), maxAttempts: MAX_ATTEMPTS, lastRetryAt,
    createdAt: j.createdAt,
  };
}
async function connMap(db, tenantKey, ids) {
  const rows = ids.length ? await db.ErpConnection.findAll({ where: { tenant_key: tenantKey, id: [...new Set(ids)] } }) : [];
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}
// When was each job last retried = createdAt of the newest child job (retry_of_job_id = job).
async function retryTimes(db, tenantKey, ids) {
  if (!ids.length) return {};
  const kids = await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, retry_of_job_id: ids }, attributes: ["retry_of_job_id", "createdAt"], raw: true });
  const out = {};
  for (const k of kids) if (!out[k.retry_of_job_id] || new Date(k.createdAt) > new Date(out[k.retry_of_job_id])) out[k.retry_of_job_id] = k.createdAt;
  return out;
}
async function getJob(db, tenantKey, id) {
  const j = await findJob(db, tenantKey, id);
  if (!j) return null;
  return presentJob(j, (await connMap(db, tenantKey, [j.connection_id]))[j.connection_id], (await retryTimes(db, tenantKey, [j.id]))[j.id] || null);
}

async function listJobs(db, tenantKey, query = {}) {
  const where = { tenant_key: tenantKey };
  const connectionId = V.posInt(query.connectionId, "connectionId"); if (connectionId) where.connection_id = connectionId;
  const capability = V.oneOf(query.capability, C.CAPABILITY_VALUES, "capability"); if (capability) where.capability = capability;
  const status = V.oneOf(query.status, ["QUEUED", "RUNNING", "SUCCESS", "PARTIAL", "FAILED"], "status"); if (status) where.status = status;
  const trigger = V.oneOf(query.trigger, ["MANUAL", "SCHEDULED", "RETRY"], "trigger"); if (trigger) where.trigger_type = trigger;
  const { page, pageSize, offset } = V.paging(query, { defaultSize: 25, maxSize: 100 });
  const { rows, count } = await db.ErpSyncJob.findAndCountAll({ where, order: [["id", "DESC"]], limit: pageSize, offset });
  const cm = await connMap(db, tenantKey, rows.map((r) => r.connection_id));
  const rt = await retryTimes(db, tenantKey, rows.map((r) => r.id));
  return { items: rows.map((r) => presentJob(r, cm[r.connection_id], rt[r.id] || null)), total: count, page, pageSize };
}

async function listJobErrors(db, tenantKey, id, query = {}) {
  const j = await findJob(db, tenantKey, id);
  if (!j) return null;
  const { page, pageSize, offset } = V.paging(query, { defaultSize: 50, maxSize: 200 });
  const { rows, count } = await db.ErpSyncError.findAndCountAll({ where: { job_id: j.id, tenant_key: tenantKey }, order: [["record_index", "ASC"], ["id", "ASC"]], limit: pageSize, offset });
  return { items: rows.map((e) => ({ id: e.id, recordIndex: e.record_index, externalId: e.external_id, code: e.error_code, message: e.message, retryable: Boolean(e.retryable), scope: e.record_index === null ? "RUN" : "RECORD" })), total: count, page, pageSize };
}

// Dashboard numbers live in services/erpMonitoring.service.js (Phase 15). Kept here as a thin delegate for existing callers.
const getSummary = (db, tenantKey) => require("./erpMonitoring.service").getSummary(db, tenantKey);

// ───────────────────────── mappings (per connection + capability) ─────────────────────────
const toMapping = (m) => ({ id: m.id, sourceField: m.source_field, dmsField: m.dms_field, isKey: Boolean(m.is_key), transform: m.transform ? m.transform.split(",") : [] });

async function getMappings(db, tenantKey, connectionId, capability) {
  const conn = await loadConnection(db, tenantKey, connectionId);
  if (!conn) return null;
  const cap = String(capability || "").toUpperCase();
  if (!C.CAPABILITY_VALUES.includes(cap)) throw err(400, "VALIDATION_FAILED", "Unknown capability");
  const target = getTarget(cap);
  const rows = await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability: cap }, order: [["id", "ASC"]] });
  return { connectionId: conn.id, capability: cap, target: target ? { entityType: target.entityType, label: target.label, fields: target.fields, requiredFields: target.requiredFields, scopeFields: target.scopeFields, ownership: target.ownership } : null, mappings: rows.map(toMapping) };
}

// Replaces the whole mapping set (atomic). Exactly one key row; DMS fields limited to the target's writable whitelist; transforms from the allow-list.
async function saveMappings(db, tenantKey, adminId, connectionId, capability, body = {}) {
  const conn = await loadConnection(db, tenantKey, connectionId);
  if (!conn) return null;
  const cap = String(capability || "").toUpperCase();
  const target = getTarget(cap);
  if (!target) { const u = getUnsupported(cap); throw err(409, u ? u.code : "CAPABILITY_NOT_SUPPORTED", `${labelOf(cap)} has no DMS target, so it cannot be mapped.${u ? ` ${u.reason}` : ""}`); }
  const input = body && body.mappings;
  if (!Array.isArray(input) || input.length === 0 || input.length > 60) throw err(400, "VALIDATION_FAILED", "mappings must be a list of 1–60 entries", { field: "mappings" });
  const seenDms = new Set(); let keys = 0; const rows = [];
  for (const m of input) {
    if (!m || typeof m !== "object") throw err(400, "VALIDATION_FAILED", "Each mapping must be an object", { field: "mappings" });
    let sourceField;
    const rawSource = String(m.sourceField || "").trim();
    const lineSrc = /^(.+?)\[\]\.(.+)$/.exec(rawSource); // Phase 16 line syntax "Items.results[].Qty" (only for "lines.*" DMS fields)
    try { if (lineSrc) { validatePath(lineSrc[1], "sourceField"); validatePath(lineSrc[2], "sourceField"); sourceField = rawSource; } else sourceField = validatePath(rawSource, "sourceField"); } catch (e) { throw err(400, "VALIDATION_FAILED", e.message, { field: "sourceField" }); }
    if (lineSrc && !/^lines\.[a-z_]+$/.test(String(m.dmsField || ""))) throw err(400, "VALIDATION_FAILED", "A line source (…[].field) can only map to a lines.* field.", { field: "sourceField" });
    const isKey = m.isKey === true || m.dmsField === "external_id";
    const dmsField = isKey ? "external_id" : String(m.dmsField || "").trim();
    if (!isKey && !target.allowedFields.includes(dmsField)) throw err(400, "VALIDATION_FAILED", `"${dmsField || "(empty)"}" is not a field a sync may write. Allowed: ${target.allowedFields.join(", ")}.`, { field: "dmsField" });
    if (seenDms.has(dmsField)) throw err(400, "VALIDATION_FAILED", `"${dmsField}" is mapped more than once`, { field: "dmsField" });
    seenDms.add(dmsField);
    if (isKey) keys += 1;
    let list;
    try { list = parseTransformList(m.transform); } catch (e) { throw err(400, "VALIDATION_FAILED", e.message, { field: "transform" }); }
    rows.push({ source_field: sourceField, dms_field: dmsField, is_key: isKey, transform: list.length ? list.join(",") : null });
  }
  if (keys !== 1) throw err(400, "VALIDATION_FAILED", "Exactly one mapping must be the key (the ERP field that identifies the record)", { field: "mappings" });
  for (const f of target.requiredFields || []) {
    if (!rows.some((r) => r.dms_field === f)) {
      const label = (target.fields.find((x) => x.name === f) || {}).label || f;
      throw err(400, "VALIDATION_FAILED", `A mapping to "${label}" (${f}) is required for ${target.label}`, { field: "mappings" });
    }
  }

  await db.sequelize.transaction(async (t) => {
    await db.ErpEntityMapping.destroy({ where: { connection_id: conn.id, capability: cap }, transaction: t });
    for (const r of rows) await db.ErpEntityMapping.create({ ...r, connection_id: conn.id, capability: cap, dms_entity: target.entityType, source_entity: "" }, { transaction: t });
  });
  audit("ERP_MAPPING_UPDATED", adminId, tenantKey, conn, `capability=${cap} fields=${rows.length}`);
  return getMappings(db, tenantKey, conn.id, cap);
}

module.exports = { loadConnection, preflight, createJob, auditJobResult, findJob, presentJob, startSync, retryJob, getJob, listJobs, listJobErrors, getSummary, getMappings, saveMappings, MAX_ATTEMPTS };
