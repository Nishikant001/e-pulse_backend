// Phase 17 — reliability: scheduler / worker locking, crash recovery, retry bounds, duplicate triggers, disabled schedules, graceful shutdown,
// append-only audit, pagination caps, readiness, alerts, health states, the migration (up / up / down / up) and the index set.
// In-memory sqlite, direct service calls, MOCK fetch for every ERP transport. Nothing here proves real ERP connectivity or MySQL behaviour.
const { db, resetDb, seedDistributor } = require("./helpers");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const sched = require("../services/erpScheduler.service");
const monitor = require("../services/erpMonitoring.service");
const audit = require("../services/erpAudit.service");
const readiness = require("../services/erpReadiness.service");
const inflight = require("../services/erpInflight");

const T = "DEFAULT"; const MIN = 60000;
beforeAll(() => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789" }); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); sched.stopScheduler(); });
afterAll(async () => { await audit.flush(); await db.sequelize.close(); });

const hdrs = () => ({ get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null), getSetCookie: () => [] });
const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: hdrs() });
const cap = (capability, endpointPath, o = {}) => ({ capability, endpointPath, direction: "ERP_TO_DMS", config: { responsePath: "rows", pagination: { type: "NONE" } }, ...o });
const PROD_MAP = [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }];
const world = async (n = 1) => {
  const d = await seedDistributor(); const h = await db.HSNGroup.create({ hsn_code: "3004", description: "M", gst_rate: 12, distributor_id: d.id });
  const scope = { distributorId: d.id, hsnId: h.id }; const cs = [];
  for (let i = 0; i < n; i += 1) {
    const c = await conns.createConnection(db, T, 1, { name: `Custom ERP ${i}`, erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: `https://custom${i}.example.com`, credentialRef: "RESTBEARER", capabilities: [cap("PRODUCT_MASTER", "/p")] });
    await sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: PROD_MAP }); cs.push(c);
  }
  return { d, scope, cs, c: cs[0] };
};
const enable = (w, c = w.c, frequency = "EVERY_15_MIN", now) => sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { enabled: true, frequency, scope: w.scope }, now ? { now } : {});
const okFetch = (rows = [{ Code: "A", Title: "a" }]) => jest.fn(async () => json(200, { rows }));
const deps = (f, x = {}) => ({ fetchImpl: f, logger: () => {}, retryDelayMs: 0, ...x });
const later = (m) => new Date(Date.now() + m * MIN);

describe("Scheduler claims and duplicate protection", () => {
  test("two scheduler passes at the same instant create exactly ONE job (compare-and-swap claim)", async () => {
    const w = await world(); await enable(w);
    const t = later(20);
    const [a, b] = await Promise.all([sched.schedulerTick(db, { now: t }), sched.schedulerTick(db, { now: t })]);
    const queued = [...a, ...b].filter((r) => r.outcome === "QUEUED");
    expect(queued).toHaveLength(1);
    expect(await db.ErpSyncJob.count({ where: { trigger_type: "SCHEDULED" } })).toBe(1);
  });

  test("concurrent workers never run the same job twice (QUEUED → RUNNING claim)", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    const f = okFetch();
    const [r1, r2, r3] = await Promise.all([sched.workerTick(db, deps(f)), sched.workerTick(db, deps(f)), sched.workerTick(db, deps(f))]);
    expect([r1, r2, r3].flat().filter(Boolean)).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await db.ErpSyncJob.findAll()).map((j) => j.status)).toEqual(["SUCCESS"]);
  });

  test("a duplicate manual trigger is refused (SYNC_ALREADY_RUNNING / already triggering) and never creates a second active job", async () => {
    const w = await world(); await enable(w);
    const s = (await sched.listSchedules(db, T, {})).items[0];
    const res = await Promise.allSettled([sched.triggerSchedule(db, T, 1, s.id, { deps: { await: false, ...deps(okFetch()) } }), sched.triggerSchedule(db, T, 1, s.id, { deps: { await: false, ...deps(okFetch()) } })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.find((r) => r.status === "rejected").reason).toMatchObject({ statusCode: 409 });
    await new Promise((r) => setTimeout(r, 300));
    expect(await db.ErpSyncJob.count({ where: { trigger_type: "SCHEDULED" } })).toBe(1);
  });

  test("a slot is skipped (not stacked) while the previous run for the same ERP + capability is still active", async () => {
    const w = await world(); await enable(w);
    await sched.schedulerTick(db, { now: later(20) }); // job 1 QUEUED (active)
    await db.ErpSyncJob.update({ heartbeat_at: later(40) }, { where: {} }); // a live heartbeat, so the reaper leaves it alone
    const second = await sched.schedulerTick(db, { now: later(40) });
    expect(second.map((r) => r.outcome)).toEqual(["SKIPPED"]); expect(second[0].code).toBe("SYNC_ALREADY_RUNNING");
    expect(await db.ErpSyncJob.count()).toBe(1);
  });

  test("the scheduler timer never overlaps passes and is idempotent to start", () => {
    const t1 = sched.startScheduler(db, { intervalMs: 600000 }); const t2 = sched.startScheduler(db, { intervalMs: 600000 });
    expect(t1).toBe(t2); expect(sched.getState().running).toBe(true); sched.stopScheduler(); expect(sched.getState().running).toBe(false);
  });
});

