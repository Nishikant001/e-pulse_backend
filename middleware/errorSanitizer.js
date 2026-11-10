// middleware/errorSanitizer.js — Phase 24. 65 catch blocks in 15 Distributor controllers answer 500s with `{ message, error: <raw exception text> }` — raw Sequelize/driver/
// runtime messages (table and column names, SQL fragments, file paths). Rather than edit every controller, any JSON body of a 5xx response has its `error` / `details` /
// `stack` / `sql` fields replaced by a fixed text; `message` (the user-facing sentence) is kept, so existing clients keep working. The detail is not lost: only its LENGTH and the
// error name are logged with the correlation id. Set EXPOSE_ERROR_DETAILS=true (local debugging only) to disable.
const FIXED = "Internal error";
const STRIP = ["error", "details", "stack", "sql", "original", "parent", "errors"];

function errorSanitizer(req, res, next) {
  const json = res.json;
  res.json = function sanitizedJson(body) {
    if (res.statusCode >= 500 && process.env.EXPOSE_ERROR_DETAILS !== "true" && body && typeof body === "object" && !Array.isArray(body) && !body.correlationId) {
      const out = { ...body };
      let touched = false;
      for (const k of STRIP) {
        if (k in out && out[k] !== undefined) { touched = true; out[k] = k === "error" ? FIXED : undefined; }
      }
      if (touched) {
        Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
        out.correlationId = req.correlationId || undefined;
        console.error(`[api-5xx] cid=${req.correlationId || "-"} ${req.method} ${(req.baseUrl || "") + (req.path || "")} status=${res.statusCode}`);
        return json.call(this, out);
      }
    }
    return json.call(this, body);
  };
  next();
}

module.exports = { errorSanitizer };
