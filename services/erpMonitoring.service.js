// services/erpMonitoring.service.js — Phase 15 monitoring: dashboard summary, per-ERP statistics, sync health, error monitor.
// Every number is computed from real rows (erp_connections, erp_sync_jobs, erp_sync_schedules, erp_sync_errors) of ONE tenant. Nothing is
// hard-coded or estimated; with no data the answer is zero / null and the UI says "No sync activity yet".
const { Op, fn, col } = require("sequelize");
const C = require("./erp/erpConstants");
const { ErpApiError } = require("./erp/erpApiError");
const { RETRYABLE } = require("./erp/erpErrors");
const { resolveProviderKey, getDescriptor } = require("./erp/providerRegistry");
const { credentialStatus } = require("./erp/secretResolver");
const runtime = require("./erp/runtimeConfig");
const V = require("../utils/erpValidate");

const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const DAY = 86400000;
const COMPLETED = ["SUCCESS", "PARTIAL", "FAILED"];
const HEALTH_WINDOW_DAYS = 14; // only recent history says anything about health
const RECENT_N = 5;            // how many of the latest completed jobs of a capability are examined
const CONSECUTIVE_FAILS = 3;   // this many failed runs in a row = repeated failure
const RANK = { UNKNOWN: 0, HEALTHY: 1, WARNING: 2, ERROR: 3 };
const labelOf = (capability) => (C.CAPABILITIES.find((c) => c.value === capability) || {}).label || capability;
const startOfToday = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };

/**
 * Health of ONE capability from its completed jobs, newest first (statuses only). Pure — the rule is the documentation:
 *   ERROR    the last run FAILED (also covers repeated failures: reason says how many in a row)
 *   WARNING  the last run was PARTIAL, or any of the latest 5 runs was PARTIAL / FAILED
 *   HEALTHY  the latest 5 runs all SUCCEEDED
 *   UNKNOWN  no completed run in the last 14 days
 */
function computeHealth(statusesNewestFirst) {
  const s = statusesNewestFirst;
  if (!s.length) return { status: "UNKNOWN", reason: "No sync has completed recently" };
  let streak = 0; while (streak < s.length && s[streak] === "FAILED") streak += 1;
  if (streak >= CONSECUTIVE_FAILS) return { status: "ERROR", reason: `Failed ${streak} times in a row` };
  if (s[0] === "FAILED") return { status: "ERROR", reason: "The last sync failed" };
  if (s[0] === "PARTIAL") return { status: "WARNING", reason: "The last sync completed with errors" };
  const recent = s.slice(0, RECENT_N);
  const bad = recent.filter((x) => x !== "SUCCESS").length;
  if (bad) return { status: "WARNING", reason: `${bad} of the last ${recent.length} syncs had problems` };
  return { status: "HEALTHY", reason: "No recent failures" };
}
const worst = (list) => list.reduce((w, h) => (RANK[h.status] > RANK[w.status] ? h : w), { status: "UNKNOWN", reason: "No sync has completed recently" });

const slim = (j) => (j ? { jobId: j.id, status: j.status, capability: j.capability, capabilityLabel: labelOf(j.capability), at: j.completed_at || j.createdAt, trigger: j.trigger_type } : null);

