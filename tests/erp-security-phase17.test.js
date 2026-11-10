// Phase 17 — security: RBAC, tenant isolation, SSRF, secret redaction, error shape, correlation ids, rate limiting, input hardening,
// configuration validation, connection health. RBAC / isolation / limits run through a REAL Express app (tests/helpers-http.js).
// Every ERP transport is a MOCK fetch: these tests prove our handling and that no ERP call happens when it must not — not ERP connectivity.
const { db, resetDb, mockRes } = require("./helpers");
const H = require("./helpers-http");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const audit = require("../services/erpAudit.service");
const perms = require("../config/erpPermissions");
const limiter = require("../middleware/rateLimiter");
const { validateBaseUrl, validateServicePath, assertHostSafe, classifyIp } = require("../services/erp/urlValidator");
const red = require("../services/erp/redaction");
const health = require("../services/erpConfigValidation.service");

const T = "DEFAULT";
let server; let call; let fetchMock; let infoSpy; let errSpy; let warnSpy; let logged;

beforeAll(async () => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789", ERP_SAPPROD_USERNAME: "SAPUSER", ERP_SAPPROD_PASSWORD: "S3cr3t-Pa55word!" }); server = await H.listen(H.buildApp()); call = H.client(server); });
afterAll(async () => { server.close(); await audit.flush(); await db.sequelize.close(); });
beforeEach(async () => {
  await resetDb(); limiter.resetRateLimits(); require("../middleware/erpAccess")._resetDenyThrottle(); delete process.env.ERP_TENANT_KEY;
  logged = [];
  const sink = (...a) => { logged.push(a.map(String).join(" ")); };
  infoSpy = jest.spyOn(console, "info").mockImplementation(sink); errSpy = jest.spyOn(console, "error").mockImplementation(sink); warnSpy = jest.spyOn(console, "warn").mockImplementation(sink);
  fetchMock = jest.fn(async () => { throw new Error("ERP must not be called in this test"); }); global.fetch = fetchMock;
});
afterEach(() => { jest.restoreAllMocks(); });

const hdrs = (h = {}) => ({ get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : h[n.toLowerCase()] || null), getSetCookie: () => [] });
const okJson = (obj, status = 200) => ({ status, text: async () => JSON.stringify(obj), headers: hdrs() });
const cap = (capability, endpointPath, o = {}) => ({ capability, endpointPath, direction: "ERP_TO_DMS", config: { responsePath: "rows", pagination: { type: "NONE" } }, ...o });
const mkConn = (o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: [cap("PRODUCT_MASTER", "/p")], ...o });
const PROD_MAP = [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }];
const scopeFor = async () => { const d = await require("./helpers").seedDistributor(); const h = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id }); return { distributorId: d.id, hsnId: h.id }; };
const as = async (role) => (await H.adminCookie(role)).cookie;

// ══════════════════════════════ RBAC ══════════════════════════════
// [method, path, permission(s) that grant it]. ":id" etc. are real ids filled in below; the request body is empty on purpose — a request that
// PASSES authorization may then fail validation (400/404/409…), but it must never answer 401/403.
const MATRIX = (id, jobId, schedId) => [
  ["GET", "/erp-integrations/lookups", ["ERP_VIEW"]], ["GET", "/erp-integrations/health/readiness", ["ERP_VIEW"]], ["GET", "/erp-integrations", ["ERP_VIEW"]],
  ["POST", "/erp-integrations", ["ERP_MANAGE"]], ["GET", `/erp-integrations/${id}`, ["ERP_VIEW"]], ["PUT", `/erp-integrations/${id}`, ["ERP_MANAGE"]],
  ["PATCH", `/erp-integrations/${id}/status`, ["ERP_MANAGE"]], ["PATCH", `/erp-integrations/${id}/default`, ["ERP_MANAGE"]],
  ["POST", `/erp-integrations/${id}/test`, ["ERP_MANAGE", "ERP_SYNC"]],
  ["GET", `/erp-integrations/${id}/mappings/PRODUCT_MASTER`, ["ERP_VIEW"]], ["PUT", `/erp-integrations/${id}/mappings/PRODUCT_MASTER`, ["ERP_MANAGE"]],
  ["GET", "/erp-sync/summary", ["ERP_VIEW"]], ["GET", "/erp-sync/jobs", ["ERP_VIEW"]], ["POST", "/erp-sync/jobs", ["ERP_SYNC"]],
  ["GET", `/erp-sync/jobs/${jobId}`, ["ERP_VIEW"]], ["GET", `/erp-sync/jobs/${jobId}/errors`, ["ERP_VIEW"]], ["POST", `/erp-sync/jobs/${jobId}/retry`, ["ERP_RETRY"]],
  ["GET", "/erp-sync/errors", ["ERP_VIEW"]], ["GET", "/erp-sync/schedules", ["ERP_VIEW"]], ["GET", `/erp-sync/schedules/${schedId}`, ["ERP_VIEW"]],
  ["POST", `/erp-sync/schedules/${schedId}/run`, ["ERP_SYNC"]], ["PUT", `/erp-integrations/${id}/schedules/PRODUCT_MASTER`, ["ERP_SCHEDULE"]],
  ["GET", "/erp-sync/audit", ["ERP_AUDIT"]], ["GET", "/erp-sync/alerts", ["ERP_VIEW"]],
  ["GET", `/erp-integrations/${id}/code-mappings?type=PAYMENT_MODE`, ["ERP_VIEW"]], ["PUT", `/erp-integrations/${id}/code-mappings`, ["ERP_MANAGE"]], ["DELETE", `/erp-integrations/${id}/code-mappings/999`, ["ERP_MANAGE"]],
  ["POST", "/erp-sync/outbound", ["ERP_SYNC"]], ["GET", "/erp-sync/outbound", ["ERP_VIEW"]],
  // Phase 18 (rows ADDED; no existing row changed)
  ["GET", "/erp-sync/business/overview", ["ERP_VIEW"]], ["POST", "/erp-sync/reconciliation", ["ERP_SYNC"]], ["GET", "/erp-sync/reconciliation", ["ERP_VIEW"]],
];
const ROLES = ["SUPER_ADMIN", "ERP_ADMIN", "ERP_OPERATOR", "ERP_VIEWER", "ADMIN", "SALES_EXEC", ""];