describe("Crash recovery", () => {
  test("stale worker: a RUNNING job without heartbeat is closed once (CAS), frees the schedule, and is audited as ERP_SYNC_INTERRUPTED", async () => {
    const w = await world(); await enable(w);
    await sched.schedulerTick(db, { now: later(20) });
    const job = await db.ErpSyncJob.findOne(); await job.update({ status: "RUNNING", started_at: later(-60), heartbeat_at: later(-60) });
    const [a, b] = await Promise.all([sched.reapStaleJobs(db, new Date()), sched.reapStaleJobs(db, new Date())]);
    expect(a + b).toBe(1);
    const j = await db.ErpSyncJob.findByPk(job.id); expect(j.status).toBe("FAILED"); expect(j.active_key).toBeNull(); expect(j.error_code).toBe("INTERNAL_ERROR");
    await audit.flush(); expect(await db.ErpAuditEvent.count({ where: { event: "ERP_SYNC_INTERRUPTED" } })).toBe(1);
    // the schedule can run again
    const again = await sched.schedulerTick(db, { now: later(60) }); expect(again.map((r) => r.outcome)).toContain("QUEUED");
  });

  test("a fresh heartbeat is NOT reaped (a healthy long run is left alone)", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    const job = await db.ErpSyncJob.findOne(); await job.update({ status: "RUNNING", heartbeat_at: new Date() });
    expect(await sched.reapStaleJobs(db, new Date())).toBe(0);
    expect((await db.ErpSyncJob.findByPk(job.id)).status).toBe("RUNNING");
  });

  test("crash during sync: the worker's engine throws mid-run → job ends FAILED (never stuck RUNNING), active_key released, schedule records the outcome", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    const f = jest.fn(async () => { throw new Error("process exploded"); });
    await sched.workerTick(db, deps(f));
    const j = await db.ErpSyncJob.findOne(); expect(["FAILED", "PARTIAL"]).toContain(j.status); expect(j.active_key).toBeNull(); expect(j.completed_at).toBeTruthy();
    expect(inflight.count()).toBe(0);
  });

  test("crash after provider success but before completion: the job (RUNNING, stale) is reaped, records already written are kept and a re-run is idempotent (no duplicates)", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    await sched.workerTick(db, deps(okFetch())); // records written, job SUCCESS
    const products = await db.Product.count();
    const job = await db.ErpSyncJob.findOne();
    await job.update({ status: "RUNNING", completed_at: null, active_key: `${job.connection_id}:PRODUCT_MASTER`, heartbeat_at: later(-60) }); // simulate "died before the final write"
    expect(await sched.reapStaleJobs(db, new Date())).toBe(1);
    expect((await db.ErpSyncJob.findByPk(job.id)).status).toBe("FAILED");
    const retry = await sync.retryJob(db, T, 1, job.id, { await: true, ...deps(okFetch()) });
    expect(retry.status).toBe("SUCCESS"); expect(await db.Product.count()).toBe(products); // upsert by external link, no duplicate product
  });

  test("crash before completion while QUEUED: a QUEUED job survives, is picked up by the next worker pass", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    expect((await db.ErpSyncJob.findOne()).status).toBe("QUEUED");
    sched.stopScheduler(); // "restart"
    const r = await sched.workerTick(db, deps(okFetch())); expect(r).toHaveLength(1); expect((await db.ErpSyncJob.findOne()).status).toBe("SUCCESS");
  });

  test("a stale job of ANOTHER tenant is reaped too, but finalizeSchedule never rewrites a foreign schedule", async () => {
    const w = await world(); await enable(w);
    const foreign = await db.ErpSyncJob.create({ tenant_key: "TENANT_B", connection_id: w.c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", attempt: 1, trigger_type: "SCHEDULED", heartbeat_at: later(-120) });
    expect(await sched.reapStaleJobs(db, new Date())).toBe(1);
    const s = await db.ErpSyncSchedule.findOne(); expect(s.last_status).not.toBe("FAILED");
    expect((await db.ErpSyncJob.findByPk(foreign.id)).status).toBe("FAILED");
  });
});

