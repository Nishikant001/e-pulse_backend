// Phase 23 — API hardening: response headers, no-store, CORS list, production env validation, protected/public separation, upload filter.
// Runs the REAL server.js app (not a copy) on an ephemeral loopback port. node:http client (global.fetch is not used).
const http = require("http");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "a".repeat(48);
const { db } = require("./helpers");
const { validateEnv } = require("../config/envCheck");

let app; let server;
beforeAll(async () => { app = require("../server"); await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); }); });
afterAll(async () => { server.close(); await db.sequelize.close(); });

const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers }, (res) => {
    let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});

describe("security headers", () => {
  test("health probe carries the hardening headers and a status word only", async () => {
    const r = await call("GET", "/api/health/live");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ status: "ok" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["strict-transport-security"]).toBeUndefined(); // not production / not HTTPS
  });
  test("unknown API path → JSON 404, no-store, nothing internal", async () => {
    const r = await call("GET", "/api/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/json/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).not.toMatch(/node_modules|at .*\.js|SELECT /);
  });
  test("HSTS only in production over HTTPS", async () => {
    const { securityHeaders } = require("../middleware/securityHeaders");
    const mk = (secure) => { const h = {}; const res = { set: (a, b) => (typeof a === "object" ? Object.assign(h, a) : (h[a] = b)), getHeader: () => 1, setHeader() {}, writeHead() {} }; securityHeaders({ secure }, res, () => {}); return h; };
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { expect(mk(true)["Strict-Transport-Security"]).toMatch(/max-age=/); expect(mk(false)["Strict-Transport-Security"]).toBeUndefined(); } finally { process.env.NODE_ENV = prev; }
  });
  test("a handler's own Cache-Control is not overwritten", async () => {
    const express = require("express"); const { securityHeaders } = require("../middleware/securityHeaders");
    const a = express(); a.use(securityHeaders); a.get("/x", (q, s) => { s.set("Cache-Control", "public, max-age=60"); s.json({}); });
    const s2 = await new Promise((r) => { const x = a.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const r = await new Promise((res) => http.get({ host: "127.0.0.1", port: s2.address().port, path: "/x" }, (q) => { q.resume(); q.on("end", () => res(q.headers)); }));
      expect(r["cache-control"]).toBe("public, max-age=60");
    } finally { s2.close(); }
  });
});

describe("public/private API separation", () => {
  test.each(["/api/product", "/api/customer", "/api/stockLedger/current", "/api/admin/me"])("%s refuses an anonymous caller", async (p) => {
    const r = await call("GET", p);
    expect([401, 403]).toContain(r.status);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
  test("only /api/public/contact is public; legacy guesses stay 404 (Phase 24: endpoint now exists, see contact-phase24.test.js)", async () => {
    for (const p of ["/api/contact", "/api/enquiry"]) expect((await call("POST", p, { headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
  test("a malformed JSON body gets the standard error, not a stack trace", async () => {
    const r = await call("POST", "/api/login", { headers: { "content-type": "application/json" }, body: "{bad" });
    expect(r.status).toBe(400); expect(r.text).not.toMatch(/SyntaxError|node_modules|\.js:\d+/);
  });
  test("oversized JSON body → 413", async () => {
    const r = await call("POST", "/api/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(200000) }) });
    expect(r.status).toBe(413);
  });
});

describe("CORS", () => {
  test("allowed origin is echoed with credentials; other origins get no CORS header", async () => {
    const ok = await call("GET", "/api/health/live", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await call("GET", "/api/health/live", { headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("upload filter (Distributor bulk upload)", () => {
  const multipart = (name, content) => { const b = "----t23"; return { headers: { "content-type": `multipart/form-data; boundary=${b}` }, body: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${b}--\r\n` }; };
  const token = () => jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: 60 });
  test("a non-spreadsheet file is not stored and the existing 400 message is returned", async () => {
    const m = multipart("shell.php", "<?php ?>");
    const r = await call("POST", "/api/product/bulk-upload", { headers: { ...m.headers, authorization: `Bearer ${token()}` }, body: m.body });
    expect(r.status).toBe(400); expect(r.text).toMatch(/Excel file/);
  });
});

describe("validateEnv", () => {
  const good = { NODE_ENV: "production", JWT_SECRET: "x".repeat(40), ADMIN_JWT_SECRET: "y".repeat(40), DB_HOST: "h", DB_NAME: "n", DB_USER: "u", DB_DIALECT: "mysql", CORS_ORIGIN: "https://app.example.com", TRUST_PROXY: "1" };
  test("complete production env passes with no warnings", () => { const r = validateEnv(good); expect(r.ok).toBe(true); expect(r.warnings).toEqual([]); });
  test("missing / weak essentials fail in production, names only (no values)", () => {
    const r = validateEnv({ NODE_ENV: "production", JWT_SECRET: "short", CORS_ORIGIN: "*" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/JWT_SECRET must be at least 32/); expect(r.errors.join(" ")).toMatch(/DB_HOST/); expect(r.errors.join(" ")).toMatch(/CORS_ORIGIN must not be/);
    expect(JSON.stringify(r)).not.toContain("short\"");
  });
  test("development is never blocked", () => { expect(validateEnv({ NODE_ENV: "development" }).ok).toBe(true); });
  test("warns on localhost CORS, missing TRUST_PROXY, equal admin secret", () => {
    const r = validateEnv({ ...good, CORS_ORIGIN: "http://localhost:5173", TRUST_PROXY: "", ADMIN_JWT_SECRET: good.JWT_SECRET });
    expect(r.warnings.length).toBe(3);
  });
});

describe("Phase 24 — 5xx bodies never leak raw exception text", () => {
  const { errorSanitizer } = require("../middleware/errorSanitizer");
  const express = require("express");
  const run = async (handler, env = {}) => {
    const a = express(); a.use((q, s, n) => { q.correlationId = "cid-1"; n(); }); a.use(errorSanitizer); a.get("/x", handler);
    const s2 = await new Promise((r) => { const x = a.listen(0, "127.0.0.1", () => r(x)); });
    const prev = {}; for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
    try { return await new Promise((res) => http.get({ host: "127.0.0.1", port: s2.address().port, path: "/x" }, (q) => { let t = ""; q.on("data", (c) => (t += c)); q.on("end", () => res({ status: q.statusCode, body: JSON.parse(t) })); })); }
    finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } s2.close(); }
  };
  test("a controller-style 500 loses `error` text but keeps `message`", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await run((q, s) => s.status(500).json({ message: "Error creating batch", error: "SequelizeDatabaseError: Unknown column 'x' in 'field list' at /srv/app/models/Batch.js:12 SELECT * FROM Batches" }));
    expect(r.status).toBe(500); expect(r.body.message).toBe("Error creating batch"); expect(r.body.error).toBe("Internal error"); expect(r.body.correlationId).toBe("cid-1");
    expect(JSON.stringify(r.body)).not.toMatch(/Sequelize|SELECT|\/srv\/app|column/); expect(spy.mock.calls.flat().join(" ")).not.toMatch(/Sequelize|SELECT|Unknown column/); spy.mockRestore();
  });
  test("stack/sql/details fields are removed from 5xx", async () => {
    const r = await run((q, s) => s.status(503).json({ message: "x", stack: "at foo", sql: "SELECT 1", details: { a: 1 } }));
    expect(r.body).toEqual({ message: "x", correlationId: "cid-1" });
  });
  test("4xx and 2xx bodies are untouched", async () => {
    expect((await run((q, s) => s.status(400).json({ message: "bad", error: "field a required" }))).body.error).toBe("field a required");
    expect((await run((q, s) => s.json({ ok: true, error: null }))).body).toEqual({ ok: true, error: null });
  });
  test("EXPOSE_ERROR_DETAILS=true (local debugging) disables it", async () => {
    expect((await run((q, s) => s.status(500).json({ message: "m", error: "raw" }), { EXPOSE_ERROR_DETAILS: "true" })).body.error).toBe("raw");
  });
  test("a real controller 500 through the real app is sanitised (forced DB failure)", async () => {
    const jwt = require("jsonwebtoken"); const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: 60 });
    const spy = jest.spyOn(db.Batch, "findAll").mockRejectedValue(new Error("SQLITE_ERROR: no such table: Batches /var/www/pharma/models/Batch.js"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("GET", "/api/stock", { headers: { authorization: `Bearer ${token}` } });
    spy.mockRestore(); err.mockRestore();
    expect(r.status).toBe(500); expect(r.text).not.toMatch(/SQLITE|no such table|\/var\/www/); expect(JSON.parse(r.text).message).toBe("Error fetching batches");
  });
});

describe("Phase 24 — CSRF posture for cookie authentication", () => {
  // Cookies are httpOnly + sameSite=lax; state-changing routes read JSON only. A cross-site <form> or a "simple" fetch cannot send application/json without a CORS preflight,
  // so a forged request arrives as text/plain or urlencoded and must change nothing.
  const jwt = require("jsonwebtoken");
  const cookie = () => `access_token=${jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: 60 })}`;
  test.each([["text/plain", '{"batch_no":"X","productId":1}'], ["application/x-www-form-urlencoded", "batch_no=X&productId=1"]])("cookie-authenticated POST /api/stock as %s is not processed", async (ct, body) => {
    const r = await call("POST", "/api/stock", { headers: { cookie: cookie(), "content-type": ct, "content-length": Buffer.byteLength(body) }, body });
    expect(r.status).toBe(400); expect(r.text).toMatch(/required/i);
  });
  test("a cross-origin credentialed preflight for a foreign origin is not approved", async () => {
    const r = await call("OPTIONS", "/api/stock", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  test("auth cookies are httpOnly + sameSite=lax in the code that sets them", () => {
    const fs = require("fs"); const src = fs.readFileSync(require.resolve("../controllers/auth.controller"), "utf8");
    const blocks = src.match(/res\.cookie\([^)]*\{[\s\S]*?\}\)/g) || []; expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) { expect(b).toMatch(/httpOnly: true/); expect(b).toMatch(/sameSite: "lax"/); }
  });
});