describe("ERP RBAC (server-side, every route)", () => {
  test("permission table matches the specification; unknown roles get nothing; legacy ADMIN keeps full ERP access", () => {
    expect(perms.PERMISSIONS).toEqual(["ERP_VIEW", "ERP_MANAGE", "ERP_SYNC", "ERP_RETRY", "ERP_SCHEDULE", "ERP_AUDIT"]);
    expect(perms.permissionsForRole("SUPER_ADMIN")).toEqual(perms.PERMISSIONS);
    expect(perms.permissionsForRole("ERP_ADMIN")).toEqual(perms.PERMISSIONS);
    expect(perms.permissionsForRole("ERP_OPERATOR")).toEqual(["ERP_VIEW", "ERP_SYNC", "ERP_RETRY"]);
    expect(perms.permissionsForRole("ERP_VIEWER")).toEqual(["ERP_VIEW", "ERP_AUDIT"]);
    expect(perms.permissionsForRole("ADMIN")).toEqual(perms.PERMISSIONS); // compatibility: nobody loses access on upgrade
    expect(perms.permissionsForRole("erp_operator")).toEqual(["ERP_VIEW", "ERP_SYNC", "ERP_RETRY"]); // case-insensitive
    for (const r of ["SALES_EXEC", "", null, undefined, "ERP_ADMINISTRATOR", "super admin"]) expect(perms.permissionsForRole(r)).toEqual([]);
  });

  test("full matrix: every ERP route × every role — 401 without a session, 403 without the permission, never 401/403 with it", async () => {
    const c = await mkConn(); const job = await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "FAILED", attempt: 1 });
    const sch = await db.ErpSyncSchedule.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", frequency: "HOURLY", enabled: false });
    const rows = MATRIX(c.id, job.id, sch.id);
    // every registered ERP route is covered by the matrix (so a new route cannot be added without a test row)
    const registered = require("../routes/adminRoutes").stack.filter((l) => l.route && /^\/erp-(integrations|sync)/.test(l.route.path)).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
    const norm = (p) => p.replace(/\?.*$/, "").replace(/\/\d+/g, "/:id").replace(/\/(PRODUCT_MASTER)/g, "/:capability");
    const covered = new Set(rows.map(([m, p]) => `${m} ${norm(p)}`));
    const wanted = registered.map((r) => r.replace(/:id|:mappingId|:capability/g, (x) => (x === ":capability" ? ":capability" : ":id")));
    for (const r of wanted) expect(covered.has(r)).toBe(true);
    expect(registered.length).toBe(rows.length);

    const cookies = {}; for (const r of ROLES) cookies[r] = r ? await as(r) : await as("");
    for (const [method, path, grants] of rows) {
      const anon = await call(method, path, { body: method === "GET" ? undefined : {} });
      expect([method, path, anon.status]).toEqual([method, path, 401]);
      for (const role of ROLES) {
        const allowed = grants.some((g) => perms.permissionsForRole(role).includes(g));
        const r = await call(method, path, { cookie: cookies[role], body: method === "GET" ? undefined : {} });
        if (allowed) expect([role, method, path, r.status === 401 || r.status === 403]).toEqual([role, method, path, false]);
        else expect([role, method, path, r.status]).toEqual([role, method, path, 403]);
        if (r.status === 403) {
          expect(r.json).toMatchObject({ success: false, code: "FORBIDDEN", message: "You don't have permission to perform this action.", error: { code: "FORBIDDEN" } });
          expect(JSON.stringify(r.json)).not.toMatch(/ERP_[A-Z]+|role|SUPER_ADMIN|permission"/); // no hint about WHICH permission / role would have worked
        }
      }
    }
  }, 120000);

  test("a role change applies to the very next request, and a deactivated admin is refused immediately (role is read from the database, not the token)", async () => {
    const a = await H.adminCookie("ERP_VIEWER");
    expect((await call("POST", "/erp-integrations", { cookie: a.cookie, body: {} })).status).toBe(403);
    await a.admin.update({ role: "ERP_ADMIN" });
    expect((await call("POST", "/erp-integrations", { cookie: a.cookie, body: {} })).status).toBe(400); // authorised now → validation error
    await a.admin.update({ role: "ERP_VIEWER" });
    expect((await call("POST", "/erp-integrations", { cookie: a.cookie, body: {} })).status).toBe(403);
    await a.admin.update({ is_active: false });
    expect((await call("GET", "/erp-integrations", { cookie: a.cookie })).status).toBe(401);
  });

  test("a denied request is audited (throttled), without leaking the permission to the caller", async () => {
    const a = await H.adminCookie("ERP_VIEWER");
    for (let i = 0; i < 3; i += 1) await call("POST", "/erp-integrations", { cookie: a.cookie, body: {} });
    await audit.flush();
    const ev = await db.ErpAuditEvent.findAll({ where: { event: "ERP_ACCESS_DENIED" } });
    expect(ev).toHaveLength(1); // 3 identical denials inside a minute → one row
    expect(ev[0]).toMatchObject({ actor_admin_id: a.id, status: "FAILED" }); expect(ev[0].correlation_id).toBeTruthy();
    expect(ev[0].metadata).toMatchObject({ method: "POST" });
  });

  test("the Distributor session cannot satisfy ERP authorization and non-ERP admin routes keep their old behaviour (any active admin)", async () => {
    const jwt = require("jsonwebtoken"); const d = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    expect((await call("GET", "/erp-integrations", { cookie: `adminAccessToken=${d}` })).status).toBe(401);
    expect((await call("GET", "/erp-integrations", { headers: { Authorization: `Bearer ${d}` } })).status).toBe(401);
    const odd = await H.adminCookie("SALES_EXEC"); // role with NO ERP permission still uses the other admin modules exactly as before
    expect((await call("GET", "/me", { cookie: odd.cookie })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: odd.cookie })).json.admin.erpPermissions).toEqual([]);
    const v = await H.adminCookie("ERP_VIEWER"); expect((await call("GET", "/session", { cookie: v.cookie })).json.admin.erpPermissions).toEqual(["ERP_VIEW", "ERP_AUDIT"]);
  });

  test("route consistency: every Admin route requires requireAdmin (except login / logout / session); every Distributor route needs auth except the auth endpoints", () => {
    const requireAdmin = require("../middleware/adminAuth"); const authMw = require("../middleware/auth.middleware");
    const ar = require("../routes/adminRoutes").stack.filter((l) => l.route);
    expect(ar.filter((l) => !l.route.stack.some((s) => s.handle === requireAdmin)).map((l) => l.route.path).sort()).toEqual(["/login", "/logout", "/session"]);
    const dr = require("../routes/allRoutes").stack.filter((l) => l.route);
    expect(dr.filter((l) => !l.route.stack.some((s) => s.handle === authMw)).map((l) => l.route.path).sort()).toEqual(["/forgot-password", "/login", "/logout", "/refresh-token", "/reset-password", "/signup", "/verify-otp"]);
    // every ERP route also has the ERP permission layer right after requireAdmin
    for (const l of ar.filter((x) => /^\/erp-(integrations|sync)/.test(x.route.path))) expect(l.route.stack[1].name).toBe("erpPermission");
  });
});