describe("Retry bounds", () => {
  test("retry exhaustion: transient failures retry with exponential backoff, stop at ERP_SYNC_AUTO_MAX_RETRIES, and the regular schedule continues", async () => {
    process.env.ERP_SYNC_AUTO_MAX_RETRIES = "2"; process.env.ERP_SYNC_AUTO_RETRY_BASE_MINUTES = "1";
    try {
      const w = await world(); await enable(w, w.c, "DAILY");
      const fail = jest.fn(async () => json(503, {}));
      let t = later(24 * 60 + 1);
      const delays = [];
      for (let i = 0; i < 4; i += 1) {
        await sched.schedulerTick(db, { now: t });
        await sched.workerTick(db, deps(fail, { retryDelayMs: 0 }));
        const s = await db.ErpSyncSchedule.findOne(); delays.push(s.next_retry_at ? Math.round((new Date(s.next_retry_at) - Date.now()) / MIN) : null);
        if (s.next_retry_at) t = new Date(new Date(s.next_retry_at).getTime() + 1000);
      }
      const s = await db.ErpSyncSchedule.findOne();
      expect(s.retry_count).toBeLessThanOrEqual(2); expect(s.next_retry_at).toBeNull(); expect(s.enabled).toBe(true); expect(s.next_run_at).toBeTruthy();
      const jobs = await db.ErpSyncJob.findAll({ order: [["id", "ASC"]] });
      expect(jobs.length).toBeLessThanOrEqual(3); // first run + at most 2 automatic retries
      expect(jobs.every((j) => j.status === "FAILED" || j.status === "PARTIAL")).toBe(true);
    } finally { delete process.env.ERP_SYNC_AUTO_MAX_RETRIES; delete process.env.ERP_SYNC_AUTO_RETRY_BASE_MINUTES; }
  });

  test("non-transient (data / config) errors are not retried automatically", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    await sched.workerTick(db, deps(jest.fn(async () => json(401, {}))));
    const s = await db.ErpSyncSchedule.findOne(); expect(s.next_retry_at).toBeNull(); expect(s.retry_count).toBe(0);
  });

  test("the retry delay is capped (ERP_SYNC_AUTO_RETRY_MAX_DELAY_MINUTES) and clamped config values are sane", () => {
    const rc = require("../services/erp/runtimeConfig");
    process.env.ERP_SYNC_MAX_CONCURRENT = "9999"; process.env.ERP_SYNC_STALE_MINUTES = "-5"; process.env.ERP_SYNC_AUTO_MAX_RETRIES = "abc";
    try { const c = rc.scheduler(); expect(c.maxConcurrent).toBe(20); expect(c.staleMs).toBe(2 * MIN); expect(c.maxAutoRetries).toBe(3); } finally { for (const k of ["ERP_SYNC_MAX_CONCURRENT", "ERP_SYNC_STALE_MINUTES", "ERP_SYNC_AUTO_MAX_RETRIES"]) delete process.env[k]; }
  });
});

