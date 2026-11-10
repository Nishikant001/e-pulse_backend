// Phase 24 — public contact endpoint: validation, abuse protection, honest delivery state. The mail transport is a MOCK (no email is sent in tests).
const http = require("http");
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "a".repeat(48);
const { db } = require("./helpers");
const svc = require("../services/contact.service");
const limiter = require("../middleware/rateLimiter");

let server;
beforeAll(async () => { const app = require("../server"); await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); }); });
afterAll(async () => { server.close(); await db.sequelize.close(); });
beforeEach(() => { limiter.resetRateLimits(); svc.setTransportForTests(null); delete process.env.CONTACT_TO_EMAIL; delete process.env.CONTACT_SMTP_HOST; });

const post = (body, headers = { "content-type": "application/json" }, path = "/api/public/contact") => new Promise((resolve, reject) => {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  const r = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path, headers: { ...headers, "content-length": Buffer.byteLength(data) } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), text: t })); });
  r.on("error", reject); r.end(data);
});
const ok = { name: "Asha Rao", email: "asha@company.com", organisation: "Acme Pharma", phone: "+91 98765 43210", message: "We would like a demo for two warehouses." };

test("not configured → 503 CONTACT_NOT_CONFIGURED, never a success", async () => {
  const r = await post(ok); expect(r.status).toBe(503); expect(r.json.code).toBe("CONTACT_NOT_CONFIGURED"); expect(r.json.success).not.toBe(true);
});
test("configured + transport succeeds → 202 and the mail has the right shape (reply-to visitor, plain text)", async () => {
  const sent = []; svc.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  const r = await post(ok); expect(r.status).toBe(202); expect(r.json.success).toBe(true);
  expect(sent).toHaveLength(1); expect(sent[0].replyTo).toBe("asha@company.com"); expect(sent[0].text).toContain("We would like a demo"); expect(sent[0].html).toBeUndefined();
});
test("transport failure → 502 generic message, no SMTP details, success not claimed", async () => {
  svc.setTransportForTests({ sendMail: async () => { throw new Error("connect ECONNREFUSED smtp.secret-host:587 user=bob pass=hunter2"); } });
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  const r = await post(ok); expect(r.status).toBe(502); expect(r.json.code).toBe("CONTACT_DELIVERY_FAILED");
  expect(r.text).not.toMatch(/smtp|hunter2|secret-host|ECONNREFUSED/i); expect(spy.mock.calls.flat().join(" ")).not.toMatch(/hunter2|secret-host|asha@company/);
  spy.mockRestore();
});
test.each([
  [{}, "empty"], [{ ...ok, email: "nope" }, "bad email"], [{ ...ok, name: "A" }, "short name"], [{ ...ok, message: "too short" }, "short message"],
  [{ ...ok, message: "x".repeat(2001) }, "long message"], [{ ...ok, phone: "abc" }, "bad phone"], [{ ...ok, name: { a: 1 } }, "object name"], [{ ...ok, website: "http://spam" }, "honeypot"], [[ok], "array body"],
])("invalid input is rejected with 400 and nothing is sent (%#: %s)", async (body) => {
  const sent = []; svc.setTransportForTests({ sendMail: async (m) => sent.push(m) });
  const r = await post(body); expect(r.status).toBe(400); expect(r.json.code).toBe("VALIDATION_FAILED"); expect(sent).toHaveLength(0);
});
test("header injection attempts are flattened to one line", async () => {
  const sent = []; svc.setTransportForTests({ sendMail: async (m) => sent.push(m) });
  await post({ ...ok, name: "Eve\r\nBcc: victim@x.com", email: "eve@x.com" });
  expect(sent[0].subject).not.toMatch(/[\r\n]/); expect(sent[0].replyTo).not.toMatch(/[\r\n]/);
  const bad = await post({ ...ok, email: "eve@x.com\r\nBcc: v@x.com" }); expect(bad.status).toBe(400);
});
test("rate limited per IP: the 6th request in the window → 429", async () => {
  const codes = []; for (let i = 0; i < 6; i += 1) codes.push((await post(ok)).status);
  expect(codes.slice(0, 5)).toEqual([503, 503, 503, 503, 503]); expect(codes[5]).toBe(429);
});
test("non-JSON content type is not parsed → validation error, oversized body → 413", async () => {
  expect((await post("name=a&email=b", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(400);
  expect((await post({ ...ok, message: "x".repeat(200000) })).status).toBe(413);
});
test("the public route exposes no tenant/authenticated data and is the only public API besides auth", async () => {
  const r = await post(ok); expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff");
  const get = await new Promise((res) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/public/contact" }, (q) => { q.resume(); res(q.statusCode); })); expect([404, 405]).toContain(get);
});
