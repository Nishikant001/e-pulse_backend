// middleware/rateLimiter.js — Phase 17. Dependency-free fixed-window request limiter for ADMIN HTTP traffic.
//
// Scope and honesty:
//   • in-memory and per process: behind several instances each one counts separately (use a shared store such as Redis, or the reverse proxy,
//     for a global limit — documented in PHASE17_DELIVERABLES.md);
//   • it limits HTTP requests only. The in-process scheduler / worker never goes through HTTP, so internal scheduler traffic can never be
//     throttled by it (a test asserts the scheduler does not import this module);
//   • keyed by the signed-in admin id (falls back to the client IP before authentication), so one noisy admin cannot lock out another;
//   • limits are read from the environment on every request, so they can be tuned (or switched off with RATE_LIMIT_DISABLED=true) without code changes.
const { sendError } = require("./errorHandler");

const buckets = new Map(); // `${name}|${key}` → { count, resetAt }
const MAX_KEYS = 20000;

function prune(now) {
  if (buckets.size <= MAX_KEYS) return;
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  if (buckets.size > MAX_KEYS * 1.5) buckets.clear(); // last resort: never let memory grow without bound
}

/**
 * @param {string} name        bucket name (also used in the log line)
 * @param {{max:number|(()=>number), windowMs?:number, key?:(req)=>string}} o
 */
function rateLimit(name, { max, windowMs = 60000, key } = {}) {
  const limitOf = typeof max === "function" ? max : () => max;
  return function limiter(req, res, next) {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();
    const limit = limitOf();
    if (!(limit > 0)) return next();
    const now = Date.now();
    prune(now);
    const who = key ? key(req) : req.admin && req.admin.id ? `admin:${req.admin.id}` : `ip:${req.ip || "unknown"}`;
    const id = `${name}|${who}`;
    let b = buckets.get(id);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(id, b); }
    b.count += 1;
    const remaining = Math.max(0, limit - b.count);
    if (res.set) { res.set("X-RateLimit-Limit", String(limit)); res.set("X-RateLimit-Remaining", String(remaining)); }
    if (b.count > limit) {
      const wait = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      if (res.set) res.set("Retry-After", String(wait));
      console.warn(`[rate-limit] bucket=${name} who=${who.split(":")[0]} limit=${limit}/${Math.round(windowMs / 1000)}s cid=${req.correlationId || "-"}`);
      return sendError(res, req, 429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { retryAfterSeconds: wait });
    }
    return next();
  };
}
const resetRateLimits = () => buckets.clear();
const perMin = (envName, def) => () => { const n = Number(process.env[envName]); return Number.isFinite(n) && n >= 0 ? n : def; };

// Named policies (requests per minute per admin). Defaults are well above normal UI use and above anything a sync needs — a sync is ONE
// request that runs in the background, so these limits cannot slow down data synchronisation itself.
const policies = {
  read:       rateLimit("erp-read",       { max: perMin("RATE_LIMIT_ERP_READ_PER_MIN", 600) }),
  write:      rateLimit("erp-write",      { max: perMin("RATE_LIMIT_ERP_WRITE_PER_MIN", 60) }),
  test:       rateLimit("erp-test",       { max: perMin("RATE_LIMIT_ERP_TEST_PER_MIN", 10) }),   // each call makes a real request to the ERP
  sync:       rateLimit("erp-sync",       { max: perMin("RATE_LIMIT_ERP_SYNC_PER_MIN", 20) }),   // manual sync / retry / run-now
  outbound:   rateLimit("erp-outbound",   { max: perMin("RATE_LIMIT_ERP_OUTBOUND_PER_MIN", 120) }),
  audit:      rateLimit("erp-audit",      { max: perMin("RATE_LIMIT_ERP_AUDIT_PER_MIN", 60) }),  // paged, filtered search over a growing table
  heavy:      rateLimit("erp-heavy",      { max: perMin("RATE_LIMIT_ERP_HEAVY_PER_MIN", 60) }),  // summary / alerts / readiness aggregate queries
  report:     rateLimit("admin-report",   { max: perMin("RATE_LIMIT_REPORT_PER_MIN", 120) }),    // large non-ERP reports and dashboards
  distributorAuth: rateLimit("distributor-auth", { max: perMin("RATE_LIMIT_AUTH_PER_MIN", 30), key: (req) => `ip:${req.ip || "unknown"}` }), // login / signup / OTP / reset (Distributor)
  adminLogin: rateLimit("admin-login",    { max: perMin("RATE_LIMIT_LOGIN_PER_MIN", 30), key: (req) => `ip:${req.ip || "unknown"}` }),
};

module.exports = { rateLimit, policies, resetRateLimits };