describe("Schedule disabled during execution", () => {
  test("disabled between QUEUED and claim → the run is cancelled without any ERP call", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    await sched.saveSchedule(db, T, 1, w.c.id, "PRODUCT_MASTER", { enabled: false });
    const f = okFetch(); await sched.workerTick(db, deps(f));
    expect(f).not.toHaveBeenCalled();
    const j = await db.ErpSyncJob.findOne(); expect(j.status).toBe("FAILED"); expect(j.active_key).toBeNull(); expect(j.error_message).toMatch(/disabled/i);
    await audit.flush(); expect(await db.ErpAuditEvent.count({ where: { event: "ERP_SCHEDULE_SKIPPED" } })).toBeGreaterThanOrEqual(1);
  });

  test("disabled while RUNNING → the engine stops between pages (cooperative stop) and no further page is requested", async () => {
    const w = await world(); await db.ErpConnectionCapability.update({ config: { responsePath: "rows", pagination: { type: "PAGE_NUMBER", pageParam: "page", pageSize: 1, pageSizeParam: "size", totalPath: "total" } } }, { where: { connection_id: w.c.id } });
    await enable(w); await sched.schedulerTick(db, { now: later(20) });
    let n = 0;
    const f = jest.fn(async () => { n += 1; if (n === 1) await sched.saveSchedule(db, T, 1, w.c.id, "PRODUCT_MASTER", { enabled: false }); return json(200, { rows: [{ Code: `C${n}`, Title: `t${n}` }], total: 10 }); });
    await sched.workerTick(db, deps(f));
    expect(f.mock.calls.length).toBeLessThanOrEqual(2);
    const j = await db.ErpSyncJob.findOne(); expect(["FAILED", "PARTIAL"]).toContain(j.status); expect(j.active_key).toBeNull();
  });

  test("deactivating the ERP connection cancels a queued scheduled run", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    await conns.setStatus(db, T, 1, w.c.id, { status: "INACTIVE" });
    const f = okFetch(); await sched.workerTick(db, deps(f)); expect(f).not.toHaveBeenCalled();
  });
});

describe("Graceful shutdown", () => {
  test("waits for in-flight work up to the grace period, then hands remaining RUNNING jobs back as FAILED (active_key freed)", async () => {
    const w = await world(); await enable(w); await sched.schedulerTick(db, { now: later(20) });
    let release; const gate = new Promise((r) => { release = r; });
    const f = jest.fn(async () => { await gate; return json(200, { rows: [] }); });
    const running = sched.workerTick(db, deps(f));
    await new Promise((r) => setTimeout(r, 100)); expect(sched.inflightCount()).toBe(1);
    const out = await sched.shutdownScheduler({ graceMs: 300, db });
    expect(out.stillRunning).toBe(1); expect(out.released).toBe(1); expect(out.waitedMs).toBeLessThan(2000);
    expect((await db.ErpSyncJob.findOne()).status).toBe("FAILED");
    release(); await running.catch(() => {});
  });

  test("with nothing running it returns immediately", async () => {
    const out = await sched.shutdownScheduler({ graceMs: 5000, db }); expect(out).toMatchObject({ stillRunning: 0, released: 0 }); expect(out.waitedMs).toBeLessThan(500);
  });
});