async function getSummary(db, tenantKey, { now = new Date() } = {}) {
  const since7 = new Date(now.getTime() - 7 * DAY);
  const sinceHealth = new Date(now.getTime() - HEALTH_WINDOW_DAYS * DAY);
  const today = startOfToday(now);

  const conns = await db.ErpConnection.findAll({ where: { tenant_key: tenantKey }, order: [["id", "ASC"]], limit: 200 });
  const connIds = conns.map((c) => c.id);
  const [runningRows, todayRows, weekRows, completedJobs, schedules, anyJob] = await Promise.all([
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, status: ["QUEUED", "RUNNING"] }, attributes: ["connection_id", "status"], raw: true }),
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, createdAt: { [Op.gte]: today } }, attributes: ["status", [fn("COUNT", col("id")), "n"]], group: ["status"], raw: true }),
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, createdAt: { [Op.gte]: since7 } }, attributes: ["connection_id", "status", [fn("COUNT", col("id")), "n"]], group: ["connection_id", "status"], raw: true }),
    db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, status: COMPLETED, completed_at: { [Op.gte]: sinceHealth } }, order: [["completed_at", "DESC"], ["id", "DESC"]], limit: 3000 }),
    db.ErpSyncSchedule.findAll({ where: { tenant_key: tenantKey, enabled: true } }),
    db.ErpSyncJob.count({ where: { tenant_key: tenantKey } }),
  ]);

  const by = (rows, status) => Number((rows.find((r) => r.status === status) || {}).n || 0);
  const todayTotal = todayRows.reduce((t, r) => t + Number(r.n), 0);
  const activeConns = new Set(conns.filter((c) => c.status === "ACTIVE").map((c) => c.id));

  // newest-first completed jobs → per connection / per capability
  const perConnJobs = new Map(); const perCap = new Map();
  for (const j of completedJobs) {
    if (!perConnJobs.has(j.connection_id)) perConnJobs.set(j.connection_id, []);
    perConnJobs.get(j.connection_id).push(j);
    const k = `${j.connection_id}:${j.capability}`;
    if (!perCap.has(k)) perCap.set(k, []);
    perCap.get(k).push(j.status);
  }
  const schedByConn = new Map();
  for (const s of schedules) { if (!schedByConn.has(s.connection_id)) schedByConn.set(s.connection_id, []); schedByConn.get(s.connection_id).push(s); }
  const nextOf = (s) => (s.next_retry_at || s.next_run_at ? new Date(s.next_retry_at || s.next_run_at) : null);
  const earliest = (list) => list.map((s) => ({ s, at: nextOf(s) })).filter((x) => x.at).sort((a, b) => a.at - b.at)[0] || null;

  const perConnection = conns.map((c) => {
    const jobs = perConnJobs.get(c.id) || [];
    const caps = [...new Set(jobs.map((j) => j.capability))];
    const capHealth = caps.map((cap) => ({ capability: cap, ...computeHealth(perCap.get(`${c.id}:${cap}`)) }));
    const health = capHealth.length ? worst(capHealth) : computeHealth([]);
    const lastOk = jobs.find((j) => j.status === "SUCCESS");
    const wk = weekRows.filter((r) => r.connection_id === c.id);
    const nxt = earliest(schedByConn.get(c.id) || []);
    const desc = getDescriptor(resolveProviderKey(c));
    return {
      id: c.id, name: c.name, code: c.code, erpType: c.erp_type, erpTypeLabel: C.ERP_TYPE_LABELS[c.erp_type] || c.erp_type, environment: c.environment, status: c.status,
      provider: desc ? { key: desc.key, label: desc.label, status: desc.status } : null,
      health: { status: health.status, reason: health.reason, capabilities: capHealth.filter((h) => h.status !== "UNKNOWN").map((h) => ({ capability: h.capability, capabilityLabel: labelOf(h.capability), status: h.status, reason: h.reason })) },
      lastSync: slim(jobs[0]),
      lastSuccessfulSync: slim(lastOk),
      last7Days: { success: by(wk, "SUCCESS"), partial: by(wk, "PARTIAL"), failed: by(wk, "FAILED") },
      runningNow: runningRows.filter((r) => r.connection_id === c.id && r.status === "RUNNING").length,
      scheduledCapabilities: (schedByConn.get(c.id) || []).length,
      nextSync: nxt ? { at: nxt.at, capability: nxt.s.capability, capabilityLabel: labelOf(nxt.s.capability), isRetry: Boolean(nxt.s.next_retry_at) } : null,
    };
  });

  // overall "last successful" and "next scheduled" (only ACTIVE connections' schedules will actually run)
  const lastOkAll = completedJobs.filter((j) => j.status === "SUCCESS")[0] || null;
  const cname = new Map(conns.map((c) => [c.id, c.name]));
  const nextAll = earliest(schedules.filter((s) => activeConns.has(s.connection_id)));

  // Phase 16 — rates and the last failure come from the same 7-day job counts; alerts from real rows (monitoring only, nothing is notified externally).
  const w7 = { success: by(weekRows, "SUCCESS"), partial: by(weekRows, "PARTIAL"), failed: by(weekRows, "FAILED") };
  const done7 = w7.success + w7.partial + w7.failed;
  const rate = (n) => (done7 ? Math.round((n / done7) * 1000) / 10 : null); // % with one decimal; null = nothing completed yet (never a made-up 100 %)
  const lastFailedJob = completedJobs.find((j) => j.status === "FAILED") || null;
  const ctx = { conns, schedules, runningRows, completedJobs, cname, now };
  const alerts = await computeAlerts(db, tenantKey, ctx);

  return {
    partialSyncsLast7Days: w7.partial,
    successRateLast7Days: rate(w7.success),
    failureRateLast7Days: rate(w7.failed),
    completedSyncsLast7Days: done7,
    lastFailedSync: lastFailedJob ? { jobId: lastFailedJob.id, at: lastFailedJob.completed_at, capability: lastFailedJob.capability, errorCode: lastFailedJob.error_code || null, connectionName: cname.get(lastFailedJob.connection_id) || null } : null,
    scheduledJobs: schedules.length,
    worker: { implementation: "DB_BACKED_WORKER", realQueue: false, maxConcurrent: Number(process.env.ERP_SYNC_MAX_CONCURRENT || 2), runningInThisProcess: require("./erpScheduler.service").inflightCount() },
    alerts,
    connections: conns.length,
    activeConnections: activeConns.size,
    errorConnections: conns.filter((c) => c.status === "ERROR").length,
    runningSyncs: runningRows.filter((r) => r.status === "RUNNING").length,
    queuedSyncs: runningRows.filter((r) => r.status === "QUEUED").length,
    syncsToday: { total: todayTotal, success: by(todayRows, "SUCCESS"), partial: by(todayRows, "PARTIAL"), failed: by(todayRows, "FAILED") },
    failedSyncsLast7Days: weekRows.filter((r) => r.status === "FAILED").reduce((t, r) => t + Number(r.n), 0),
    lastSuccessfulSync: lastOkAll ? { jobId: lastOkAll.id, at: lastOkAll.completed_at, capability: lastOkAll.capability, connectionName: cname.get(lastOkAll.connection_id) || null } : null,
    nextScheduledSync: nextAll ? { at: nextAll.at, capability: nextAll.s.capability, capabilityLabel: labelOf(nextAll.s.capability), connectionName: cname.get(nextAll.s.connection_id) || null, isRetry: Boolean(nextAll.s.next_retry_at) } : null,
    enabledSchedules: schedules.length,
    hasSyncActivity: anyJob > 0,
    perConnection,
    asOf: now,
  };
}