// ═════════════════════════ TENANT ISOLATION ═════════════════════════
describe("Tenant isolation — a foreign resource is a 404 and the ERP is never contacted", () => {
  test("Tenant A session against Tenant B's connection, sync, mapping, code mapping, schedule, outbound, audit, jobs", async () => {
    // Tenant B owns everything
    const b = await mkConn({ name: "B ERP" }, "TENANT_B"); await sync.saveMappings(db, "TENANT_B", 1, b.id, "PRODUCT_MASTER", { mappings: PROD_MAP });
    const bJob = await db.ErpSyncJob.create({ tenant_key: "TENANT_B", connection_id: b.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "FAILED", attempt: 1 });
    const bSched = await db.ErpSyncSchedule.create({ tenant_key: "TENANT_B", connection_id: b.id, capability: "PRODUCT_MASTER", frequency: "HOURLY", enabled: true, next_run_at: new Date(Date.now() + 3600000) });
    await audit.record(db, { event: "ERP_SYNC_STARTED", tenantKey: "TENANT_B", conn: b }); await audit.flush();
    const bLink = await db.ErpExternalLink.create({ tenant_key: "TENANT_B", connection_id: b.id, entity_type: "CODE_PAYMENT_MODE", external_id: "01", scope_key: "", dms_entity_id: 0, dms_value: "CASH" });
    // Tenant A (the default tenant of this server) is the caller
    const admin = await as("SUPER_ADMIN"); const before = fetchMock.mock.calls.length;
    const probes = [
      ["GET", `/erp-integrations/${b.id}`], ["PUT", `/erp-integrations/${b.id}`, { name: "hijack" }], ["PATCH", `/erp-integrations/${b.id}/status`, { status: "INACTIVE" }],
      ["PATCH", `/erp-integrations/${b.id}/default`, {}], ["POST", `/erp-integrations/${b.id}/test`, {}],
      ["GET", `/erp-integrations/${b.id}/mappings/PRODUCT_MASTER`], ["PUT", `/erp-integrations/${b.id}/mappings/PRODUCT_MASTER`, { mappings: PROD_MAP }],
      ["POST", "/erp-sync/jobs", { connectionId: b.id, capability: "PRODUCT_MASTER" }], ["GET", `/erp-sync/jobs/${bJob.id}`], ["GET", `/erp-sync/jobs/${bJob.id}/errors`], ["POST", `/erp-sync/jobs/${bJob.id}/retry`, {}],
      ["GET", `/erp-sync/schedules/${bSched.id}`], ["POST", `/erp-sync/schedules/${bSched.id}/run`, {}], ["PUT", `/erp-integrations/${b.id}/schedules/PRODUCT_MASTER`, { frequency: "HOURLY", enabled: false }],
      ["GET", `/erp-integrations/${b.id}/code-mappings?type=PAYMENT_MODE`], ["PUT", `/erp-integrations/${b.id}/code-mappings`, { type: "PAYMENT_MODE", externalCode: "02", dmsValue: "UPI" }], ["DELETE", `/erp-integrations/${b.id}/code-mappings/${bLink.id}`],
      ["POST", "/erp-sync/outbound", { connectionId: b.id, capability: "CUSTOMER_MASTER", entityId: 1 }],
    ];
    for (const [m, p, body] of probes) { const r = await call(m, p, { cookie: admin, body }); expect([m, p, r.status]).toEqual([m, p, 404]); expect(r.json.code).toBe("NOT_FOUND"); }
    expect(fetchMock.mock.calls.length).toBe(before); // ZERO ERP calls
    // lists show nothing of tenant B
    expect((await call("GET", "/erp-integrations", { cookie: admin })).json.items).toEqual([]);
    expect((await call("GET", "/erp-sync/jobs", { cookie: admin })).json.total).toBe(0);
    expect((await call("GET", "/erp-sync/schedules", { cookie: admin })).json.items).toEqual([]);
    expect((await call("GET", "/erp-sync/errors", { cookie: admin })).json.total).toBe(0);
    expect((await call("GET", "/erp-sync/outbound", { cookie: admin })).json.total).toBe(0);
    const aud = await call("GET", "/erp-sync/audit", { cookie: admin }); expect(aud.json.items.some((e) => e.connectionId === b.id)).toBe(false);
    // and nothing of B changed
    const fresh = await db.ErpConnection.findByPk(b.id); expect(fresh.name).toBe("B ERP"); expect(fresh.status).toBe("ACTIVE");
    expect(await db.ErpExternalLink.count({ where: { id: bLink.id } })).toBe(1);
  });

  test("the tenant comes from the session, never from body / query / headers", async () => {
    const b = await mkConn({ name: "B ERP" }, "TENANT_B"); const admin = await as("ERP_ADMIN");
    const r = await call("GET", `/erp-integrations?tenantKey=TENANT_B&tenant_key=TENANT_B`, { cookie: admin, headers: { "X-Tenant-Key": "TENANT_B" } });
    expect(r.json.items).toEqual([]);
    const g = await call("GET", `/erp-integrations/${b.id}?tenantKey=TENANT_B`, { cookie: admin }); expect(g.status).toBe(404);
    process.env.ERP_TENANT_KEY = "TENANT_B"; // the same admin on a deployment whose session resolves to tenant B
    expect((await call("GET", `/erp-integrations/${b.id}`, { cookie: admin })).status).toBe(200);
  });

  test("a scheduler / engine run is bound to the JOB's tenant: a job of tenant A can never load tenant B's connection", async () => {
    const b = await mkConn({ name: "B ERP" }, "TENANT_B"); await sync.saveMappings(db, "TENANT_B", 1, b.id, "PRODUCT_MASTER", { mappings: PROD_MAP });
    const job = await db.ErpSyncJob.create({ tenant_key: T, connection_id: b.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "QUEUED", trigger_type: "MANUAL", attempt: 1 });
    const { runSync } = require("../services/erp/sync/syncEngine");
    const done = await runSync(db, job.id, { fetchImpl: fetchMock, logger: () => {} });
    expect(done.status).toBe("FAILED"); expect(done.error_code).toBe("INVALID_CONFIGURATION"); expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════ SSRF ═══════════════════════════════
describe("ERP URL / SSRF protection", () => {
  const withEnv = (env, fn) => {
    const prev = {}; for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
    let out; try { out = fn(); } catch (e) { restore(); throw e; }
    if (out && typeof out.then === "function") return out.finally(restore);
    restore(); return out;
  };
  const PROD = { NODE_ENV: "production", ERP_ALLOW_PRIVATE_NETWORK: undefined, ERP_ALLOW_HTTP: undefined, ERP_ALLOWED_HOSTS: undefined };

  test.each([
    "https://localhost", "https://LOCALHOST:8443", "https://127.0.0.1", "https://127.1.2.3", "http://2130706433", "https://0x7f.0.0.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]",
    "https://0.0.0.0", "https://[::]", "https://169.254.169.254/latest/meta-data", "https://[fe80::1]", "https://metadata.google.internal", "https://metadata",
    "https://10.0.0.5", "https://172.16.0.1", "https://172.31.255.255", "https://192.168.1.10:8443", "https://100.64.0.1", "https://[fd12:3456::1]", "https://[64:ff9b::7f00:1]", "https://[2002:7f00:1::]",
    "https://224.0.0.1", "https://255.255.255.255", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://erp.example.com", "gopher://erp.example.com", "https://user:pw@erp.example.com", "https://erp.example.com/x?token=1", "https://erp.example.com/#frag", "https://erp.local", "https://erp.internal", "https://svc.localhost", "http://erp.example.com",
  ])("production refuses %s", (u) => { withEnv(PROD, () => expect(() => validateBaseUrl(u)).toThrow()); });

  test("production accepts a normal public https URL and canonicalises it; public IP literals are fine", () => withEnv(PROD, () => {
    expect(validateBaseUrl("https://SAP.Example.com:44300/base/")).toBe("https://sap.example.com:44300/base");
    expect(validateBaseUrl("https://8.8.8.8")).toBe("https://8.8.8.8"); expect(validateBaseUrl("https://172.32.0.1")).toBe("https://172.32.0.1");
  }));

  test("link-local, metadata and unspecified addresses are refused in EVERY environment and even with every opt-in switched on", () => {
    withEnv({ NODE_ENV: "development", ERP_ALLOW_PRIVATE_NETWORK: "true", ERP_ALLOW_HTTP: "true" }, () => { for (const u of ["https://169.254.169.254", "https://0.0.0.0", "https://[fe80::1]", "https://metadata.google.internal", "file:///x", "https://224.0.0.1"]) expect(() => validateBaseUrl(u)).toThrow(); });
    withEnv({ NODE_ENV: "production", ERP_ALLOW_PRIVATE_NETWORK: "true" }, () => { expect(() => validateBaseUrl("https://127.0.0.1")).toThrow(); expect(() => validateBaseUrl("https://169.254.169.254")).toThrow(); });
  });

  test("on-premise / VPN policy: private ranges only with ERP_ALLOW_PRIVATE_NETWORK=true; the allow-list narrows further; development keeps working", () => {
    withEnv({ ...PROD, ERP_ALLOW_PRIVATE_NETWORK: "true" }, () => { expect(validateBaseUrl("https://10.1.2.3:44300")).toBe("https://10.1.2.3:44300"); expect(validateBaseUrl("https://sap.corp.local")).toBe("https://sap.corp.local"); expect(() => validateBaseUrl("https://localhost")).toThrow(); });
    withEnv({ ...PROD, ERP_ALLOW_PRIVATE_NETWORK: "true", ERP_ALLOWED_HOSTS: "10.1.2.3,sap.example.com" }, () => { expect(validateBaseUrl("https://10.1.2.3")).toBe("https://10.1.2.3"); expect(() => validateBaseUrl("https://10.9.9.9")).toThrow(/allowed ERP host list/); expect(() => validateBaseUrl("https://other.example.com")).toThrow(/allowed ERP host list/); });
    withEnv({ NODE_ENV: "development", ERP_ALLOW_PRIVATE_NETWORK: undefined, ERP_ALLOWED_HOSTS: undefined }, () => { expect(validateBaseUrl("http://localhost:3001")).toBe("http://localhost:3001"); expect(validateBaseUrl("http://192.168.0.7:8000")).toBe("http://192.168.0.7:8000"); });
  });

  test("service paths: traversal, encoded traversal, query, backslash, control characters are refused", () => {
    for (const p of ["/a/../b", "/a//b", "/a?x=1", "/a#x", "/a\\b", "/a b", "/a/%2e%2e/b", "/a%2Fb", "/a%5Cb", "/a%00", "a/b", `/${"x".repeat(300)}`]) expect(() => validateServicePath(p)).toThrow();
    expect(validateServicePath("/sap/opu/odata/sap/X/")).toBe("/sap/opu/odata/sap/X");
  });

  test("DNS check: a public-looking name that resolves to an internal address is refused; a public answer passes; resolution failure is a connection error", async () => {
    const r = (list) => async () => list.map((address) => ({ address }));
    await expect(assertHostSafe("https://erp.example.com", { resolver: r(["169.254.169.254"]) })).rejects.toThrow();
  });
  test("DNS check (production policy)", async () => withEnv({ NODE_ENV: "production", ERP_ALLOW_PRIVATE_NETWORK: undefined }, async () => {
    const r = (list) => async () => list.map((address) => ({ address }));
    await expect(assertHostSafe("https://erp.example.com", { resolver: r(["10.0.0.1"]) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(assertHostSafe("https://erp.example.com", { resolver: r(["93.184.216.34", "127.0.0.1"]) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" }); // ANY bad answer refuses
    await expect(assertHostSafe("https://erp.example.com", { resolver: r(["93.184.216.34", "2606:2800:220:1::1"]) })).resolves.toBeUndefined();
    await expect(assertHostSafe("https://erp.example.com", { resolver: async () => { throw new Error("ENOTFOUND"); } })).rejects.toMatchObject({ code: "CONNECTION_ERROR" });
    await expect(assertHostSafe("https://8.8.8.8", { resolver: async () => { throw new Error("never called for literals"); } })).resolves.toBeUndefined();
  }));

  test("connection test with a host that resolves internally is refused BEFORE credentials are resolved or any request is made", async () => withEnv({ NODE_ENV: "production" }, async () => {
    const c = await mkConn(); // created while NODE_ENV=production → URL validated by the production rules
    const spy = jest.spyOn(require("../services/erp/secretResolver"), "resolveCredentials");
    const res = await conns.testConnection(db, T, 1, c.id, { fetchImpl: fetchMock, logger: () => {}, resolver: async () => [{ address: "10.0.0.9" }] });
    expect(res.ok).toBe(false); expect(res.status).toBe("FAILED"); expect(res.code).toBe("INVALID_CONFIGURATION");
    expect(fetchMock).not.toHaveBeenCalled(); expect(spy).not.toHaveBeenCalled();
  }));

  test("redirects are never followed: a 302 is an error, exactly one request is made, and manual redirect mode is used", async () => {
    const c = await mkConn(); const f = jest.fn(async () => ({ status: 302, text: async () => "", headers: { get: (n) => (n.toLowerCase() === "location" ? "http://169.254.169.254/latest" : null), getSetCookie: () => [] } }));
    const res = await conns.testConnection(db, T, 1, c.id, { fetchImpl: f, logger: () => {} });
    expect(res.ok).toBe(false); expect(f).toHaveBeenCalledTimes(1); expect(f.mock.calls[0][1].redirect).toBe("manual");
    expect(JSON.stringify(res)).not.toContain("169.254");
  });
  test("a next-page link to another host is not followed", async () => {
    const c = await mkConn({ capabilities: [cap("PRODUCT_MASTER", "/p", { config: { responsePath: "rows", pagination: { type: "NEXT_URL", nextPath: "next" } } })] });
    await sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: PROD_MAP });
    const f = jest.fn(async () => okJson({ rows: [{ Code: "A", Title: "a" }], next: "https://evil.example.net/steal" }));
    const job = await sync.startSync(db, T, 1, { connectionId: c.id, capability: "PRODUCT_MASTER", scope: await scopeFor() }, { await: true, fetchImpl: f, logger: () => {}, retryDelayMs: 0 });
    expect(f.mock.calls.every(([u]) => new URL(u).host === "custom.example.com")).toBe(true); expect(["PARTIAL", "FAILED", "SUCCESS"]).toContain(job.status);
  });
  test("classifyIp covers IPv4 / IPv6 edge forms", () => {
    expect([classifyIp("127.0.0.1"), classifyIp("10.2.3.4"), classifyIp("169.254.1.1"), classifyIp("8.8.8.8"), classifyIp("::1"), classifyIp("::"), classifyIp("fc00::1"), classifyIp("fe80::abcd"), classifyIp("2606:4700::1111"), classifyIp("::ffff:10.0.0.1"), classifyIp("garbage")])
      .toEqual(["loopback", "private", "linklocal", null, "loopback", "unspecified", "private", "linklocal", null, "private", "reserved"]);
  });
});

// ═════════════════════════ SECRETS & LOGGING ═════════════════════════
describe("Secret / credential protection", () => {
  const SECRETS = ["S3cr3t-Pa55word!", "bearer-tok-XYZ789", "SAPUSER", Buffer.from("SAPUSER:S3cr3t-Pa55word!").toString("base64"), "csrf-token-123", "SESSIONCOOKIE=abc999"];

  test("redaction primitives mask passwords, tokens, authorization, cookies, CSRF and URL credentials, in strings and nested objects", () => {
    const s = red.redactString("x Authorization: Basic QUJDREVGR0g= password=Hunter2 token: abcdef clientSecret=zz Cookie: sid=1; a=b x-csrf-token: T0K3N https://u:p@host/x refreshToken=r1");
    for (const bad of ["QUJDREVGR0g=", "Hunter2", "abcdef", "zz", "sid=1", "T0K3N", "u:p@", "r1"]) expect(s).not.toContain(bad);
    const o = red.redactDeep({ ok: "fine", password: "p", nested: { apiKey: "k", accessToken: "t", refresh_token: "r", csrf: "c", cookie: "c", Authorization: "a", clientSecret: "s", list: [{ secret: "x" }, "Bearer abcdefghij"] }, note: "password=oops" });
    expect(JSON.stringify(o)).not.toMatch(/"p"|"k"|"t"|"r"|"c"|"a"|"s"|"x"|abcdefghij|oops/); expect(o.ok).toBe("fine");
    for (const k of ["password", "secret", "token", "authorization", "cookie", "apiKey", "clientSecret", "accessToken", "refreshToken", "csrf"]) expect(red.isSecretKey(k)).toBe(true);
    for (const k of ["name", "capability", "status", "author"]) expect(red.isSecretKey(k)).toBe(false);
  });

  test("audit metadata drops secret-named keys and masks secret-looking values", async () => {
    await audit.record(db, { event: "ERP_SYNC_STARTED", tenantKey: T, metadata: { password: "P", apiKey: "K", note: "token=abc123 ok", authorization: "Bearer zzzzzzzz", keep: "yes" } }); await audit.flush();
    const row = await db.ErpAuditEvent.findOne(); const dump = JSON.stringify(row.metadata);
    expect(dump).not.toMatch(/"P"|"K"|abc123|zzzzzzzz/); expect(row.metadata.keep).toBe("yes");
  });

  test("end to end: a connection test, a failed test, a sync and an HTTP round trip never put a credential in logs, API responses, audit rows or error rows", async () => {
    const admin = await as("SUPER_ADMIN");
    const c = await mkConn({ capabilities: [cap("PRODUCT_MASTER", "/p")] });
    await call("PUT", `/erp-integrations/${c.id}/mappings/PRODUCT_MASTER`, { cookie: admin, body: { mappings: PROD_MAP } });
    const responses = [];
    // success path with a server that echoes secrets back at us
    global.fetch = jest.fn(async (url, init) => okJson({ rows: [{ Code: "A", Title: `echo ${init.headers.Authorization} Cookie: SESSIONCOOKIE=abc999 x-csrf-token: csrf-token-123` }] }));
    responses.push(await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} }));
    // failing path whose error text contains every secret
    global.fetch = jest.fn(async () => { throw new Error(`socket hang up Authorization: Bearer bearer-tok-XYZ789 password=S3cr3t-Pa55word! user=SAPUSER Cookie: SESSIONCOOKIE=abc999 x-csrf-token: csrf-token-123`); });
    responses.push(await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} }));
    const d = await require("./helpers").seedDistributor();
    responses.push(await call("POST", "/erp-sync/jobs", { cookie: admin, body: { connectionId: c.id, capability: "PRODUCT_MASTER", scope: await scopeFor() } }));
    await new Promise((r) => setTimeout(r, 400));
    for (const p of ["/erp-integrations", `/erp-integrations/${c.id}`, "/erp-sync/jobs", "/erp-sync/errors", "/erp-sync/audit?pageSize=100", "/erp-sync/summary", "/erp-sync/alerts", "/erp-integrations/health/readiness"]) responses.push(await call("GET", p, { cookie: admin }));
    await audit.flush();
    const everything = JSON.stringify(responses.map((r) => [r.text])) + logged.join("\n") + JSON.stringify((await db.ErpAuditEvent.findAll()).map((r) => r.get({ plain: true }))) + JSON.stringify((await db.ErpSyncError.findAll()).map((r) => r.get({ plain: true }))) + JSON.stringify((await db.ErpSyncJob.findAll()).map((r) => r.get({ plain: true }))) + JSON.stringify((await db.ErpConnection.findAll()).map((r) => r.get({ plain: true })));
    for (const s of SECRETS) expect(everything).not.toContain(s);
    expect(logged.length).toBeGreaterThan(0); // we really did capture log output
    expect(responses.filter((r) => r.json && r.json.credentials).every((r) => Object.keys(r.json.credentials).sort().join() === "reference,status")).toBe(true);
    const detail = await call("GET", `/erp-integrations/${c.id}`, { cookie: admin }); expect(detail.json.credentials).toEqual({ reference: "RESTBEARER", status: "RESOLVED" });
  }, 60000);

  test("credentials cannot be submitted through the API: secret-looking fields are refused, not silently ignored", async () => {
    const admin = await as("ERP_ADMIN");
    for (const k of ["password", "secret", "token", "apiKey", "clientSecret", "accessToken", "Authorization", "cookie"]) {
      const r = await call("POST", "/erp-integrations", { cookie: admin, body: { name: "X", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://x.example.com", [k]: "hunter2" } });
      expect([k, r.status]).toEqual([k, 400]); expect(r.json.code).toBe("VALIDATION_FAILED"); expect(r.text).not.toContain("hunter2");
    }
    expect(await db.ErpConnection.count()).toBe(0);
  });
  test("provider capability config cannot carry credentials either (query secrets, unknown keys)", async () => {
    const admin = await as("ERP_ADMIN");
    const r = await call("POST", "/erp-integrations", { cookie: admin, body: { name: "X", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://x.example.com", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/p", config: { query: { api_key: "zzz" } } }] } });
    expect(r.status).toBe(400); expect(r.text).not.toContain("zzz");
  });
});

// ═══════════════════ ERRORS, CORRELATION IDS, INPUT HARDENING ═══════════════════
describe("Standard errors and correlation ids", () => {
  test("validation, not-found, 401, 403, 429, 413 and bad JSON all use { success:false, error:{code,message,correlationId} } plus the legacy flat keys", async () => {
    const admin = await as("ERP_ADMIN"); const viewer = await as("ERP_VIEWER");
    const cases = [
      [await call("POST", "/erp-integrations", { cookie: admin, body: {} }), 400, "VALIDATION_FAILED"],
      [await call("GET", "/erp-integrations/99999", { cookie: admin }), 404, "NOT_FOUND"],
      [await call("GET", "/erp-integrations"), 401, "UNAUTHENTICATED"],
      [await call("POST", "/erp-integrations", { cookie: viewer, body: {} }), 403, "FORBIDDEN"],
      [await call("POST", "/erp-integrations", { cookie: admin, raw: "{not json" }), 400, "INVALID_JSON"],
      [await call("POST", "/erp-integrations", { cookie: admin, raw: JSON.stringify({ name: "x".repeat(200000) }) }), 413, "PAYLOAD_TOO_LARGE"],
      [await call("GET", "/does-not-exist", { cookie: admin }), 404, "NOT_FOUND"],
    ];
    for (const [r, status, code] of cases) {
      expect([r.status, r.json.code]).toEqual([status, code]);
      expect(r.json).toMatchObject({ success: false, error: { code, correlationId: expect.any(String) }, code, message: expect.any(String), correlationId: expect.any(String) });
      expect(r.json.error.correlationId).toBe(r.headers["x-correlation-id"]); expect(r.json.error.message).toBe(r.json.message);
    }
  });

  test("unexpected errors expose nothing: no stack, SQL, file path, env var or secret — only a fixed message and a correlation id; the detail is logged redacted", async () => {
    const admin = await as("ERP_ADMIN");
    jest.spyOn(db.ErpConnection, "findAll").mockRejectedValue(Object.assign(new Error("SELECT * FROM erp_connections WHERE password='S3cr3t-Pa55word!' at /home/claude/work/be/services/x.js:10"), { name: "SequelizeDatabaseError" }));
    const r = await call("GET", "/erp-integrations", { cookie: admin });
    expect(r.status).toBe(500); expect(r.json).toMatchObject({ success: false, code: "INTERNAL_ERROR", message: "Unable to complete the request" });
    expect(r.text).not.toMatch(/SELECT|erp_connections|S3cr3t|\/home|\.js|stack|Sequelize|at /);
    const log = logged.join("\n"); expect(log).toContain(r.json.correlationId); expect(log).not.toContain("S3cr3t-Pa55word!");
  });

  test("a client correlation id is honoured when it is a safe token and replaced otherwise; every response carries one", async () => {
    const admin = await as("ERP_ADMIN");
    const a = await call("GET", "/erp-integrations", { cookie: admin, headers: { "X-Correlation-ID": "client-req-0001" } }); expect(a.headers["x-correlation-id"]).toBe("client-req-0001");
    const b = await call("GET", "/erp-integrations", { cookie: admin, headers: { "X-Correlation-ID": "bad id with spaces & <script>" } }); expect(b.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const c = await call("GET", "/erp-integrations", { cookie: admin }); expect(c.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("one id flows HTTP request → job → provider request header → audit rows → API errors", async () => {
    const admin = await as("ERP_ADMIN"); const c = await mkConn(); await sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: PROD_MAP });
    const d = await require("./helpers").seedDistributor(); const seen = [];
    global.fetch = jest.fn(async (url, init) => { seen.push(init.headers["X-Correlation-ID"]); return okJson({ rows: [{ Code: "A", Title: "a" }] }); });
    const cid = "trace-abcdef-0001"; await new Promise((res) => setTimeout(res, 300)); seen.length = 0; // let any job left over from an earlier test finish first
    const r = await call("POST", "/erp-sync/jobs", { cookie: admin, headers: { "X-Correlation-ID": cid }, body: { connectionId: c.id, capability: "PRODUCT_MASTER", scope: await scopeFor() } });
    expect(r.status).toBe(202); expect(r.headers["x-correlation-id"]).toBe(cid); expect(r.json.correlationId).toBe(cid);
    await new Promise((res) => setTimeout(res, 500)); await audit.flush();
    expect((await db.ErpSyncJob.findByPk(r.json.id)).correlation_id).toBe(cid);
    expect(seen.length).toBeGreaterThan(0); expect(new Set(seen)).toEqual(new Set([cid]));
    const ev = await db.ErpAuditEvent.findAll({ where: { correlation_id: cid } }); expect(ev.map((e) => e.event)).toEqual(expect.arrayContaining(["ERP_SYNC_CREATED", "ERP_SYNC_STARTED"]));
    const t = await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, headers: { "X-Correlation-ID": "trace-test-0002" }, body: {} });
    expect(t.json.correlationId).toBe("trace-test-0002"); expect((await call("GET", "/erp-sync/audit?correlationId=trace-test-0002", { cookie: admin })).json.items.length).toBeGreaterThan(0);
  });

  test("audit events written inside a request (connection create / update) carry the request id without any extra plumbing", async () => {
    const admin = await as("ERP_ADMIN");
    const r = await call("POST", "/erp-integrations", { cookie: admin, headers: { "X-Correlation-ID": "trace-create-003" }, body: { name: "N", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://n.example.com", credentialRef: "RESTBEARER" } });
    expect(r.status).toBe(201); await audit.flush();
    const ev = await db.ErpAuditEvent.findOne({ where: { event: "ERP_CONNECTION_CREATED" } }); expect(ev.correlation_id).toBe("trace-create-003");
  });
});

describe("Input hardening", () => {
  test("prototype-pollution keys are refused in body and query; Object.prototype is untouched", async () => {
    const admin = await as("ERP_ADMIN");
    for (const raw of ['{"__proto__":{"polluted":true},"name":"x"}', '{"a":{"constructor":{"prototype":{"polluted":true}}}}', '{"capabilities":[{"capability":"STOCK","prototype":{"x":1}}]}']) {
      const r = await call("POST", "/erp-integrations", { cookie: admin, raw }); expect(r.status).toBe(400); expect(r.json.code).toBe("VALIDATION_FAILED");
    }
    expect((await call("GET", "/erp-integrations?__proto__[polluted]=1", { cookie: admin })).status).toBe(200); // qs-less parser: harmless
    expect({}.polluted).toBeUndefined();
  });
  test("mass assignment: server-owned fields cannot be set on create / update", async () => {
    const admin = await as("ERP_ADMIN");
    const r = await call("POST", "/erp-integrations", { cookie: admin, body: { name: "M", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://m.example.com", tenant_key: "TENANT_B", tenantKey: "TENANT_B", id: 999, status: "ERROR", is_default: true, isDefault: true, created_by_admin_id: 42, last_test_ok: true } });
    expect(r.status).toBe(201); const row = await db.ErpConnection.findByPk(r.json.id);
    expect(row.tenant_key).toBe(T); expect(row.id).not.toBe(999); expect(row.status).toBe("ACTIVE"); expect(row.is_default).toBeFalsy(); expect(row.last_test_ok).toBeNull();
    const u = await call("PUT", `/erp-integrations/${row.id}`, { cookie: admin, body: { status: "INACTIVE" } }); expect(u.status).toBe(400);
    const u2 = await call("PUT", `/erp-integrations/${row.id}`, { cookie: admin, body: { tenant_key: "TENANT_B", id: 5, name: "Renamed" } }); expect(u2.status).toBe(200);
    expect((await db.ErpConnection.findByPk(row.id)).tenant_key).toBe(T);
  });
  test("query validation: bad enums, non-numeric ids, absurd page sizes and deep pages are 400 / capped, never an error page or SQL", async () => {
    const admin = await as("ERP_ADMIN");
    for (const q of ["/erp-sync/jobs?status=DROP", "/erp-sync/jobs?capability=%27%20OR%201=1", "/erp-sync/jobs?connectionId=abc", "/erp-sync/jobs?connectionId=-1", "/erp-sync/jobs?page=0", "/erp-sync/jobs?page=1e9", "/erp-sync/jobs?trigger=x", "/erp-sync/errors?errorCode=nope", "/erp-sync/errors?retryable=maybe", "/erp-sync/errors?from=2026-13-45", "/erp-sync/errors?from=2026-05-02&to=2026-05-01", "/erp-sync/audit?event=nope", "/erp-sync/audit?status=x", "/erp-sync/audit?actorId=1;DROP", "/erp-sync/audit?from=yesterday", "/erp-sync/audit?page=999999", "/erp-sync/outbound?status=x", "/erp-integrations?status=NOPE", "/erp-integrations?q=" + "x".repeat(300), "/erp-sync/schedules?connectionId=x"]) {
      const r = await call("GET", q, { cookie: admin }); expect([q, r.status]).toEqual([q, 400]); expect(r.json.code).toBe("VALIDATION_FAILED");
    }
    const big = await call("GET", "/erp-sync/audit?pageSize=100000", { cookie: admin }); expect(big.json.pageSize).toBe(100);
    expect((await call("GET", "/erp-sync/jobs?pageSize=100000", { cookie: admin })).json.pageSize).toBe(100);
    expect((await call("GET", "/erp-sync/errors?pageSize=100000", { cookie: admin })).json.pageSize).toBe(100);
  });
  test("an object where a scalar is expected is refused (e.g. ?page[a]=1 style or JSON objects in ids)", async () => {
    const admin = await as("ERP_ADMIN"); const c = await mkConn();
    expect((await call("POST", "/erp-sync/jobs", { cookie: admin, body: { connectionId: { $gt: 0 }, capability: "PRODUCT_MASTER" } })).status).toBe(404);
    expect((await call("POST", "/erp-sync/outbound", { cookie: admin, body: { connectionId: c.id, capability: { x: 1 }, entityId: "1; DROP" } })).status).toBeGreaterThanOrEqual(400);
  });
});

// ═══════════════════════════ RATE LIMITING ═══════════════════════════
describe("Rate limiting", () => {
  const reset = () => { for (const k of Object.keys(process.env)) if (k.startsWith("RATE_LIMIT")) delete process.env[k]; limiter.resetRateLimits(); };
  afterEach(reset);
  test("connection test: the N+1th request in a minute is 429 with Retry-After and the standard shape; the ERP is not contacted for it", async () => {
    process.env.RATE_LIMIT_ERP_TEST_PER_MIN = "2"; const admin = await as("ERP_ADMIN"); const c = await mkConn();
    global.fetch = jest.fn(async () => okJson({}));
    const statuses = []; for (let i = 0; i < 4; i += 1) statuses.push((await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} })).status);
    expect(statuses.slice(0, 2).every((s) => s === 200)).toBe(true); expect(statuses.slice(2)).toEqual([429, 429]);
    const r = await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} });
    expect(r.headers["retry-after"]).toBeDefined(); expect(r.json).toMatchObject({ success: false, code: "RATE_LIMITED", error: { code: "RATE_LIMITED", correlationId: expect.any(String) } });
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(4); // limited requests never reach the provider
  });
  test("limits are per admin (one noisy admin does not block another), per policy (a limited bucket does not block reads) and per permission order (403 is answered before the limiter)", async () => {
    process.env.RATE_LIMIT_ERP_SYNC_PER_MIN = "1"; const a = await as("ERP_ADMIN"); const b = await as("ERP_ADMIN"); const viewer = await as("ERP_VIEWER");
    expect((await call("POST", "/erp-sync/jobs", { cookie: a, body: {} })).status).toBe(404);
    expect((await call("POST", "/erp-sync/jobs", { cookie: a, body: {} })).status).toBe(429);
    expect((await call("POST", "/erp-sync/jobs", { cookie: b, body: {} })).status).toBe(404);
    expect((await call("GET", "/erp-sync/jobs", { cookie: a })).status).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await call("POST", "/erp-sync/jobs", { cookie: viewer, body: {} })).status).toBe(403);
  });
  test("audit search, heavy summary, outbound and writes each have their own bucket", async () => {
    Object.assign(process.env, { RATE_LIMIT_ERP_AUDIT_PER_MIN: "1", RATE_LIMIT_ERP_HEAVY_PER_MIN: "1", RATE_LIMIT_ERP_OUTBOUND_PER_MIN: "1", RATE_LIMIT_ERP_WRITE_PER_MIN: "1" });
    const a = await as("ERP_ADMIN");
    for (const [m, p, b] of [["GET", "/erp-sync/audit"], ["GET", "/erp-sync/summary"], ["POST", "/erp-sync/outbound", {}], ["POST", "/erp-integrations", {}]]) {
      expect((await call(m, p, { cookie: a, body: b })).status).not.toBe(429); expect([m, p, (await call(m, p, { cookie: a, body: b })).status]).toEqual([m, p, 429]);
    }
  });
  test("the login endpoint has a per-IP request limit in front of the failed-attempt limiter", async () => {
    process.env.RATE_LIMIT_LOGIN_PER_MIN = "3"; const s = []; for (let i = 0; i < 5; i += 1) s.push((await call("POST", "/login", { body: { email: "nobody@test.com", password: "wrong-password-1" } })).status);
    expect(s.slice(0, 3).every((x) => x === 401)).toBe(true); expect(s.slice(3)).toEqual([429, 429]);
  });
  test("RATE_LIMIT_DISABLED switches it off; defaults are generous enough for the Admin UI; the scheduler is never rate limited", async () => {
    process.env.RATE_LIMIT_ERP_SYNC_PER_MIN = "1"; process.env.RATE_LIMIT_DISABLED = "true"; const a = await as("ERP_ADMIN");
    for (let i = 0; i < 3; i += 1) expect((await call("POST", "/erp-sync/jobs", { cookie: a, body: {} })).status).toBe(404);
    reset(); for (let i = 0; i < 30; i += 1) expect((await call("GET", "/erp-integrations", { cookie: a })).status).toBe(200); // default read budget 600/min
    const src = require("fs").readFileSync(require.resolve("../services/erpScheduler.service"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/rateLimiter/); expect(require("fs").readFileSync(require.resolve("../services/erp/sync/syncEngine"), "utf8")).not.toMatch(/rateLimiter/);
  });
  test("the limiter's window resets and its memory is bounded", async () => {
    const lim = limiter.rateLimit("t", { max: 1, windowMs: 40 }); const res = () => { const r = mockRes(); r.set = jest.fn(); return r; };
    const next = jest.fn(); const req = { admin: { id: 7 }, ip: "1.1.1.1" };
    lim(req, res(), next); const r2 = res(); lim(req, r2, next); expect(r2.statusCode).toBe(429); expect(next).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 60)); lim(req, res(), next); expect(next).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════ CONFIGURATION VALIDATION & CONNECTION HEALTH ═══════════════════
describe("ERP configuration validation", () => {
  test("DMS → ERP on a provider that cannot write is rejected; so is an idempotency attestation on it; ERP → DMS and disabled capabilities are fine", async () => {
    const base = { name: "Oracle", erpType: "ORACLE_ERP", environment: "TEST", baseUrl: "https://oracle.example.com", authType: "BEARER_TOKEN", credentialRef: "RESTBEARER" };
    await expect(conns.createConnection(db, T, 1, { ...base, capabilities: [{ capability: "PAYMENT", direction: "DMS_TO_ERP" }] })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED", details: { field: "direction" } });
    await expect(conns.createConnection(db, T, 1, { ...base, capabilities: [{ capability: "PRODUCT_MASTER", direction: "BIDIRECTIONAL" }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(conns.createConnection(db, T, 1, { ...base, capabilities: [{ capability: "PAYMENT", direction: "DISABLED" }] })).resolves.toBeDefined();
    const ok = await conns.createConnection(db, T, 1, { ...base, name: "Oracle2", capabilities: [{ capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", endpointPath: "/p" }] });
    expect(ok.configWarnings.map((w) => w.code)).toEqual(expect.arrayContaining(["PROVIDER_NOT_IMPLEMENTED"]));
    await expect(conns.updateConnection(db, T, 1, ok.id, { capabilities: [{ capability: "PAYMENT", direction: "DMS_TO_ERP" }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(conns.createConnection(db, T, 1, { ...base, name: "Oracle3", capabilities: [{ capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS" }] , provider: "ORACLE_REST" })).resolves.toBeDefined();
    await expect(conns.createConnection(db, T, 1, { name: "Gen", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://g.example.com", authType: "BEARER_TOKEN", credentialRef: "RESTBEARER", capabilities: [{ capability: "PAYMENT", direction: "DMS_TO_ERP", endpointPath: "/p", config: { outbound: { idempotencySupported: true } } }] })).resolves.toBeDefined(); // writable provider → allowed
  });
  test("outbound without confirmed idempotency is saved with a warning and BLOCKED at send time (OUTBOUND_SYNC_BLOCKED)", async () => {
    const c = await mkConn({ capabilities: [{ capability: "CUSTOMER_MASTER", direction: "DMS_TO_ERP", ownership: "DMS_OWNED", endpointPath: "/c" }] });
    expect(c.configWarnings.map((w) => w.code)).toContain("OUTBOUND_IDEMPOTENCY_NOT_CONFIRMED");
    const admin = await as("ERP_ADMIN");
    await sync.saveMappings(db, T, 1, c.id, "CUSTOMER_MASTER", { mappings: [{ sourceField: "Id", isKey: true }, { sourceField: "Name", dmsField: "name" }] });
    const d = await require("./helpers").seedDistributor(); const cust = await require("./helpers").seedCustomer(d.id);
    const r = await call("POST", "/erp-sync/outbound", { cookie: admin, body: { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cust.id } });
    expect(r.status).toBe(409); expect(r.json.code).toBe("OUTBOUND_SYNC_BLOCKED"); expect(fetchMock).not.toHaveBeenCalled();
  });
  test("ownership contradicting direction is reported (warning) and still blocked at run time — Phase 16 behaviour is unchanged", async () => {
    const c = await mkConn({ capabilities: [{ capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", ownership: "DMS_OWNED", endpointPath: "/p" }] });
    expect(c.configWarnings.map((w) => w.code)).toContain("OWNERSHIP_DIRECTION_CONFLICT");
    await sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: PROD_MAP });
    await expect(sync.startSync(db, T, 1, { connectionId: c.id, capability: "PRODUCT_MASTER", scope: { distributorId: 1 } })).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
  });
  test("missing mapping, endpoint, ownership, credentials and blocked capabilities are warnings — nothing is guessed", async () => {
    const c = await mkConn({ credentialRef: undefined, capabilities: [{ capability: "STOCK", direction: "ERP_TO_DMS" }, { capability: "INVOICE", direction: "DMS_TO_ERP" }, cap("PRODUCT_MASTER", "/p")] });
    const codes = c.configWarnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["OWNERSHIP_UNDECIDED", "ENDPOINT_MISSING", "CAPABILITY_BLOCKED", "CREDENTIALS_NOT_SET", "MAPPING_MISSING"]));
    expect(c.capabilities.find((x) => x.capability === "STOCK").ownership).toBeNull();
  });
  test("an HTTP URL on a PRODUCTION-labelled connection is flagged; unknown fields in provider config and bad enums are 400", async () => {
    const c = await mkConn({ environment: "PRODUCTION", baseUrl: "http://custom.example.com" }); expect(c.configWarnings.map((w) => w.code)).toContain("PRODUCTION_OVER_HTTP");
    for (const body of [{ erpType: "NOPE" }, { environment: "MOON" }, { provider: "SKYNET" }, { timeoutMs: 999999 }, { baseUrl: "file:///etc/passwd" }, { capabilities: [{ capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", config: { evil: 1 } }] }, { capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/a/../b" }] }]) {
      await expect(mkConn({ name: "bad", ...body })).rejects.toMatchObject({ statusCode: 400 });
    }
  });
  test("an unrelated edit is never blocked by a legacy invalid combination already stored", async () => {
    const c = await mkConn(); await db.ErpConnectionCapability.update({ direction: "DMS_TO_ERP" }, { where: { connection_id: c.id } });
    await db.ErpConnection.update({ provider: "ORACLE_REST" }, { where: { id: c.id } });
    const r = await conns.updateConnection(db, T, 1, c.id, { description: "just a note" }); expect(r.description).toBe("just a note");
  });
  test("security-sensitive changes are audited with field names (never values) and the host only", async () => {
    const c = await mkConn(); await conns.updateConnection(db, T, 1, c.id, { baseUrl: "https://other.example.com/secret/path", credentialRef: "SAPPROD", timeoutMs: 20000 }); await audit.flush();
    const ev = await db.ErpAuditEvent.findOne({ where: { event: "ERP_SECURITY_CONFIG_UPDATED" } });
    expect(ev).toBeTruthy(); const dump = JSON.stringify(ev.metadata);
    expect(dump).toContain("base_url"); expect(dump).toContain("credential_ref"); expect(dump).toContain("other.example.com"); expect(dump).not.toContain("secret/path"); expect(dump).not.toContain("SAPPROD");
    await conns.updateConnection(db, T, 1, c.id, { description: "x" }); await audit.flush(); expect(await db.ErpAuditEvent.count({ where: { event: "ERP_SECURITY_CONFIG_UPDATED" } })).toBe(1);
  });
});

describe("Connection health", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const base = { status: "ACTIVE", last_test_at: new Date("2026-10-10T11:00:00Z"), last_test_ok: true, last_test_latency_ms: 200, timeout_ms: 10000 };
  test("CONNECTED only after a recent passing test with credentials present and no failed latest sync", () => {
    expect(health.computeConnectionHealth(base, { credentialStatus: "RESOLVED", now }).status).toBe("CONNECTED");
    expect(health.computeConnectionHealth({ ...base, last_test_at: null }, { credentialStatus: "RESOLVED", now }).status).toBe("NOT_TESTED");
    expect(health.computeConnectionHealth({ ...base, last_test_ok: false, last_test_message: "bad" }, { now })).toMatchObject({ status: "FAILED", reason: "bad" });
    expect(health.computeConnectionHealth({ ...base, status: "INACTIVE" }, { now }).status).toBe("DISABLED");
    expect(health.computeConnectionHealth({ ...base, status: "ERROR", last_test_ok: false }, { now }).status).toBe("FAILED");
  });
  test("DEGRADED: slow, stale test, credentials gone, latest sync failed", () => {
    expect(health.computeConnectionHealth({ ...base, last_test_latency_ms: 7000 }, { credentialStatus: "RESOLVED", now }).status).toBe("DEGRADED");
    expect(health.computeConnectionHealth({ ...base, last_test_at: new Date("2026-10-08T00:00:00Z") }, { credentialStatus: "RESOLVED", now }).status).toBe("DEGRADED");
    expect(health.computeConnectionHealth(base, { credentialStatus: "MISSING", now }).status).toBe("DEGRADED");
    expect(health.computeConnectionHealth(base, { credentialStatus: "RESOLVED", lastSync: { status: "FAILED" }, now }).status).toBe("DEGRADED");
    expect(health.computeConnectionHealth(base, { credentialStatus: "RESOLVED", lastSync: { status: "SUCCESS" }, now }).status).toBe("CONNECTED");
  });
  test("a saved connection is never CONNECTED by configuration alone; the test result is generic and secret-free", async () => {
    const admin = await as("ERP_ADMIN"); const c = await mkConn();
    expect(c.health).toMatchObject({ status: "NOT_TESTED", state: "NOT_TESTED" });
    global.fetch = jest.fn(async () => okJson({ rows: [] }));
    const t = await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} });
    expect(t.json).toMatchObject({ status: "CONNECTED", provider: "GENERIC_REST", ok: true, code: "CONNECTED", correlationId: expect.any(String) });
    expect(t.json.connection.health).toMatchObject({ status: "CONNECTED", state: "REACHABLE" });
    global.fetch = jest.fn(async () => ({ status: 401, text: async () => "no", headers: hdrs() }));
    const f = await call("POST", `/erp-integrations/${c.id}/test`, { cookie: admin, body: {} });
    expect(f.json).toMatchObject({ status: "FAILED", provider: "GENERIC_REST", ok: false, code: "AUTHENTICATION_ERROR", correlationId: expect.any(String) });
    expect(f.json.connection.health.status).toBe("FAILED"); expect(f.text).not.toContain("bearer-tok-XYZ789");
    await conns.setStatus(db, T, 1, c.id, { status: "INACTIVE" }); expect((await conns.getConnection(db, T, c.id)).health.status).toBe("DISABLED");
    await conns.setStatus(db, T, 1, c.id, { status: "ACTIVE" });
    await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "FAILED", attempt: 1 });
    await db.ErpConnection.update({ last_test_ok: true, last_test_at: new Date(), last_test_latency_ms: 50 }, { where: { id: c.id } });
    expect((await conns.getConnection(db, T, c.id)).health.status).toBe("DEGRADED");
  });
});
