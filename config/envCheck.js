// config/envCheck.js — Phase 23. Start-up check of the environment a production deployment needs. Pure function (testable); server.js decides what to do.
// It never prints a value, only the NAME of a variable and the reason.
const REQUIRED_IN_PRODUCTION = ["JWT_SECRET", "DB_HOST", "DB_NAME", "DB_USER", "DB_DIALECT", "CORS_ORIGIN"];

function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProd = env.NODE_ENV === "production";
  const missing = (n) => !env[n] || String(env[n]).trim() === "";

  if (isProd) {
    for (const n of REQUIRED_IN_PRODUCTION) if (missing(n)) errors.push(`${n} is required in production but is not set`);
    if (!missing("JWT_SECRET") && String(env.JWT_SECRET).length < 32) errors.push("JWT_SECRET must be at least 32 characters");
    if (!missing("CORS_ORIGIN") && /localhost|127\.0\.0\.1/.test(env.CORS_ORIGIN)) warnings.push("CORS_ORIGIN points at localhost");
    if (!missing("CORS_ORIGIN") && String(env.CORS_ORIGIN).trim() === "*") errors.push("CORS_ORIGIN must not be '*' (credentialed requests)");
    if (missing("TRUST_PROXY")) warnings.push("TRUST_PROXY is not set: behind a reverse proxy, rate limits and login throttling will see the proxy address instead of the client");
    if (missing("ADMIN_JWT_SECRET")) warnings.push("ADMIN_JWT_SECRET is not set: the Admin portal will refuse sign-in (fails closed)");
    if (env.RATE_LIMIT_DISABLED === "true") warnings.push("RATE_LIMIT_DISABLED=true: request limits are switched off");
  }
  if (!missing("ADMIN_JWT_SECRET") && !missing("JWT_SECRET") && env.ADMIN_JWT_SECRET === env.JWT_SECRET) {
    warnings.push("ADMIN_JWT_SECRET equals JWT_SECRET: the Admin portal will refuse sign-in");
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateEnv, REQUIRED_IN_PRODUCTION };
