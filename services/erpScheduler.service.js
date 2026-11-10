// services/erpScheduler.service.js — Phase 15 scheduled ERP sync.
//
//   Scheduler (tick)  →  find DUE schedules  →  claim atomically  →  create a QUEUED job          (never runs a sync itself)
//   Worker (tick)     →  take QUEUED scheduled jobs  →  claim (QUEUED→RUNNING)  →  generic sync engine  →  finalise the schedule
//
// Infrastructure reality (documented, not hidden): this project has no queue / Redis / cron service, so the scheduler is an in-process timer
// started by server.js. What makes that safe:
//   • minimum interval 15 minutes — a timer inside one Node process cannot honestly promise anything tighter;
//   • claim by compare-and-swap on next_run_at/next_retry_at: if two server processes tick together only one wins the slot;
//   • Phase 14's UNIQUE active_key: a schedule can never create a second job while one is QUEUED/RUNNING (SYNC_ALREADY_RUNNING → skipped);
//   • no catch-up storm: after downtime a due schedule fires ONCE and then moves to now + interval;
//   • crashed jobs (no heartbeat for ERP_SYNC_STALE_MINUTES) are closed as FAILED so the schedule is not blocked forever;
//   • automatic retries: only for transient run-level errors, exponential backoff, bounded (ERP_SYNC_AUTO_MAX_RETRIES, default 3).
// If the process is down the schedule simply does not run — that is the limitation of an in-process scheduler.
const { Op } = require("sequelize");
const C = require("./erp/erpConstants");
const { ErpApiError } = require("./erp/erpApiError");
const { RETRYABLE } = require("./erp/erpErrors");
const { runSync } = require("./erp/sync/syncEngine");
const { audit } = require("./erpIntegration.service");
const sync = require("./erpSync.service");
const inflight = require("./erpInflight");
const runtime = require("./erp/runtimeConfig");
// NOTE (tested): this module must never import middleware/rateLimiter — scheduler / worker traffic does not go through HTTP and is never throttled.

const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const FREQ = Object.fromEntries(C.SCHEDULE_FREQUENCIES.map((f) => [f.value, f]));
const { MIN } = runtime;
const cfg = () => runtime.scheduler(); // every limit is clamped to a sane range (see runtimeConfig.js)
const plain = (r) => (r ? r.get({ plain: true }) : null);
const addMin = (d, m) => new Date(new Date(d).getTime() + m * MIN);
const labelOf = (capability) => (C.CAPABILITIES.find((c) => c.value === capability) || {}).label || capability;

