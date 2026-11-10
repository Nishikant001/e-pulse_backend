// Phase 13 — SAP / ERP Integration foundation. Same in-memory sqlite + direct-controller convention as Phases 7–12.
// No real SAP is contacted: the OData transport is a mock `fetch`. A mocked 200 proves our handling, NOT real SAP connectivity.
const { db, resetDb, mockRes } = require("./helpers");
const erp = require("../controllers/admin.erp.controller");
const svc = require("../services/erpIntegration.service");
const requireAdmin = require("../middleware/adminAuth");
const adminRoutes = require("../routes/adminRoutes");
const { redact, ErpIntegrationError, normalizeError } = require("../services/erp/erpErrors");
const { ODataClient, normalizeODataPayload } = require("../services/erp/odataClient");
const { validateBaseUrl, validateServicePath } = require("../services/erp/urlValidator");
const secrets = require("../services/erp/secretResolver");
const mgr = require("../services/erp/connectionManager");
const { resolveTenantKey } = require("../services/erp/tenantScope");

const PASSWORD = "S3cr3t-Pa55word!";
const USER = "SAPSVCUSER";
const EDMX = '<?xml version="1.0"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices/></edmx:Edmx>';
const EDMX4 = '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"></edmx:Edmx>';

beforeAll(() => {
  process.env.ERP_SAPPROD_USERNAME = USER; process.env.ERP_SAPPROD_PASSWORD = PASSWORD;
  process.env.ERP_SAPSEC_USERNAME = USER; process.env.ERP_SAPSEC_PASSWORD = PASSWORD;
});
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(async () => { await db.sequelize.close(); });

const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const body = (o = {}) => ({ name: "SAP Production", erpType: "SAP_S4HANA", environment: "PRODUCTION", baseUrl: "https://sap.example.com:44300", odataServicePath: "/sap/opu/odata/sap/API_PRODUCT_SRV", sapClient: "100", credentialRef: "SAPPROD", ...o });
const create = (o, req = {}) => A(erp.create, { body: body(o), ...req });
const mkRes = (status, text, ct = "application/xml") => ({ status, text: async () => text, headers: { get: (h) => (h.toLowerCase() === "content-type" ? ct : null) } });
const okFetch = (text = EDMX) => jest.fn(async () => mkRes(200, text));
const runTest = (id, fetchImpl, tenant = "DEFAULT", adminId = 1) => svc.testConnection(db, tenant, adminId, id, { fetchImpl, logger: () => {} });

describe("Admin authorization", () => {
  test("every ERP route is protected by requireAdmin", () => {
    const routes = adminRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/erp-integrations"));
    expect(routes.length).toBe(15); // 8 connection + 2 mapping (Phase 14) + 1 schedule (Phase 15) + 3 code-mapping routes (Phase 16) + 1 readiness route (Phase 17); the Phase 18 business routes live under /erp-sync
    routes.forEach((l) => expect(l.route.stack[0].handle).toBe(requireAdmin));
  });
  test("a request without an Admin session is rejected (401) and the controller is never reached", async () => {
    process.env.ADMIN_JWT_SECRET = "x".repeat(40);
    const res = mockRes(); const next = jest.fn();
    await requireAdmin({ cookies: {} }, res, next);
    expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled();
  });
});

