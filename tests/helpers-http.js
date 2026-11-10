// tests/helpers-http.js — Phase 17. A REAL Express app (request context → body parser → admin router → error handler) on an ephemeral
// loopback port, and a tiny HTTP client built on node:http. node:http (not fetch) on purpose: tests replace global.fetch with a mock to COUNT
// calls to the ERP, and the test client must not be counted as one.
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { db } = require("./helpers");
const { requestContext, rejectDangerousKeys } = require("../middleware/requestContext");
const { errorHandler, notFound } = require("../middleware/errorHandler");

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "a".repeat(48);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.use(bodyParser.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use("/api/admin", rejectDangerousKeys, require("../routes/adminRoutes"));
  app.use("/api", notFound);
  app.use(errorHandler);
  return app;
}
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });

let seq = 0;
/** Creates an active AdminUser with `role` and returns the session cookie for it. */
async function adminCookie(role, { active = true } = {}) {
  seq += 1;
  const a = await db.AdminUser.create({ name: `Admin ${seq}`, email: `admin${seq}-${Date.now()}@test.com`, password_hash: "x", role, is_active: active });
  const token = jwt.sign({ portal: "admin", typ: "admin_access", role }, process.env.ADMIN_JWT_SECRET, { algorithm: "HS256", subject: String(a.id), issuer: "pharma-dms-admin", audience: "admin-portal", expiresIn: 3600 });
  return { id: a.id, cookie: `adminAccessToken=${token}`, admin: a };
}

function client(server) {
  const port = server.address().port;
  return (method, path, { cookie, body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ host: "127.0.0.1", port, method, path: `/api/admin${path}`, headers: { ...(data !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

module.exports = { buildApp, listen, adminCookie, client };