// ───────────────────────── alerts (Phase 16 foundation) ─────────────────────────
// Derived from real rows each time (no alert table, no e-mail / SMS / chat): the monitoring screens read them, nothing is pushed anywhere.
//   severity CRITICAL | WARNING | INFO
async function computeAlerts(db, tenantKey, { conns, schedules, runningRows, completedJobs, cname, now }) {
  const out = [];
  const add = (code, severity, message, extra = {}) => out.push({ code, severity, message, ...extra });
  const name = (id) => cname.get(id) || `#${id}`;
  for (const c of conns) if (c.status === "ERROR") add("CONNECTION_ERROR", "CRITICAL", `${c.name}: the last connection test failed.`, { connectionId: c.id });
  // repeated failures per connection + capability (same rule as the health badge)
  const per = new Map();
  for (const j of completedJobs) { const k = `${j.connection_id}:${j.capability}`; if (!per.has(k)) per.set(k, []); per.get(k).push(j.status); }
  for (const [k, st] of per) {
    const h = computeHealth(st);
    if (h.status === "ERROR") { const [cid, cap] = k.split(":"); add("SYNC_FAILING", "CRITICAL", `${name(Number(cid))} · ${labelOf(cap)}: ${h.reason}.`, { connectionId: Number(cid), capability: cap }); }
  }
  const staleMs = runtime.scheduler().staleMs; // same threshold the reaper uses (Phase 17 unified the two defaults)
  const stuck = await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, status: "RUNNING" }, attributes: ["id", "connection_id", "capability", "heartbeat_at", "started_at"], raw: true });
  for (const j of stuck) { const last = new Date(j.heartbeat_at || j.started_at || 0).getTime(); if (now.getTime() - last > staleMs) add("JOB_STUCK", "WARNING", `${name(j.connection_id)} · ${labelOf(j.capability)}: job ${j.id} has shown no activity for over ${Math.round(staleMs / 60000)} minutes.`, { connectionId: j.connection_id, capability: j.capability, jobId: j.id }); }
  const lag = 20 * 60000; // a schedule more than 20 minutes overdue means the scheduler is not running (its tick is seconds)
  for (const s of schedules) {
    const due = s.next_retry_at || s.next_run_at;
    if (due && now.getTime() - new Date(due).getTime() > lag) add("SCHEDULER_OVERDUE", "WARNING", `${name(s.connection_id)} · ${labelOf(s.capability)}: scheduled sync is overdue — the scheduler may not be running.`, { connectionId: s.connection_id, capability: s.capability });
    if (s.last_status === "FAILED" && s.retry_count >= runtime.scheduler().maxAutoRetries) add("RETRIES_EXHAUSTED", "CRITICAL", `${name(s.connection_id)} · ${labelOf(s.capability)}: automatic retries are used up; the schedule waits for its next regular run.`, { connectionId: s.connection_id, capability: s.capability });
  }
  // Phase 17 — provider / configuration problems, from real rows only
  const activeConns = conns.filter((c) => c.status !== "INACTIVE");
  const enabledCaps = activeConns.length ? await db.ErpConnectionCapability.findAll({ where: { enabled: true, connection_id: activeConns.map((c) => c.id), direction: { [Op.ne]: "DISABLED" } }, attributes: ["connection_id", "capability"], raw: true }) : [];
  for (const c of activeConns) {
    const key = resolveProviderKey(c); const d = key ? getDescriptor(key) : null;
    const hasCaps = enabledCaps.some((x) => x.connection_id === c.id);
    if (hasCaps && (!d || d.status !== "IMPLEMENTED")) add("PROVIDER_NOT_SUPPORTED", "WARNING", `${c.name}: ${d ? `the ${d.label} provider is not implemented` : "no provider is selected"}, so its capabilities cannot run.`, { connectionId: c.id });
    if (hasCaps && (await credentialStatus(c.credential_ref, c.auth_type)) !== "RESOLVED") add("CREDENTIALS_MISSING", "WARNING", `${c.name}: the server cannot resolve this connection's credentials.`, { connectionId: c.id });
  }
  const CONFIG_CODES = ["INVALID_CONFIGURATION", "MAPPING_NOT_CONFIGURED", "INVALID_ENDPOINT", "PROVIDER_NOT_SUPPORTED"];
  for (const [k, st] of per) { // newest completed job of each connection + capability
    const [cid, capab] = k.split(":");
    const last = completedJobs.find((j) => String(j.connection_id) === cid && j.capability === capab);
    if (last && last.status !== "SUCCESS" && CONFIG_CODES.includes(last.error_code) && !/schedule was disabled|deactivated|stopped because/i.test(last.error_message || "")) add("CONFIGURATION_ERROR", "WARNING", `${name(Number(cid))} · ${labelOf(capab)}: the last run failed because of a configuration problem (${last.error_code}).`, { connectionId: Number(cid), capability: capab });
  }
  const undecided = await db.ErpConnectionCapability.findAll({ where: { enabled: true, ownership: null, capability: C.OWNERSHIP_REQUIRED, direction: { [Op.ne]: "DISABLED" }, connection_id: conns.map((c) => c.id) }, raw: true });
  for (const u of undecided) add("OWNERSHIP_UNDECIDED", "INFO", `${name(u.connection_id)} · ${labelOf(u.capability)}: data ownership is not defined, so this capability cannot run.`, { connectionId: u.connection_id, capability: u.capability });
  const since = new Date(now.getTime() - 7 * DAY);
  const ob = await db.ErpOutboundEvent.count({ where: { tenant_key: tenantKey, status: ["FAILED", "BLOCKED"], updatedAt: { [Op.gte]: since } } });
  if (ob) add("OUTBOUND_PROBLEMS", "WARNING", `${ob} outbound (DMS → ERP) write(s) failed or were blocked in the last 7 days.`);
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 50);
}
async function getAlerts(db, tenantKey) { return { alerts: (await getSummary(db, tenantKey)).alerts }; }