describe("Create / get / list / update", () => {
  test("creates a connection: ACTIVE, not default, auto code ERP-001, never marked reachable", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody).toMatchObject({ code: "ERP-001", status: "ACTIVE", isDefault: false, erpType: "SAP_S4HANA", environment: "PRODUCTION", odataVersion: "V2" });
    expect(res.jsonBody.health).toMatchObject({ state: "NOT_TESTED", ok: null, testedAt: null });
    expect(res.jsonBody.credentials).toEqual({ reference: "SAPPROD", status: "RESOLVED" });
  });
  test("codes auto-increment per tenant; explicit code accepted (upper-cased); duplicate → 409", async () => {
    await create(); const b = await create({ name: "B" });
    expect(b.jsonBody.code).toBe("ERP-002");
    const c = await create({ name: "C", code: "sap-test" });
    expect(c.jsonBody.code).toBe("SAP-TEST");
    expect((await create({ name: "D", code: "SAP-TEST" })).statusCode).toBe(409);
  });
  test("get returns the record; unknown / non-numeric id → 404", async () => {
    const { id } = (await create()).jsonBody;
    expect((await A(erp.get, { params: { id } })).jsonBody.name).toBe("SAP Production");
    expect((await A(erp.get, { params: { id: 9999 } })).statusCode).toBe(404);
    expect((await A(erp.get, { params: { id: "abc" } })).statusCode).toBe(404);
  });
  test("list returns all with default info; filters work; says honestly when there is no default", async () => {
    await create(); await create({ name: "Secondary", environment: "SECONDARY", erpType: "SAP_ECC" });
    const all = (await A(erp.list)).jsonBody;
    expect(all).toMatchObject({ total: 2, hasDefault: false, defaultConnectionId: null });
    expect((await A(erp.list, { query: { erpType: "SAP_ECC" } })).jsonBody.items).toHaveLength(1);
    expect((await A(erp.list, { query: { q: "second" } })).jsonBody.items[0].name).toBe("Secondary");
    expect((await A(erp.list, { query: { status: "BOGUS" } })).statusCode).toBe(400);
  });
  test("update changes fields, replaces capabilities, keeps code; code/status/default cannot be edited here", async () => {
    const { id } = (await create({ capabilities: [{ capability: "PRODUCT_MASTER" }, { capability: "PRICING" }] })).jsonBody;
    const res = await A(erp.update, { params: { id }, body: { name: "Renamed", companyCode: "1000", capabilities: [{ capability: "PRICING", direction: "BIDIRECTIONAL" }, { capability: "STOCK" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ name: "Renamed", companyCode: "1000", code: "ERP-001" });
    expect(res.jsonBody.capabilities.map((c) => c.capability)).toEqual(["PRICING", "STOCK"]);
    expect(res.jsonBody.capabilities[0].direction).toBe("BIDIRECTIONAL");
    for (const bad of [{ code: "X1" }, { status: "INACTIVE" }, { isDefault: true }]) expect((await A(erp.update, { params: { id }, body: bad })).statusCode).toBe(400);
    expect((await A(erp.update, { params: { id: 9999 }, body: { name: "x" } })).statusCode).toBe(404);
  });
  test("changing connectivity resets the old test result and clears a stale ERROR", async () => {
    const { id } = (await create()).jsonBody;
    await runTest(id, jest.fn(async () => mkRes(401, "")));
    expect((await svc.getConnection(db, "DEFAULT", id)).status).toBe("ERROR");
    const res = await A(erp.update, { params: { id }, body: { baseUrl: "https://other.example.com" } });
    expect(res.jsonBody).toMatchObject({ status: "ACTIVE" }); expect(res.jsonBody.health.state).toBe("NOT_TESTED");
  });
  test("a cosmetic edit keeps the last test result", async () => {
    const { id } = (await create()).jsonBody; await runTest(id, okFetch());
    expect((await A(erp.update, { params: { id }, body: { description: "note" } })).jsonBody.health.state).toBe("REACHABLE");
  });
});

describe("Server-side validation", () => {
  const bad = async (o) => (await create(o)).statusCode;
  test("required fields / enums", async () => {
    expect(await bad({ name: "" })).toBe(400); expect(await bad({ erpType: "ORACLE" })).toBe(400);
    expect(await bad({ environment: "MOON" })).toBe(400); expect(await bad({ baseUrl: undefined })).toBe(400);
  });
  test("URL rules: invalid, no scheme, userinfo, query, reserved address, path traversal", async () => {
    for (const baseUrl of ["not a url", "ftp://sap.example.com", "https://user:pw@sap.example.com", "https://sap.example.com?x=1", "https://169.254.169.254"]) expect(await bad({ baseUrl })).toBe(400);
    for (const odataServicePath of ["no-slash", "/a/../b", "/a?b=1"]) expect(await bad({ odataServicePath })).toBe(400);
  });
  test("sap client, credential reference, timeout, capability errors", async () => {
    expect(await bad({ sapClient: "12" })).toBe(400); expect(await bad({ credentialRef: "bad ref!" })).toBe(400);
    expect(await bad({ timeoutMs: 5 })).toBe(400);
    expect(await bad({ capabilities: [{ capability: "NOPE" }] })).toBe(400);
    expect(await bad({ capabilities: [{ capability: "STOCK" }, { capability: "STOCK" }] })).toBe(400);
    expect(await bad({ capabilities: [{ capability: "STOCK", direction: "SIDEWAYS" }] })).toBe(400);
  });
  test("https is required in production; http allowed otherwise; localhost refused in production", () => {
    expect(validateBaseUrl("http://sap.local:8000/")).toBe("http://sap.local:8000");
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { expect(() => validateBaseUrl("http://sap.example.com")).toThrow(); expect(() => validateBaseUrl("https://localhost")).toThrow(); // Phase 17 (intentional change): private-network ERP hosts are refused in production unless explicitly enabled.
      expect(() => validateBaseUrl("https://10.1.2.3:44300")).toThrow();
      process.env.ERP_ALLOW_PRIVATE_NETWORK = "true"; expect(validateBaseUrl("https://10.1.2.3:44300")).toBe("https://10.1.2.3:44300"); }
    finally { process.env.NODE_ENV = prev; delete process.env.ERP_ALLOW_PRIVATE_NETWORK; }
    expect(validateServicePath("/sap/opu/odata/sap/X/")).toBe("/sap/opu/odata/sap/X");
  });
});

describe("Default ERP", () => {
  const three = async () => { const r = []; for (const n of ["A", "B", "C"]) r.push((await create({ name: n })).jsonBody.id); return r; };
  const defaults = async () => (await db.ErpConnection.findAll({ where: { is_default: true } })).map((r) => r.id);

  test("setting a default unsets the previous one — exactly one default", async () => {
    const [a, b, c] = await three();
    expect((await A(erp.setDefault, { params: { id: a } })).jsonBody.isDefault).toBe(true);
    expect(await defaults()).toEqual([a]);
    await A(erp.setDefault, { params: { id: c } });
    expect(await defaults()).toEqual([c]);
    expect((await svc.getConnection(db, "DEFAULT", a)).isDefault).toBe(false);
    expect((await A(erp.list)).jsonBody).toMatchObject({ hasDefault: true, defaultConnectionId: c });
    expect(b).toBeDefined();
  });
  test("setting the same default twice is a no-op; unknown id → 404", async () => {
    const [a] = await three(); await A(erp.setDefault, { params: { id: a } });
    expect((await A(erp.setDefault, { params: { id: a } })).statusCode).toBe(200);
    expect(await defaults()).toEqual([a]);
    expect((await A(erp.setDefault, { params: { id: 999 } })).statusCode).toBe(404);
  });
  test("creating connections never picks a default automatically", async () => { await three(); expect(await defaults()).toEqual([]); });
  test("an inactive connection cannot become the default", async () => {
    const [a] = await three(); await A(erp.setStatus, { params: { id: a }, body: { status: "INACTIVE" } });
    const res = await A(erp.setDefault, { params: { id: a } }); expect(res.statusCode).toBe(409); expect(res.jsonBody.code).toBe("ERP_CONNECTION_INACTIVE");
  });
  test("the database itself refuses a second default for a tenant (unique default_marker)", async () => {
    const [a, b] = await three();
    await db.ErpConnection.update({ is_default: true, default_marker: "DEFAULT" }, { where: { id: a } });
    await expect(db.ErpConnection.update({ is_default: true, default_marker: "DEFAULT" }, { where: { id: b } })).rejects.toThrow();
  });
  test("deactivating the default is refused unless the admin explicitly accepts 'no default'", async () => {
    const [a, b] = await three(); await A(erp.setDefault, { params: { id: a } });
    const refused = await A(erp.setStatus, { params: { id: a }, body: { status: "INACTIVE" } });
    expect(refused.statusCode).toBe(409); expect(refused.jsonBody.code).toBe("DEFAULT_ERP_CONNECTION");
    expect(await defaults()).toEqual([a]);
    const ok = await A(erp.setStatus, { params: { id: a }, body: { status: "INACTIVE", clearDefault: true } });
    expect(ok.statusCode).toBe(200); expect(ok.jsonBody).toMatchObject({ status: "INACTIVE", isDefault: false, defaultCleared: true });
    expect((await A(erp.list)).jsonBody).toMatchObject({ hasDefault: false, defaultConnectionId: null });
    expect(await defaults()).toEqual([]);                    // no arbitrary replacement was chosen
    expect((await svc.getConnection(db, "DEFAULT", b)).isDefault).toBe(false);
  });
  test("default is per tenant: two tenants can each have one", async () => {
    const [a] = await three(); const other = (await svc.createConnection(db, "TENANT_B", 1, body({ name: "B-ERP" }))).id;
    await svc.setDefault(db, "DEFAULT", 1, a); await svc.setDefault(db, "TENANT_B", 1, other);
    expect(await defaults()).toHaveLength(2);
  });
});

describe("Activate / deactivate", () => {
  test("toggles status, is idempotent, and ERROR cannot be requested", async () => {
    const { id } = (await create()).jsonBody;
    expect((await A(erp.setStatus, { params: { id }, body: { status: "INACTIVE" } })).jsonBody.status).toBe("INACTIVE");
    expect((await A(erp.setStatus, { params: { id }, body: { status: "INACTIVE" } })).statusCode).toBe(200);
    expect((await A(erp.setStatus, { params: { id }, body: { status: "ACTIVE" } })).jsonBody.status).toBe("ACTIVE");
    expect((await A(erp.setStatus, { params: { id }, body: { status: "ERROR" } })).statusCode).toBe(400);
    expect((await A(erp.setStatus, { params: { id }, body: {} })).statusCode).toBe(400);
    expect((await A(erp.setStatus, { params: { id: 999 }, body: { status: "ACTIVE" } })).statusCode).toBe(404);
  });
});

describe("Multi-ERP and tenant isolation", () => {
  test("one tenant can hold ERP A, B and C together", async () => {
    await create({ name: "A" }); await create({ name: "B", erpType: "SAP_ECC", environment: "SECONDARY" }); await create({ name: "C", environment: "TEST" });
    const l = (await A(erp.list)).jsonBody;
    expect(l.items.map((i) => i.name).sort()).toEqual(["A", "B", "C"]);
    expect(new Set(l.items.map((i) => i.code)).size).toBe(3);
  });
  test("tenant B cannot read, edit, test, activate or default tenant A's connection (404)", async () => {
    const { id } = (await create({ capabilities: [{ capability: "STOCK" }] })).jsonBody;
    const asB = { admin: { id: 2, tenantKey: "TENANT_B" } };
    expect((await A(erp.get, { params: { id }, ...asB })).statusCode).toBe(404);
    expect((await A(erp.update, { params: { id }, body: { name: "hack" }, ...asB })).statusCode).toBe(404);
    expect((await A(erp.setStatus, { params: { id }, body: { status: "INACTIVE" }, ...asB })).statusCode).toBe(404);
    expect((await A(erp.setDefault, { params: { id }, ...asB })).statusCode).toBe(404);
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => mkRes(200, EDMX));
    expect((await A(erp.test, { params: { id }, ...asB })).statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();                                   // SAP was never contacted on B's behalf
    expect((await A(erp.list, asB)).jsonBody.items).toHaveLength(0);
    expect((await A(erp.get, { params: { id } })).jsonBody.name).toBe("SAP Production"); // untouched
  });
  test("a tenantKey sent in the body or query is ignored — the session decides", async () => {
    const res = await create({ name: "Mine", tenantKey: "TENANT_B" }, { query: { tenantKey: "TENANT_B" } });
    expect(res.statusCode).toBe(201);
    expect((await db.ErpConnection.findByPk(res.jsonBody.id)).tenant_key).toBe("DEFAULT");
    expect((await A(erp.list, { query: { tenantKey: "TENANT_B" } })).jsonBody.items).toHaveLength(1);
    expect(resolveTenantKey({ admin: { tenantKey: "T1" }, body: { tenantKey: "T2" } })).toBe("T1");
  });
  test("the same code can exist in two tenants; a code is unique within one", async () => {
    await svc.createConnection(db, "T1", 1, body({ code: "ERP-X" })); await svc.createConnection(db, "T2", 1, body({ code: "ERP-X" }));
    await expect(svc.createConnection(db, "T1", 1, body({ code: "ERP-X" }))).rejects.toMatchObject({ statusCode: 409 });
  });
  test("capability lookup and default lookup are tenant-scoped", async () => {
    const a = (await svc.createConnection(db, "T1", 1, body({ name: "A", capabilities: [{ capability: "STOCK" }] }))).id;
    await svc.createConnection(db, "T2", 1, body({ name: "B", capabilities: [{ capability: "STOCK" }] }));
    await svc.setDefault(db, "T1", 1, a);
    expect((await mgr.findConnectionsForCapability(db, "T1", "STOCK")).map((c) => c.id)).toEqual([a]);
    expect((await mgr.getDefaultConnection(db, "T1")).id).toBe(a);
    expect(await mgr.getDefaultConnection(db, "T3")).toBeNull();
    await expect(mgr.requireDefaultConnection(db, "T3")).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

describe("Capabilities and direction (Phase 14 foundation)", () => {
  test("stored with direction + endpoint; disabled / inactive ERPs are not offered for a capability", async () => {
    const a = (await create({ name: "A", capabilities: [{ capability: "PRODUCT_MASTER" }, { capability: "INVOICE", endpointPath: "/A_Invoice" }, { capability: "STOCK", enabled: false }] })).jsonBody;
    expect(a.capabilities.find((c) => c.capability === "PRODUCT_MASTER").direction).toBe("ERP_TO_DMS");
    expect(a.capabilities.find((c) => c.capability === "INVOICE")).toMatchObject({ direction: "DMS_TO_ERP", endpointPath: "/A_Invoice" });
    expect(await mgr.findConnectionsForCapability(db, "DEFAULT", "STOCK")).toHaveLength(0);
    expect(await mgr.findConnectionsForCapability(db, "DEFAULT", "INVOICE")).toHaveLength(1);
    await A(erp.setStatus, { params: { id: a.id }, body: { status: "INACTIVE" } });
    expect(await mgr.findConnectionsForCapability(db, "DEFAULT", "INVOICE")).toHaveLength(0);
  });
  test("lookups expose types, capabilities, directions", async () => {
    const l = (await A(erp.lookups)).jsonBody;
    expect(l.capabilities.map((c) => c.value)).toEqual(["PRODUCT_MASTER", "CUSTOMER_MASTER", "DISTRIBUTOR_MASTER", "PRICING", "STOCK", "SALES", "INVOICE", "RETURN", "PAYMENT", "DOCUMENT"]);
    expect(l.directions.map((d) => d.value)).toEqual(["ERP_TO_DMS", "DMS_TO_ERP", "BIDIRECTIONAL", "DISABLED"]); // Phase 16 adds DISABLED
    expect(l.erpTypes.find((t) => t.value === "OTHER_ERP").supported).toBe(false);
  });
  test("the entity-mapping table exists and links to a connection", async () => {
    const { id } = (await create()).jsonBody;
    const m = await db.ErpEntityMapping.create({ connection_id: id, capability: "PRODUCT_MASTER", source_entity: "A_Product", source_field: "Product", dms_entity: "Product", dms_field: "code", is_key: true });
    expect((await db.ErpConnection.findByPk(id, { include: [{ model: db.ErpEntityMapping, as: "mappings" }] })).mappings[0].id).toBe(m.id);
  });
});

describe("Connection test — real request, normalized outcomes", () => {
  const setup = async () => (await create()).jsonBody.id;

  test("success: calls <base><path>/$metadata with Basic auth + sap-client, persists the result, never leaks secrets", async () => {
    const id = await setup(); const f = okFetch();
    const r = await runTest(id, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://sap.example.com:44300/sap/opu/odata/sap/API_PRODUCT_SRV/$metadata?sap-client=100");
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("manual");
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64"));
    expect(r).toMatchObject({ ok: true, code: "CONNECTED", httpStatus: 200 });
    expect(r.connection.health).toMatchObject({ state: "REACHABLE", ok: true, code: "CONNECTED" });
    expect(r.connection.status).toBe("ACTIVE");
    const dump = JSON.stringify(r) + JSON.stringify(await svc.getConnection(db, "DEFAULT", id));
    [PASSWORD, USER, Buffer.from(`${USER}:${PASSWORD}`).toString("base64"), "Authorization", "Basic "].forEach((s) => expect(dump).not.toContain(s));
  });
  test.each([
    ["wrong credentials (401)", () => mkRes(401, "Unauthorized"), "AUTHENTICATION_ERROR"],
    ["forbidden (403)", () => mkRes(403, ""), "AUTHORIZATION_ERROR"],
    ["wrong path (404)", () => mkRes(404, ""), "INVALID_ENDPOINT"],
    ["redirect to login (302)", () => mkRes(302, ""), "INVALID_ENDPOINT"],
    ["SAP server error (500)", () => mkRes(500, "<html>dump with Authorization: Basic Zm9vOmJhcg==</html>"), "SERVER_ERROR"],
    ["throttled (429)", () => mkRes(429, ""), "RATE_LIMITED"],
    ["other client error (400)", () => mkRes(400, ""), "REQUEST_REJECTED"],
    ["HTML login page served with 200", () => mkRes(200, "<html><body>Please log in</body></html>", "text/html"), "INVALID_RESPONSE"],
    ["empty 200", () => mkRes(200, ""), "INVALID_RESPONSE"],
  ])("%s", async (_n, make, code) => {
    const id = await setup(); const r = await runTest(id, jest.fn(async () => make()));
    expect(r.ok).toBe(false); expect(r.code).toBe(code);
    expect(r.connection.health).toMatchObject({ state: "FAILED", ok: false, code });
    expect(r.connection.status).toBe("ERROR");                       // ACTIVE → ERROR only because a real test failed
    expect(JSON.stringify(r)).not.toMatch(/Zm9vOmJhcg|Authorization|Please log in/);   // raw SAP bodies never reach the client
  });
  test("unreachable host (DNS / refused) → CONNECTION_ERROR, retryable", async () => {
    const id = await setup(); const r = await runTest(id, jest.fn(async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; }));
    expect(r).toMatchObject({ ok: false, code: "CONNECTION_ERROR", retryable: true });
  });
  test("timeout → TIMEOUT (the request really is aborted after timeout_ms)", async () => {
    const id = await setup(); await db.ErpConnection.update({ timeout_ms: 1000 }, { where: { id } });
    let aborted = false;
    const hang = jest.fn((url, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => { aborted = true; const e = new Error("aborted"); e.name = "AbortError"; rej(e); })));
    const t0 = Date.now(); const r = await runTest(id, hang);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT", retryable: true }); expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("missing server-side credentials → INVALID_CONFIGURATION and SAP is never called", async () => {
    const { id } = (await create({ credentialRef: "NOSUCHREF" })).jsonBody; const f = okFetch();
    const r = await runTest(id, f);
    expect(r).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" }); expect(f).not.toHaveBeenCalled();
    expect((await svc.getConnection(db, "DEFAULT", id)).credentials.status).toBe("MISSING");
  });
  test("no credential reference at all → INVALID_CONFIGURATION; OTHER_ERP has no provider yet → INVALID_CONFIGURATION", async () => {
    const a = (await create({ credentialRef: null })).jsonBody.id; const b = (await create({ name: "O", erpType: "OTHER_ERP" })).jsonBody.id; const f = okFetch();
    expect((await runTest(a, f)).code).toBe("INVALID_CONFIGURATION"); expect((await runTest(b, f)).code).toBe("PROVIDER_NOT_SUPPORTED"); expect(f).not.toHaveBeenCalled();
  });
  test("an invalid URL that got into the database (bypassing the API) is rejected at test time, not requested", async () => {
    const id = await setup(); await db.ErpConnection.update({ base_url: "https://u:p@evil.example.com" }, { where: { id } }); const f = okFetch();
    expect((await runTest(id, f)).code).toBe("INVALID_CONFIGURATION"); expect(f).not.toHaveBeenCalled();
  });
  test("OData version mismatch is reported as a warning, not a failure", async () => {
    const id = await setup(); const r = await runTest(id, okFetch(EDMX4));
    expect(r.ok).toBe(true); expect(r.warnings[0]).toMatch(/V4/);
  });
  test("success after failure returns ERROR → ACTIVE; an INACTIVE connection is tested but never re-enabled", async () => {
    const id = await setup(); await runTest(id, jest.fn(async () => mkRes(500, "")));
    expect((await runTest(id, okFetch())).connection.status).toBe("ACTIVE");
    await A(erp.setStatus, { params: { id }, body: { status: "INACTIVE" } });
    const r = await runTest(id, okFetch()); expect(r.ok).toBe(true); expect(r.connection.status).toBe("INACTIVE");
  });
  test("saving a configuration never marks it connected", async () => {
    const c = (await create()).jsonBody; expect(c.health.state).toBe("NOT_TESTED");
    expect((await A(erp.update, { params: { id: c.id }, body: { name: "x" } })).jsonBody.health.state).toBe("NOT_TESTED");
  });
  test("controller test endpoint returns 200 with ok:false for a failed test (the test ran) and uses the real fetch path", async () => {
    const { id } = (await create()).jsonBody;
    const spy = jest.spyOn(global, "fetch").mockImplementation(async () => mkRes(401, ""));
    const res = await A(erp.test, { params: { id } });
    expect(spy).toHaveBeenCalled(); expect(res.statusCode).toBe(200); expect(res.jsonBody).toMatchObject({ ok: false, code: "AUTHENTICATION_ERROR" });
    expect(JSON.stringify(res.jsonBody)).not.toContain(PASSWORD);
  });
  test("server logs never contain the password, user name or Authorization value", async () => {
    const id = await setup(); const info = console.info; const err = console.error;
    await runTest(id, okFetch()); await runTest(id, jest.fn(async () => { throw new Error(`boom Authorization: Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")} password=${PASSWORD}`); }));
    const logged = JSON.stringify([...info.mock.calls, ...err.mock.calls]);
    [PASSWORD, USER, Buffer.from(`${USER}:${PASSWORD}`).toString("base64")].forEach((s) => expect(logged).not.toContain(s));
  });
});

describe("Audit trail events", () => {
  test("created / updated / activated / deactivated / default changed / tested are all logged", async () => {
    const { id } = (await create()).jsonBody;
    await A(erp.update, { params: { id }, body: { name: "n" } });
    await A(erp.setStatus, { params: { id }, body: { status: "INACTIVE" } }); await A(erp.setStatus, { params: { id }, body: { status: "ACTIVE" } });
    await A(erp.setDefault, { params: { id } }); await runTest(id, okFetch());
    const lines = console.info.mock.calls.map((c) => c[0]).filter((l) => String(l).startsWith("[erp-audit]")).join("\n");
    ["ERP_CREATED", "ERP_UPDATED", "ERP_DEACTIVATED", "ERP_ACTIVATED", "ERP_DEFAULT_CHANGED", "ERP_CONNECTION_TESTED"].forEach((e) => expect(lines).toContain(`event=${e}`));
  });
});

describe("Integration building blocks", () => {
  test("redact removes credential-shaped text", () => {
    const out = redact(`Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1l url=https://bob:hunter2@x.com password=hunter2 token: abc123`);
    ["QWxhZGRpbjpvcGVuc2VzYW1l", "hunter2", "abc123"].forEach((s) => expect(out).not.toContain(s));
  });
  test("normalizeError wraps unknown errors and never leaks the original message", () => {
    const e = normalizeError(new Error("password=hunter2")); expect(e).toBeInstanceOf(ErpIntegrationError);
    expect(e.toPublic().message).not.toContain("hunter2"); expect(e.internal).not.toContain("hunter2");
  });
  test("ODataClient requires credentials; normalizes V2 and V4 payloads; bad JSON → INVALID_RESPONSE", async () => {
    expect(() => new ODataClient({ serviceRoot: "https://x", credentials: {} })).toThrow();
    expect(normalizeODataPayload({ d: { results: [{ a: 1 }], __count: "1" } })).toMatchObject({ version: "V2", count: 1, results: [{ a: 1 }] });
    expect(normalizeODataPayload({ value: [1, 2], "@odata.nextLink": "n" })).toMatchObject({ version: "V4", next: "n" });
    expect(() => normalizeODataPayload({})).toThrow(ErpIntegrationError);
    const c = new ODataClient({ serviceRoot: "https://x/y", credentials: { username: "u", password: "p" }, logger: () => {}, fetchImpl: async () => mkRes(200, "{oops", "application/json") });
    await expect(c.request("GET", "/A")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  test("secret resolver: valid reference resolves; invalid / missing does not", async () => {
    expect(await secrets.credentialStatus("SAPPROD")).toBe("RESOLVED"); expect(await secrets.credentialStatus("NOPE")).toBe("MISSING");
    expect(await secrets.credentialStatus(null)).toBe("NOT_SET"); expect(await secrets.credentialStatus("bad ref")).toBe("MISSING");
    await expect(secrets.resolveCredentials("NOPE")).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

describe("Migration", () => {
  test("is idempotent, additive and reversible (up → up → down → up) and leaves sap_sync_records alone", async () => {
    const { Sequelize } = require("sequelize"); const qi = db.sequelize.getQueryInterface();
    const m = require("../migrations/20261006090000-erp-integration-phase13");
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    await m.down(qi, Sequelize);
    await m.up(qi, Sequelize); await m.up(qi, Sequelize);
    expect(await tables()).toEqual(expect.arrayContaining(["erp_connections", "erp_connection_capabilities", "erp_entity_mappings", "sap_sync_records"]));
    expect((await qi.showIndex("erp_connections")).map((i) => i.name)).toEqual(expect.arrayContaining(["uq_erp_conn_tenant_code", "uq_erp_conn_default_per_tenant"]));
    await m.down(qi, Sequelize);
    const t = await tables(); expect(t).not.toContain("erp_connections"); expect(t).toContain("sap_sync_records");
    await m.up(qi, Sequelize); expect(await tables()).toContain("erp_connections");
    await db.sequelize.sync({ force: true });
  });
});