// ───────────────────────── presentation ─────────────────────────
function presentSchedule(s, conn) {
  const row = s.get ? s.get({ plain: true }) : s;
  const f = FREQ[row.frequency];
  return {
    id: row.id,
    connection: conn ? { id: conn.id, name: conn.name, code: conn.code, erpType: conn.erp_type, erpTypeLabel: C.ERP_TYPE_LABELS[conn.erp_type] || conn.erp_type } : { id: row.connection_id },
    capability: row.capability, capabilityLabel: labelOf(row.capability),
    enabled: Boolean(row.enabled), frequency: row.frequency, frequencyLabel: f ? f.label : row.frequency, intervalMinutes: f ? f.minutes : null,
    scope: row.scope || null,
    // The next time the scheduler will act: a pending retry wins over the regular slot. Disabled schedules have no next run.
    nextRunAt: row.enabled ? row.next_retry_at || row.next_run_at : null,
    nextRegularRunAt: row.enabled ? row.next_run_at : null,
    nextRetryAt: row.enabled ? row.next_retry_at : null,
    lastRunAt: row.last_run_at ?? null, lastJobId: row.last_job_id ?? null, lastStatus: row.last_status ?? null,
    lastError: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message, retryable: RETRYABLE.has(row.last_error_code) } : null,
    retryCount: row.retry_count, maxAutoRetries: cfg().maxAutoRetries, lastRetryAt: row.last_retry_at ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
async function connMap(db, tenantKey, ids) {
  const rows = ids.length ? await db.ErpConnection.findAll({ where: { tenant_key: tenantKey, id: [...new Set(ids)] } }) : [];
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}
const findOwned = (db, tenantKey, id) => {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? db.ErpSyncSchedule.findOne({ where: { id: n, tenant_key: tenantKey } }) : null;
};

// ───────────────────────── CRUD (tenant-scoped; foreign ids → null → 404) ─────────────────────────
async function listSchedules(db, tenantKey, query = {}) {
  const where = { tenant_key: tenantKey };
  const cid = require("../utils/erpValidate").posInt(query.connectionId, "connectionId"); if (cid) where.connection_id = cid;
  const rows = await db.ErpSyncSchedule.findAll({ where, order: [["id", "ASC"]], limit: 500 }); // hard cap (one schedule per connection × capability)
  const cm = await connMap(db, tenantKey, rows.map((r) => r.connection_id));
  return { items: rows.map((r) => presentSchedule(r, cm[r.connection_id])), total: rows.length };
}

async function getSchedule(db, tenantKey, id) {
  const s = await findOwned(db, tenantKey, id);
  if (!s) return null;
  return presentSchedule(s, (await connMap(db, tenantKey, [s.connection_id]))[s.connection_id]);
}

/**
 * Create or update the schedule of (connection, capability). `enabled:true` is only accepted when a sync of that capability could actually run
 * today (provider implemented, endpoint, mapping with a key, direction, valid scope) — the same preflight as a manual sync.
 */
async function saveSchedule(db, tenantKey, adminId, connectionId, capabilityRaw, body = {}, { now = new Date() } = {}) {
  if (!body || typeof body !== "object") throw err(400, "VALIDATION_FAILED", "Request body must be an object");
  const conn = await sync.loadConnection(db, tenantKey, connectionId);
  if (!conn) return null;
  const capability = String(capabilityRaw || "").toUpperCase();
  if (!C.CAPABILITY_VALUES.includes(capability)) throw err(400, "VALIDATION_FAILED", "Unknown capability", { field: "capability" });
  const existing = await db.ErpSyncSchedule.findOne({ where: { connection_id: conn.id, capability } });

  let frequency = body.frequency === undefined ? (existing && existing.frequency) : String(body.frequency).toUpperCase();
  if (!frequency || !FREQ[frequency]) throw err(400, "VALIDATION_FAILED", `frequency must be one of: ${C.SCHEDULE_FREQUENCY_VALUES.join(", ")}`, { field: "frequency" });
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw err(400, "VALIDATION_FAILED", "enabled must be true or false", { field: "enabled" });
  const enabled = body.enabled === undefined ? Boolean(existing && existing.enabled) : body.enabled;
  const rawScope = body.scope !== undefined ? body.scope : existing && existing.scope;

  let scope = existing ? existing.scope : null;
  if (enabled) {
    const { resolved } = await sync.preflight(db, conn, capability, rawScope);
    scope = resolved.scope;
  } else if (body.scope !== undefined) {
    scope = rawScope && typeof rawScope === "object" ? rawScope : null; // stored as given; re-validated when it is enabled
  }

  const wasEnabled = Boolean(existing && existing.enabled);
  const changedPlan = !existing || !wasEnabled || existing.frequency !== frequency;
  const values = {
    tenant_key: tenantKey, connection_id: conn.id, capability, enabled, frequency, scope, updated_by_admin_id: adminId || null,
    ...(enabled ? (changedPlan ? { next_run_at: addMin(now, FREQ[frequency].minutes), next_retry_at: null, retry_count: 0 } : {}) : { next_run_at: null, next_retry_at: null }),
  };
  let row;
  if (existing) { await existing.update(values); row = existing; } else row = await db.ErpSyncSchedule.create({ ...values, created_by_admin_id: adminId || null });
  audit(!existing ? "ERP_SCHEDULE_CREATED" : wasEnabled && !enabled ? "ERP_SCHEDULE_DISABLED" : "ERP_SCHEDULE_UPDATED", adminId, tenantKey, conn, `schedule=${row.id} capability=${capability} enabled=${enabled} frequency=${frequency}`);
  if (!existing && !enabled) audit("ERP_SCHEDULE_DISABLED", adminId, tenantKey, conn, `schedule=${row.id} capability=${capability} created disabled`);
  return presentSchedule(row, conn);
}

// ───────────────────────── scheduler: due schedules → QUEUED jobs ─────────────────────────
async function fireSchedule(db, s, now) {
  const isRetry = s.next_retry_at !== null && s.next_retry_at !== undefined;
  const interval = (FREQ[s.frequency] || FREQ.DAILY).minutes;
  // Compare-and-swap claim: only the process whose WHERE still matches wins the slot. A retry leaves the regular slot untouched.
  const claim = isRetry
    ? { next_retry_at: null, last_run_at: now, last_retry_at: now }
    : { next_run_at: addMin(now, interval), next_retry_at: null, last_run_at: now, retry_count: 0 };
  const [won] = await db.ErpSyncSchedule.update(claim, { where: { id: s.id, enabled: true, next_run_at: s.next_run_at, next_retry_at: isRetry ? s.next_retry_at : null } });
  if (!won) return { schedule: s.id, outcome: "CLAIMED_ELSEWHERE" };

  const conn = await sync.loadConnection(db, s.tenant_key, s.connection_id);
  const skip = async (code, message) => { await db.ErpSyncSchedule.update({ last_status: "SKIPPED", last_error_code: code, last_error_message: String(message).slice(0, 255) }, { where: { id: s.id } }); return { schedule: s.id, outcome: "SKIPPED", code }; };
  if (!conn) return skip("INVALID_CONFIGURATION", "The ERP connection no longer exists.");
  let resolved;
  try { ({ resolved } = await sync.preflight(db, conn, s.capability, s.scope)); } catch (e) {
    if (e instanceof ErpApiError) { audit("ERP_SCHEDULE_SKIPPED", null, s.tenant_key, conn, `schedule=${s.id} capability=${s.capability} reason=${e.code}`); return skip(e.code, e.message); }
    throw e;
  }
  let job;
  try {
    job = await sync.createJob(db, s.tenant_key, null, conn, s.capability, resolved, isRetry ? { trigger: "RETRY", retryOf: s.last_job_id, attempt: s.retry_count + 1 } : { trigger: "SCHEDULED" });
  } catch (e) {
    if (e instanceof ErpApiError && e.code === "SYNC_ALREADY_RUNNING") return skip("SYNC_ALREADY_RUNNING", "A synchronisation of this ERP and capability was still running; this slot was skipped.");
    throw e;
  }
  await db.ErpSyncSchedule.update({ last_job_id: job.id, last_status: "QUEUED", last_error_code: null, last_error_message: null }, { where: { id: s.id } });
  if (isRetry) audit("ERP_SYNC_RETRIED", null, s.tenant_key, conn, `job=${job.id} capability=${s.capability} automatic attempt=${job.attempt}`);
  return { schedule: s.id, outcome: "QUEUED", jobId: job.id };
}

/** One scheduler pass. Creates jobs only. Returns what it did (for tests / logs). */
async function schedulerTick(db, { now = new Date(), limit = 50 } = {}) {
  await reapStaleJobs(db, now);
  const due = await db.ErpSyncSchedule.findAll({
    where: { enabled: true, [Op.or]: [{ next_retry_at: { [Op.lte]: now } }, { next_retry_at: null, next_run_at: { [Op.lte]: now } }] },
    order: [["id", "ASC"]], limit,
  });
  const results = [];
  for (const s of due) {
    try { results.push(await fireSchedule(db, s, now)); } catch (e) { console.error("erp scheduler: schedule failed:", e && e.name); results.push({ schedule: s.id, outcome: "ERROR" }); }
  }
  return results;
}

// A QUEUED/RUNNING job whose heartbeat stopped (process crash) would block its schedule through active_key forever.
async function reapStaleJobs(db, now = new Date()) {
  const cutoff = new Date(new Date(now).getTime() - cfg().staleMs);
  const stale = await db.ErpSyncJob.findAll({ where: { status: ["QUEUED", "RUNNING"], heartbeat_at: { [Op.lt]: cutoff } }, order: [["id", "ASC"]], limit: 100 });
  let closed = 0;
  for (const j of stale) {
    // CAS: only the process that still sees the job QUEUED/RUNNING closes it (two reapers, or the job finishing at this very moment, cannot both win)
    const [won] = await db.ErpSyncJob.update({ status: "FAILED", active_key: null, completed_at: now, error_code: "INTERNAL_ERROR", error_message: "The sync was interrupted (no activity). It was closed so the schedule can continue." }, { where: { id: j.id, status: ["QUEUED", "RUNNING"], heartbeat_at: { [Op.lt]: cutoff } } });
    if (!won) continue;
    const fresh = await db.ErpSyncJob.findByPk(j.id);
    const conn = await sync.loadConnection(db, j.tenant_key, j.connection_id);
    audit("ERP_SYNC_INTERRUPTED", null, j.tenant_key, conn, `job=${j.id} capability=${j.capability} status=FAILED reason=no-heartbeat cid=${j.correlation_id || "-"}`);
    await finalizeSchedule(db, fresh, now);
    closed += 1;
  }
  return closed;
}

const state = { startedAt: null, lastTickAt: null, lastTickOk: null, ticks: 0, intervalMs: null, stopped: false };
const getState = () => ({ ...state, running: Boolean(timer), inflight: inflight.count() });

// ───────────────────────── worker: QUEUED scheduled jobs → generic sync engine ─────────────────────────
/** One worker pass. Runs at most (ERP_SYNC_MAX_CONCURRENT − currently RUNNING) jobs; each is claimed QUEUED→RUNNING first (compare-and-swap). */
// A scheduled job is run only while its schedule is still enabled and its connection still active: disabling a schedule (or deactivating the ERP)
// between "job queued" and "job claimed" cancels that run instead of executing it.
async function stillWanted(db, j) {
  const s = await db.ErpSyncSchedule.findOne({ where: { tenant_key: j.tenant_key, connection_id: j.connection_id, capability: j.capability } });
  if (!s || !s.enabled) return "The schedule was disabled before the run started.";
  const c = await db.ErpConnection.findOne({ where: { id: j.connection_id, tenant_key: j.tenant_key }, attributes: ["status"] });
  if (!c || c.status === "INACTIVE") return "The ERP connection was deactivated before the run started.";
  return null;
}
async function workerTick(db, deps = {}) {
  const { maxConcurrent } = cfg();
  const running = await db.ErpSyncJob.count({ where: { status: "RUNNING" } });
  const slots = maxConcurrent - running;
  if (slots <= 0) return [];
  const queued = await db.ErpSyncJob.findAll({ where: { status: "QUEUED", trigger_type: ["SCHEDULED", "RETRY"], requested_by_admin_id: null }, order: [["id", "ASC"]], limit: slots });
  const claimed = [];
  for (const j of queued) {
    const reason = await stillWanted(db, j);
    if (reason) {
      const [closed] = await db.ErpSyncJob.update({ status: "FAILED", active_key: null, completed_at: new Date(), error_code: "INVALID_CONFIGURATION", error_message: reason }, { where: { id: j.id, status: "QUEUED" } });
      if (closed) audit("ERP_SCHEDULE_SKIPPED", null, j.tenant_key, await sync.loadConnection(db, j.tenant_key, j.connection_id), `job=${j.id} capability=${j.capability} reason=cancelled-before-start cid=${j.correlation_id || "-"}`);
      continue;
    }
    const [won] = await db.ErpSyncJob.update({ status: "RUNNING", started_at: new Date(), heartbeat_at: new Date() }, { where: { id: j.id, status: "QUEUED" } });
    if (won) claimed.push(j);
  }
  const work = Promise.all(claimed.map((j) => inflight.track((async () => {
    let done;
    // The engine re-checks this between pages, so disabling a schedule / deactivating the ERP stops a run that is already in progress.
    const runDeps = { ...deps, shouldContinue: async () => { const r = await stillWanted(db, j); return r ? { stop: true, reason: r } : { stop: false }; } };
    try { done = await runSync(db, j.id, runDeps); } catch (e) { console.error("erp worker: sync crashed:", e && e.name); done = plain(await db.ErpSyncJob.findByPk(j.id)); }
    const conn = await sync.loadConnection(db, j.tenant_key, j.connection_id);
    if (done) { sync.auditJobResult(null, j.tenant_key, conn, done); await finalizeSchedule(db, done, new Date(), deps); }
    return done;
  })(), j.id)));
  return work;
}

/**
 * After a scheduled / auto-retry job ends: record its outcome on the schedule and decide the automatic retry.
 * Only transient RUN-level errors (timeout, rate limit, connection, 5xx) are retried, with exponential backoff (base·2^n minutes),
 * at most `maxAutoRetries` times, and never beyond the next regular slot. Per-record data errors are not retried — they will not fix themselves.
 */
async function finalizeSchedule(db, job, now = new Date(), deps = {}) {
  const j = job.get ? job.get({ plain: true }) : job;
  if (!["SCHEDULED", "RETRY"].includes(j.trigger_type) || j.requested_by_admin_id) return null;
  const s = await db.ErpSyncSchedule.findOne({ where: { tenant_key: j.tenant_key, connection_id: j.connection_id, capability: j.capability } });
  if (!s || Number(s.last_job_id) !== Number(j.id)) return null; // a stale or foreign job never rewrites the schedule's state
  const { maxAutoRetries, retryBaseMinutes, retryMaxDelayMinutes } = { ...cfg(), ...(deps.schedule || {}) };
  const patch = { last_status: j.status, last_error_code: j.error_code || null, last_error_message: j.error_message || null };
  if (j.status === "SUCCESS") Object.assign(patch, { retry_count: 0, next_retry_at: null });
  else if (["FAILED", "PARTIAL"].includes(j.status) && j.error_code && RETRYABLE.has(j.error_code) && s.enabled) {
    if (s.retry_count < maxAutoRetries) {
      const at = addMin(now, Math.min(retryBaseMinutes * 2 ** s.retry_count, retryMaxDelayMinutes || 120)); // exponential, but never longer than the cap
      if (!s.next_run_at || at < new Date(s.next_run_at)) Object.assign(patch, { retry_count: s.retry_count + 1, next_retry_at: at });
      else patch.next_retry_at = null; // the regular slot comes before the backoff would — let it be the retry
    } else patch.next_retry_at = null; // exhausted: stays visible as retry_count = max; the regular schedule continues
  } else patch.next_retry_at = null;
  await s.update(patch);
  return s;
}

/** Make a schedule due right now (admin "Run now"). Goes through the same claim → job → worker path as a timed run. */
async function triggerSchedule(db, tenantKey, adminId, id, { now = new Date(), deps = {} } = {}) {
  const s = await findOwned(db, tenantKey, id);
  if (!s) return null;
  if (!s.enabled) throw err(409, "INVALID_STATE", "Enable the schedule first.");
  await s.update({ next_run_at: now, next_retry_at: null });
  const fresh = await findOwned(db, tenantKey, id);
  const r = await fireSchedule(db, fresh.get({ plain: true }), now);
  if (r.outcome === "SKIPPED") throw err(409, r.code, "This schedule could not be queued right now.", { reason: r.code });
  // Two simultaneous "Run now" requests: only one wins the compare-and-swap claim; the other must not pretend it queued a job.
  if (r.outcome !== "QUEUED") throw err(409, "SYNC_ALREADY_RUNNING", "This schedule is already being triggered.", { reason: r.outcome });
  audit("ERP_SCHEDULE_TRIGGERED", adminId, tenantKey, null, `schedule=${s.id} job=${r.jobId}`);
  if (deps.await) await workerTick(db, deps); else setImmediate(() => workerTick(db, deps).catch((e) => console.error("erp worker crashed:", e && e.name)));
  return getSchedule(db, tenantKey, id);
}

// ───────────────────────── process wiring ─────────────────────────
let timer = null; let busy = false;
function startScheduler(db, { intervalMs = cfg().intervalMs, deps = {} } = {}) {
  if (timer) return timer;
  const every = Math.max(5000, intervalMs);
  const pass = async () => {
    if (busy) return; // never overlap passes in this process
    busy = true;
    try { await schedulerTick(db); await workerTick(db, deps); state.lastTickOk = true; } catch (e) { state.lastTickOk = false; console.error("erp scheduler pass failed:", e && e.name); } finally { busy = false; state.lastTickAt = new Date(); state.ticks += 1; }
  };
  Object.assign(state, { startedAt: new Date(), intervalMs: every, stopped: false });
  timer = setInterval(pass, every);
  if (timer.unref) timer.unref();
  console.info(`[erp-scheduler] started interval=${every}ms minimum-frequency=15min`);
  return timer;
}
function stopScheduler() { if (timer) clearInterval(timer); timer = null; busy = false; state.stopped = true; }

/**
 * Graceful shutdown: stop taking new work, wait up to graceMs for the sync runs this process is executing, report what is left.
 * QUEUED jobs stay QUEUED (persistent) and are picked up after the restart. Runs still RUNNING after the grace period are handed back
 * immediately when `db` is given (closed FAILED so the schedule's active_key is freed and the normal retry rules apply); without `db` they are
 * closed by reapStaleJobs on the next start once their heartbeat is stale. The wait never exceeds graceMs (clamped 1–600 s).
 */
async function shutdownScheduler({ graceMs = cfg().shutdownGraceMs, db = null } = {}) {
  stopScheduler();
  const started = Date.now();
  while (inflight.count() && Date.now() - started < graceMs) {
    await Promise.race([Promise.allSettled(inflight.pending()), new Promise((r) => setTimeout(r, 250))]);
  }
  const left = inflight.jobIds();
  let released = 0;
  if (db && left.length) {
    for (const id of left) {
      const [n] = await db.ErpSyncJob.update({ status: "FAILED", active_key: null, completed_at: new Date(), error_code: "INTERNAL_ERROR", error_message: "The sync was interrupted by a server shutdown. It can be retried." }, { where: { id, status: ["QUEUED", "RUNNING"] } });
      released += n;
    }
  }
  return { stillRunning: inflight.count(), waitedMs: Date.now() - started, released };
}
const inflightCount = () => inflight.count();

module.exports = { listSchedules, getSchedule, saveSchedule, triggerSchedule, schedulerTick, workerTick, finalizeSchedule, reapStaleJobs, startScheduler, stopScheduler, shutdownScheduler, inflightCount, presentSchedule, getState };