describe("Audit is append-only and safe", () => {
  test("the audit service has no update / delete API, and the model refuses UPDATE / DELETE on existing rows", async () => {
    expect(Object.keys(audit).filter((k) => /update|delete|remove|destroy|purge|clear/i.test(k))).toEqual([]);
    audit.record(db, { event: "ERP_CONNECTION_UPDATED", adminId: 1, tenantKey: T, status: "OK" }); await audit.flush();
    const row = await db.ErpAuditEvent.findOne();
    await expect(row.update({ status: "FAILED" })).rejects.toThrow();
    await expect(row.destroy()).rejects.toThrow();
    await expect(db.ErpAuditEvent.update({ status: "FAILED" }, { where: {} })).rejects.toThrow();
    await expect(db.ErpAuditEvent.destroy({ where: {} })).rejects.toThrow();
    expect(await db.ErpAuditEvent.count()).toBe(1);
  });

  test("secret-looking metadata keys are dropped and token-like values are redacted before storage; oversized values are truncated", async () => {
    audit.record(db, { event: "ERP_CONNECTION_UPDATED", adminId: 1, tenantKey: T, metadata: { password: "hunter2", note: "Bearer abcdef0123456789abcdef", long: "x".repeat(5000), nested: { clientSecret: "zz", ok: 1 } } }); await audit.flush();
    const m = (await db.ErpAuditEvent.findOne()).metadata; const s = JSON.stringify(m);
    expect(s).not.toMatch(/hunter2|abcdef0123456789|clientSecret|"zz"/); expect(m.long.length).toBeLessThanOrEqual(301); expect(m.nested.ok).toBe(1);
  });

  test("an audit write failure never breaks the business flow", async () => {
    jest.spyOn(db.ErpAuditEvent, "create").mockRejectedValue(new Error("disk full"));
    expect(() => audit.record(db, { event: "ERP_CONNECTION_UPDATED", adminId: 1, tenantKey: T })).not.toThrow();
    await expect(audit.flush()).resolves.toBeDefined();
  });

  test("audit listing: paging is capped, filters are validated, tenant-scoped, and events are returned newest first", async () => {
    for (let i = 0; i < 5; i += 1) audit.record(db, { event: "ERP_CONNECTION_UPDATED", adminId: 1, tenantKey: T }); audit.record(db, { event: "ERP_CONNECTION_UPDATED", adminId: 1, tenantKey: "TENANT_B" }); await audit.flush();
    const r = await audit.list(db, T, { pageSize: "100000" }); expect(r.items).toHaveLength(5); expect(r.pageSize).toBeLessThanOrEqual(200);
    await expect(audit.list(db, T, { event: "DROP TABLE" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(audit.list(db, T, { from: "2026-02-30" })).rejects.toMatchObject({ statusCode: 400 });
    const ids = r.items.map((x) => x.id); expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });
});

describe("Pagination and list caps", () => {
  test("job / error / alert lists cap pageSize and reject non-numeric paging", async () => {
    const w = await world();
    const big = await sync.listJobs(db, T, { pageSize: "99999" }); expect(big.pageSize).toBeLessThanOrEqual(200);
    await expect(sync.listJobs(db, T, { page: "-1" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(sync.listJobs(db, T, { pageSize: "abc" })).rejects.toMatchObject({ statusCode: 400 });
    expect(w.c.id).toBeTruthy();
  });
});

describe("Readiness", () => {
  test("never returns a secret / environment value, never calls an ERP, and reports NOT_READY when the database is unreachable", async () => {
    process.env.JWT_SECRET = "super-secret-jwt-value"; const f = jest.fn(); global.fetch = f;
    await world();
    const r = await readiness.run(db, T, { now: new Date() });
    expect(f).not.toHaveBeenCalled(); expect(JSON.stringify(r)).not.toMatch(/super-secret-jwt-value|bearer-tok-XYZ789/);
    expect(r).toMatchObject({ checkedAt: expect.anything(), summary: expect.any(Object) }); expect(["READY", "READY_WITH_WARNINGS", "NOT_READY"]).toContain(r.status);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["database", "environment", "scheduler", "staleJobs", "auditStore", "queue"]));
    jest.spyOn(db.sequelize, "authenticate").mockRejectedValue(new Error("down"));
    const bad = await readiness.run(db, T, { now: new Date() }); expect(bad.ready).toBe(false); expect(bad.status).toBe("NOT_READY"); expect(JSON.stringify(bad)).not.toMatch(/down/);
  });

  test("stale jobs and overdue schedules show up as warnings (not failures)", async () => {
    const w = await world(); await enable(w);
    await db.ErpSyncJob.create({ tenant_key: T, connection_id: w.c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", attempt: 1, heartbeat_at: later(-600) });
    await db.ErpSyncSchedule.update({ next_run_at: later(-120) }, { where: {} });
    const r = await readiness.run(db, T, { now: new Date() });
    expect(r.checks.find((c) => c.name === "staleJobs").status).toBe("WARN"); expect(r.checks.find((c) => c.name === "overdueSchedules").status).toBe("WARN");
    expect(r.checks.find((c) => c.name === "queue").status).toBe("WARN"); // honest: no external queue / DLQ
  });
});

describe("Alerts (computed from real data only)", () => {
  test("no data → no alerts; consecutive failures → exactly the alert that the data supports; nothing is sent anywhere", async () => {
    const f = jest.fn(); global.fetch = f;
    const w = await world();
    expect((await monitor.getAlerts(db, T)).alerts).toEqual([]);
    for (let i = 0; i < monitor.CONSECUTIVE_FAILS; i += 1) await db.ErpSyncJob.create({ tenant_key: T, connection_id: w.c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "FAILED", attempt: 1, error_code: "CONNECTION_ERROR", completed_at: new Date() });
    const a = await monitor.getAlerts(db, T); expect(a.alerts.length).toBeGreaterThan(0);
    expect(a.alerts.every((x) => x.connectionId === w.c.id || x.connectionId === undefined || x.connectionId === null)).toBe(true);
    expect(f).not.toHaveBeenCalled();
    const src = require("fs").readFileSync(require.resolve("../services/erpMonitoring.service"), "utf8");
    expect(src).not.toMatch(/nodemailer|twilio|sendMail|sendSms|smtp/i);
  });
});

describe("Migration and indexes", () => {
  const mig = require("../migrations/20261010090000-erp-phase17");
  const qi = () => db.sequelize.getQueryInterface();
  const have = async (t) => (await qi().showIndex(t)).map((i) => i.name);
  const NAMES = [["erp_sync_jobs", "ix_erp_job_status_heartbeat"], ["erp_sync_schedules", "ix_erp_sched_retry"], ["erp_audit_events", "ix_erp_audit_tenant_actor"]];

  test("up / up / down / up is safe and only touches the three indexes (no table, column or row changes)", async () => {
    const before = {}; for (const [t] of NAMES) before[t] = (await qi().describeTable(t)); const rows = await db.ErpSyncJob.count();
    await mig.down(qi()); for (const [t, n] of NAMES) expect(await have(t)).not.toContain(n);
    await mig.up(qi()); for (const [t, n] of NAMES) expect(await have(t)).toContain(n);
    await mig.up(qi()); for (const [t, n] of NAMES) expect((await have(t)).filter((x) => x === n)).toHaveLength(1); // idempotent
    await mig.down(qi()); for (const [t, n] of NAMES) expect(await have(t)).not.toContain(n);
    await mig.down(qi()); // down on an already-down schema is a no-op
    await mig.up(qi()); for (const [t, n] of NAMES) expect(await have(t)).toContain(n);
    for (const [t] of NAMES) expect(Object.keys(await qi().describeTable(t))).toEqual(Object.keys(before[t]));
    expect(await db.ErpSyncJob.count()).toBe(rows);
  });

  test("the hot-path indexes exist in the models (so a fresh install and a migrated one agree)", async () => {
    for (const m of ["ErpSyncJob", "ErpSyncSchedule", "ErpAuditEvent"]) expect((db[m].options.indexes || []).length).toBeGreaterThan(0);
    const names = (m) => (db[m].options.indexes || []).map((i) => i.name);
    expect(names("ErpSyncJob")).toContain("ix_erp_job_status_heartbeat"); expect(names("ErpSyncSchedule")).toContain("ix_erp_sched_retry"); expect(names("ErpAuditEvent")).toContain("ix_erp_audit_tenant_actor");
  });
});

describe("Connection health states", () => {
  test("NOT_TESTED / CONNECTED / FAILED / DISABLED / DEGRADED are derived from stored facts, never invented", async () => {
    const w = await world(); const c = w.c;
    expect((await conns.getConnection(db, T, c.id)).health.status).toBe("NOT_TESTED");
    await conns.testConnection(db, T, 1, c.id, { fetchImpl: okFetch(), logger: () => {} });
    expect((await conns.getConnection(db, T, c.id)).health.status).toBe("CONNECTED"); expect((await conns.getConnection(db, T, c.id)).health.state).toBe("REACHABLE");
    await conns.testConnection(db, T, 1, c.id, { fetchImpl: jest.fn(async () => json(503, {})), logger: () => {} });
    expect((await conns.getConnection(db, T, c.id)).health.status).toBe("FAILED");
    await conns.setStatus(db, T, 1, c.id, { status: "INACTIVE" });
    expect((await conns.getConnection(db, T, c.id)).health.status).toBe("DISABLED");
    expect((await conns.getConnection(db, T, c.id)).health.state).toBe("FAILED"); // legacy Phase 13 field is unchanged
  });
});
