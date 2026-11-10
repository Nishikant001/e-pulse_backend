// middleware/requestContext.js — Phase 17. Gives every request a correlation id (X-Correlation-ID in, or a fresh UUID), exposes it as
// req.correlationId and on the response header, and runs the rest of the request inside the async context so services and the audit trail
// can read it without parameter plumbing. Also refuses prototype-pollution keys in JSON bodies and query strings.
const ctx = require("../utils/requestContext");
const { sendError } = require("./errorHandler");

const POISON = new Set(["__proto__", "constructor", "prototype"]);
function hasPoison(v, depth = 0) {
  if (v === null || typeof v !== "object" || depth > 12) return false;
  if (Array.isArray(v)) return v.some((x) => hasPoison(x, depth + 1));
  for (const k of Object.keys(v)) { if (POISON.has(k) || hasPoison(v[k], depth + 1)) return true; }
  return false;
}

function requestContext(req, res, next) {
  const cid = ctx.sanitizeIncoming(req.get && req.get("x-correlation-id")) || ctx.newId();
  req.correlationId = cid;
  res.set("X-Correlation-ID", cid);
  ctx.run(cid, next);
}

/** Mount on /api/admin. Express 5 parses the query lazily; reading it here is safe and does not mutate it. */
function rejectDangerousKeys(req, res, next) {
  if (hasPoison(req.body) || hasPoison(req.query)) return sendError(res, req, 400, "VALIDATION_FAILED", "The request contains a field name that is not allowed.");
  return next();
}

module.exports = { requestContext, rejectDangerousKeys, hasPoison };
