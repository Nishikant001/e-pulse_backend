// middleware/errorHandler.js — Phase 17. The standard API error shape and the last-resort Express error handler.
//
//   { success:false, error:{ code, message, correlationId, details? },
//     message, code, details?, correlationId }          ← the flat keys are the pre-Phase-17 shape every existing client reads; kept on purpose
//
// Nothing here ever returns a stack trace, SQL, file path, environment value or credential: unexpected errors become a fixed
// INTERNAL_ERROR message; the detail (redacted) goes to the server log with the same correlation id.
const { redactString, redactDeep } = require("../services/erp/redaction");

const cidOf = (req) => (req && req.correlationId) || null;

function errorBody(req, status, code, message, details) {
  const cid = cidOf(req);
  const safeDetails = details === undefined ? undefined : redactDeep(details);
  return {
    success: false,
    error: { code, message, correlationId: cid, ...(safeDetails !== undefined ? { details: safeDetails } : {}) },
    message, code, ...(safeDetails !== undefined ? { details: safeDetails } : {}), correlationId: cid,
  };
}
function sendError(res, req, status, code, message, details) {
  if (res.headersSent) return res;
  if (res.set) res.set("Cache-Control", "no-store");
  return res.status(status).json(errorBody(req, status, code, message, details));
}

/** Maps any thrown value to { status, code, message, details } — fixed wording for anything unexpected. */
function describeError(err) {
  const name = err && err.name;
  if (err && err.type === "entity.too.large") return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." };
  if (err && (err.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err))) return { status: 400, code: "INVALID_JSON", message: "The request body is not valid JSON." };
  if (err && err.statusCode && err.code && name === "ErpApiError") return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  if (name === "SequelizeValidationError" || name === "SequelizeUniqueConstraintError") return { status: 400, code: "VALIDATION_FAILED", message: "The data is not valid." };
  return { status: 500, code: "INTERNAL_ERROR", message: "Unable to complete the request" };
}

/** Express error-handling middleware (4 arguments). */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const d = describeError(err);
  if (d.status >= 500) console.error(`[api-error] cid=${cidOf(req) || "-"} ${req.method} ${(req.baseUrl || "") + (req.path || "")} ${err && err.name}: ${redactString(err && err.message, 300)}`);
  return sendError(res, req, d.status, d.code, d.message, d.details);
}

/** JSON 404 for API paths that matched nothing (instead of Express's HTML page). */
function notFound(req, res) { return sendError(res, req, 404, "NOT_FOUND", "Not found"); }

module.exports = { errorBody, sendError, describeError, errorHandler, notFound };
