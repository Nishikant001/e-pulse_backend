// services/erpReadiness.service.js — Phase 17. Production-readiness report for the ERP integration. Read-only: it inspects configuration and rows,
// it never calls an ERP and never returns a secret, an environment VALUE or a credential — only the NAMES of what is missing.
//   status per check: PASS | WARN | FAIL | SKIP        ready = no FAIL        status: READY | READY_WITH_WARNINGS | NOT_READY
const fs = require("fs");
const path = require("path");
const { Op } = require("sequelize");
const C = require("./erp/erpConstants");
const runtime = require("./erp/runtimeConfig");
const registry = require("./erp/providerRegistry");
const { credentialStatus } = require("./erp/secretResolver");
const { getAdminAuthConfig } = require("../config/adminAuth.config");
const { validateConfiguration } = require("./erpConfigValidation.service");

const isProd = () => process.env.NODE_ENV === "production";
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function run(db, tenantKey, { now = new Date(), schedulerState = null } = {}) {
  const checks = [];
  const add = (name, status, message, details) => checks.push({ name, status, message, ...(details ? { details } : {}) });

  // 1 database
  let dbOk = false;
  try { await db.sequelize.authenticate(); dbOk = true; add("database", "PASS", "The database answers."); } catch { add("database", "FAIL", "The database is not reachable."); }
  if (!dbOk) return finish(checks, now);

  // 2 environment
  add("environment", isProd() ? "PASS" : "WARN", isProd() ? "NODE_ENV is production." : `NODE_ENV is "${process.env.NODE_ENV || "unset"}", not production. Stricter URL / transport rules only apply in production.`);

  // 3 required environment variables (names only)
  const required = ["JWT_SECRET", "ADMIN_JWT_SECRET", "DB_HOST", "DB_USER", "DB_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  if (process.env.NODE_ENV === "test") add("requiredEnvironment", "SKIP", "Not evaluated in the test environment.");
  else add("requiredEnvironment", missing.length ? "FAIL" : "PASS", missing.length ? "Required environment variables are missing." : "Required environment variables are set.", missing.length ? { missing } : undefined);
  const adminCfg = getAdminAuthConfig();
  add("adminAuthentication", adminCfg.secret ? "PASS" : "FAIL", adminCfg.secret ? "The Admin signing secret is set, long enough and different from the Distributor secret." : "ADMIN_JWT_SECRET is missing, shorter than 32 characters, or equal to JWT_SECRET: the Admin portal is closed.");

  // 4 transport / network policy
  const policy = [];
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") policy.push("TLS certificate verification is switched off (NODE_TLS_REJECT_UNAUTHORIZED=0)");
  if (isProd() && process.env.ERP_ALLOW_HTTP === "true") policy.push("plain http:// ERP URLs are allowed (ERP_ALLOW_HTTP)");
  add("transportSecurity", process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? "FAIL" : policy.length ? "WARN" : "PASS", policy.length ? policy.join("; ") + "." : "TLS verification is on and http:// is not allowed in production.");
  const allowed = (process.env.ERP_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const net = [];
  if (process.env.ERP_ALLOW_PRIVATE_NETWORK === "true") net.push("private-network ERP hosts are allowed (ERP_ALLOW_PRIVATE_NETWORK)");
  if (!allowed.length) net.push("ERP_ALLOWED_HOSTS is not set, so any public host name may be saved as an ERP URL");
  add("erpNetworkPolicy", isProd() && net.length ? "WARN" : "PASS", net.length ? `${net.join("; ")}.` : "ERP hosts are restricted to the allow-list.", { privateNetworkAllowed: process.env.ERP_ALLOW_PRIVATE_NETWORK === "true", allowedHostCount: allowed.length, dnsCheck: process.env.ERP_DNS_CHECK ? process.env.ERP_DNS_CHECK === "true" : isProd() });
  add("rateLimiting", process.env.RATE_LIMIT_DISABLED === "true" ? "WARN" : "PASS", process.env.RATE_LIMIT_DISABLED === "true" ? "Rate limiting is switched off (RATE_LIMIT_DISABLED=true)." : "Rate limiting is active (per process; use the reverse proxy for a global limit).");
  const origin = process.env.CORS_ORIGIN || "http://localhost:5173";
  add("corsOrigin", isProd() && /localhost|127\.0\.0\.1/.test(origin) ? "WARN" : "PASS", isProd() && /localhost|127\.0\.0\.1/.test(origin) ? "CORS_ORIGIN still points to localhost." : "The allowed browser origin is configured.");

  // 5 migrations (only when SequelizeMeta exists; sync()-created test databases have none)
  try {
    const tables = (await db.sequelize.getQueryInterface().showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    if (!tables.includes("SequelizeMeta")) add("migrations", "SKIP", "No migration history table (SequelizeMeta) was found, so migration status cannot be determined.");
    else {
      const [rows] = await db.sequelize.query("SELECT name FROM SequelizeMeta");
      const done = new Set(rows.map((r) => r.name));
      const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".js")).sort();
      const pending = files.filter((f) => !done.has(f));
      add("migrations", pending.length ? "FAIL" : "PASS", pending.length ? `${pending.length} migration(s) have not been applied.` : "All migrations have been applied.", pending.length ? { pending: pending.slice(0, 10) } : undefined);
    }
  } catch { add("migrations", "SKIP", "Migration status could not be determined."); }

  // 6 connections
  const conns = await db.ErpConnection.findAll({ where: { tenant_key: tenantKey }, include: [{ model: db.ErpConnectionCapability, as: "capabilities", required: false }], limit: 200 });
  const active = conns.filter((c) => c.status !== "INACTIVE");
  add("connections", active.length ? "PASS" : "WARN", active.length ? `${active.length} active ERP connection(s).` : "There is no active ERP connection.");
  const credBad = []; const provBad = []; const cfgBad = [];
  for (const c of active) {
    const plain = c.get({ plain: true });
    if ((await credentialStatus(c.credential_ref, c.auth_type)) !== "RESOLVED") credBad.push(c.code);
    const key = registry.resolveProviderKey(plain); const d = key ? registry.getDescriptor(key) : null;
    if (!d || d.status !== "IMPLEMENTED") provBad.push(c.code);
    const v = validateConfiguration(plain, (plain.capabilities || []).map((x) => ({ capability: x.capability, direction: x.direction, enabled: x.enabled, endpointPath: x.endpoint_path, config: x.config, ownership: x.ownership })));
    if (v.errors.length) cfgBad.push(c.code);
  }
  add("erpCredentials", credBad.length ? "WARN" : "PASS", credBad.length ? "The server cannot resolve the credentials of some active connections." : "Credential references resolve for every active connection.", credBad.length ? { connections: credBad } : undefined);
  add("providerConfiguration", provBad.length ? "WARN" : "PASS", provBad.length ? "Some active connections have no implemented provider." : "Every active connection has an implemented provider.", provBad.length ? { connections: provBad } : undefined);
  add("connectionConfiguration", cfgBad.length ? "FAIL" : "PASS", cfgBad.length ? "Some stored connections contain an invalid configuration." : "Stored connection configurations are consistent.", cfgBad.length ? { connections: cfgBad } : undefined);
  const failed = conns.filter((c) => c.status === "ERROR").map((c) => c.code);
  add("failedConnections", failed.length ? "WARN" : "PASS", failed.length ? "Some connections failed their last test." : "No connection is in an error state.", failed.length ? { connections: failed } : undefined);
  const untested = active.filter((c) => !c.last_test_at).map((c) => c.code);
  add("untestedConnections", untested.length ? "WARN" : "PASS", untested.length ? "Some active connections have never been tested." : "Every active connection has been tested.", untested.length ? { connections: untested } : undefined);

  // 7 ownership decisions
  const undecided = active.length ? await db.ErpConnectionCapability.count({ where: { enabled: true, ownership: null, capability: C.OWNERSHIP_REQUIRED, direction: { [Op.ne]: "DISABLED" }, connection_id: active.map((c) => c.id) } }) : 0;
  add("ownershipDecisions", undecided ? "WARN" : "PASS", undecided ? `${undecided} capability(ies) wait for a business ownership decision.` : "No ownership decision is pending.", undecided ? { pending: undecided } : undefined);

  // 8 scheduler + jobs
  const schedulerOn = process.env.ERP_SCHEDULER_ENABLED !== "false";
  const st = schedulerState || { running: false };
  if (!schedulerOn) add("scheduler", "WARN", "The scheduler is disabled in this process (ERP_SCHEDULER_ENABLED=false). Make sure exactly one other process runs it.");
  else if (!st.running) add("scheduler", process.env.NODE_ENV === "test" ? "SKIP" : "WARN", "The scheduler timer is not running in this process.");
  else {
    const late = st.lastTickAt && now.getTime() - new Date(st.lastTickAt).getTime() > Math.max(st.intervalMs || 30000, 30000) * 4;
    add("scheduler", late || st.lastTickOk === false ? "WARN" : "PASS", late ? "The scheduler has not completed a pass recently." : st.lastTickOk === false ? "The last scheduler pass failed." : "The scheduler is running.", { lastTickAt: st.lastTickAt || null, intervalMs: st.intervalMs });
  }
  const cutoff = new Date(now.getTime() - runtime.scheduler().staleMs);
  const stale = await db.ErpSyncJob.count({ where: { tenant_key: tenantKey, status: ["QUEUED", "RUNNING"], heartbeat_at: { [Op.lt]: cutoff } } });
  add("staleJobs", stale ? "WARN" : "PASS", stale ? `${stale} sync job(s) show no activity and will be closed by the scheduler.` : "No stale sync jobs.", stale ? { count: stale } : undefined);
  const overdue = await db.ErpSyncSchedule.count({ where: { tenant_key: tenantKey, enabled: true, next_run_at: { [Op.lt]: new Date(now.getTime() - 20 * 60000) } } });
  add("overdueSchedules", overdue ? "WARN" : "PASS", overdue ? `${overdue} schedule(s) are more than 20 minutes overdue.` : "No schedule is overdue.", overdue ? { count: overdue } : undefined);
  add("queue", "WARN", "Jobs run on a database-backed worker inside the application process; there is no external queue or dead-letter queue (see the deployment notes).");

  // 9 audit store
  try { await db.ErpAuditEvent.count({ where: { tenant_key: tenantKey }, limit: 1 }); add("auditStore", "PASS", "The append-only audit table is reachable."); } catch { add("auditStore", "FAIL", "The audit table cannot be read."); }
  add("secretStore", process.env.NODE_ENV === "test" ? "SKIP" : isProd() ? "WARN" : "PASS", isProd() ? "Credentials are read from environment variables. Use a secret manager (Vault, AWS/Azure Key Vault) via setSecretProvider() where available." : "Environment-variable secret provider (development).");
  return finish(checks, now);
}

function finish(checks, now) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  checks.forEach((c) => { summary[c.status.toLowerCase()] += 1; });
  const ready = summary.fail === 0;
  return { ready, status: !ready ? "NOT_READY" : summary.warn ? "READY_WITH_WARNINGS" : "READY", checkedAt: now, environment: process.env.NODE_ENV || "unset", summary, checks };
}

module.exports = { run };