// ───────────────────────── error monitor ─────────────────────────
const ERROR_CODE_VALUES = Object.keys(C.ERROR_CODES);

/**
 * Filterable error list across ALL jobs of the tenant. Filters: connectionId (ERP), capability, errorCode, status (of the owning job),
 * from / to (YYYY-MM-DD, server day), retryable (true / false). Run-level failures appear with scope "RUN", record failures with "RECORD".
 */
async function listErrors(db, tenantKey, query = {}) {
  const where = { tenant_key: tenantKey };
  const connectionId = V.posInt(query.connectionId, "connectionId"); if (connectionId) where.connection_id = connectionId;
  const capability = V.oneOf(query.capability, C.CAPABILITY_VALUES, "capability"); if (capability) where.capability = capability;
  const errorCode = V.oneOf(query.errorCode, ERROR_CODE_VALUES, "errorCode"); if (errorCode) where.error_code = errorCode;
  const retryable = V.bool(query.retryable, "retryable"); if (retryable !== undefined) where.retryable = retryable;
  const from = V.day(query.from, "from"); const to = V.day(query.to, "to");
  if (from && to && from > to) throw err(400, "VALIDATION_FAILED", "from must not be after to");
  if (from || to) where.createdAt = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lt]: new Date(to.getTime() + DAY) } : {}) };
  const status = V.oneOf(query.status, ["QUEUED", "RUNNING", "SUCCESS", "PARTIAL", "FAILED"], "status");
  // Phase 17: the job-status filter is a sub-select (it used to load up to 20 000 job ids into memory and send them back as an IN list).
  if (status) where.job_id = { [Op.in]: db.sequelize.literal(`(SELECT id FROM erp_sync_jobs WHERE tenant_key = ${db.sequelize.escape(tenantKey)} AND status = ${db.sequelize.escape(status)})`) };
  const { page, pageSize, offset } = V.paging(query, { defaultSize: 25, maxSize: 100 });

  const [{ rows, count }, codeRows] = await Promise.all([
    db.ErpSyncError.findAndCountAll({ where, order: [["id", "DESC"]], limit: pageSize, offset }),
    db.ErpSyncError.findAll({ where, attributes: ["error_code", [fn("COUNT", col("id")), "n"]], group: ["error_code"], raw: true }),
  ]);
  const jobs = rows.length ? await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, id: [...new Set(rows.map((r) => r.job_id))] } }) : [];
  const conns = rows.length ? await db.ErpConnection.findAll({ where: { tenant_key: tenantKey, id: [...new Set(jobs.map((j) => j.connection_id))] }, attributes: ["id", "name", "code"] }) : [];
  const kids = jobs.length ? await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, retry_of_job_id: jobs.map((j) => j.id) }, attributes: ["retry_of_job_id", "createdAt"], raw: true }) : [];
  const jm = new Map(jobs.map((j) => [j.id, j])); const cm = new Map(conns.map((c) => [c.id, c]));
  const lastRetry = new Map(); for (const k of kids) if (!lastRetry.has(k.retry_of_job_id) || new Date(k.createdAt) > lastRetry.get(k.retry_of_job_id)) lastRetry.set(k.retry_of_job_id, new Date(k.createdAt));

  return {
    items: rows.map((e) => {
      const j = jm.get(e.job_id); const c = j ? cm.get(j.connection_id) : null;
      return {
        id: e.id, jobId: e.job_id, scope: e.record_index === null ? "RUN" : "RECORD", recordIndex: e.record_index, externalId: e.external_id,
        code: e.error_code, message: e.message, retryable: Boolean(e.retryable), createdAt: e.createdAt,
        connection: c ? { id: c.id, name: c.name, code: c.code } : { id: e.connection_id || (j && j.connection_id) || null },
        capability: e.capability || (j && j.capability) || null, capabilityLabel: labelOf(e.capability || (j && j.capability)),
        job: j ? { status: j.status, trigger: j.trigger_type, attempt: j.attempt, retryCount: Math.max(0, j.attempt - 1), lastRetryAt: lastRetry.get(j.id) || null, canRetry: ["FAILED", "PARTIAL"].includes(j.status) && j.attempt < require("./erpSync.service").MAX_ATTEMPTS } : null,
      };
    }),
    total: count, page, pageSize,
    byCode: codeRows.map((r) => ({ code: r.error_code, count: Number(r.n), retryable: RETRYABLE.has(r.error_code) })).sort((a, b) => b.count - a.count),
  };
}

module.exports = { getSummary, getAlerts, computeAlerts, listErrors, computeHealth, HEALTH_WINDOW_DAYS, RECENT_N, CONSECUTIVE_FAILS };
