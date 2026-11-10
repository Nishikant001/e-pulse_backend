// Phase 14 — Generic ERP Sync. Same in-memory sqlite + direct-service/controller convention as earlier phases.
// NO real ERP is contacted: every transport is a mock `fetch` that behaves like the ERP under test. A mocked 200 proves OUR
// handling of that protocol, not real connectivity (see PHASE14_DELIVERABLES.md → Real ERP verification).
const { db, resetDb, mockRes, seedDistributor } = require("./helpers");
const erp = require("../controllers/admin.erp.controller");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const registry = require("../services/erp/providerRegistry");
const mgr = require("../services/erp/connectionManager");
const { implementsContract, ErpProvider } = require("../services/erp/providerContract");
const auth = require("../services/erp/authStrategies");
const pcfg = require("../services/erp/providerConfig");
const { buildPageRequest, readPageResult } = require("../services/erp/restPagination");
const { runSync, LIMITS } = require("../services/erp/sync/syncEngine");
const { TRANSFORMS, parseTransformList } = require("../services/erp/sync/transforms");
const { mapRecord } = require("../services/erp/sync/mapper");
const adminRoutes = require("../routes/adminRoutes");
const requireAdmin = require("../middleware/adminAuth");

const SAP_PW = "Sap-Pw-9!"; const REST_KEY = "rest-key-ABC123"; const BEARER = "bearer-tok-XYZ789";
beforeAll(() => {
  Object.assign(process.env, { ERP_SAPPROD_USERNAME: "SAPUSER", ERP_SAPPROD_PASSWORD: SAP_PW, ERP_RESTKEY_API_KEY: REST_KEY, ERP_RESTBEARER_TOKEN: BEARER });
});
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(async () => { await db.sequelize.close(); });

const T = "DEFAULT";
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const json = (status, obj, ct = "application/json") => ({ status, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)), headers: { get: (h) => (h.toLowerCase() === "content-type" ? ct : null) } });
const deps = (fetchImpl, extra = {}) => ({ await: true, fetchImpl, logger: () => {}, retryDelayMs: 0, ...extra });
const wait = async (id, ms = 3000) => { const end = Date.now() + ms; for (;;) { const j = await db.ErpSyncJob.findByPk(id); if (j && !["QUEUED", "RUNNING"].includes(j.status)) return j; if (Date.now() > end) throw new Error("job did not finish"); await new Promise((r) => setTimeout(r, 15)); } };

// ── world: a distributor + HSN, and three differently-shaped ERPs ──
async function world() {
  const d = await seedDistributor();
  const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });
  return { d, hsn, scope: { distributorId: d.id, hsnId: hsn.id } };
}
const SAP_BASE = "https://sap.example.com"; const SAP_PATH = "/sap/opu/odata/sap/API_PRODUCT_SRV";
const sapConn = (o = {}) => conns.createConnection(db, T, 1, { name: "SAP Production", erpType: "SAP_S4HANA", environment: "PRODUCTION", baseUrl: SAP_BASE, odataServicePath: SAP_PATH, sapClient: "100", credentialRef: "SAPPROD", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/A_Product" }], ...o });
const restConn = (o = {}) => conns.createConnection(db, T, 1, { name: "Oracle Production", erpType: "ORACLE_ERP", provider: "GENERIC_REST", authType: "API_KEY", authHeaderName: "X-Api-Key", environment: "PRODUCTION", baseUrl: "https://oracle.example.com", odataServicePath: "/api", credentialRef: "RESTKEY", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/items", config: { responsePath: "data.items", pagination: { type: "PAGE_NUMBER", pageSize: 2, totalPath: "data.total" } } }], ...o });
const bearerConn = (o = {}) => conns.createConnection(db, T, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/materials", config: { pagination: { type: "OFFSET_LIMIT", pageSize: 2, totalPath: "total" }, responsePath: "rows" } }], ...o });

const SAP_MAP = [{ sourceField: "Product", isKey: true }, { sourceField: "ProductDescription", dmsField: "name", transform: ["trim"] }, { sourceField: "BaseUnit", dmsField: "unit", transform: ["uppercase"] }, { sourceField: "NetPrice", dmsField: "mrp", transform: ["to_number"] }];
const REST_MAP = [{ sourceField: "ItemNumber", isKey: true }, { sourceField: "title", dmsField: "name" }, { sourceField: "uom", dmsField: "unit" }];
const CUSTOM_MAP = [{ sourceField: "MATNR", isKey: true, transform: ["strip_leading_zeros"] }, { sourceField: "descr", dmsField: "name" }];
const map = (c, rows, cap = "PRODUCT_MASTER") => sync.saveMappings(db, T, 1, c.id, cap, { mappings: rows });

// SAP OData V2 mock: pages of `rows`, 2 per page, linked by __next
function sapFetch(rows, { calls = [] } = {}) {
  return jest.fn(async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/$metadata")) return json(200, '<edmx:Edmx Version="1.0" xmlns:edmx="x"></edmx:Edmx>', "application/xml");
    const skip = Number(u.searchParams.get("$skiptoken") || 0);
    const slice = rows.slice(skip, skip + 2);
    const more = skip + 2 < rows.length;
    return json(200, { d: { results: slice.map((r) => ({ __metadata: { uri: "x" }, ...r })), ...(more ? { __next: `${SAP_BASE}${SAP_PATH}/A_Product?$skiptoken=${skip + 2}` } : {}) } });
  });
}
const SAP_ROWS = [
  { Product: "1001", ProductDescription: "  Paracetamol 500  ", BaseUnit: "pcs", NetPrice: "12.50", CreationDate: "/Date(1700000000000)/" },
  { Product: "1002", ProductDescription: "Amoxicillin 250", BaseUnit: "box", NetPrice: "40" },
  { Product: "1003", ProductDescription: "Cetirizine 10", BaseUnit: "pcs", NetPrice: "8" },
];
// REST mock (page-number pagination, data.items / data.total)
function restFetch(items, { calls = [], status = 200 } = {}) {
  return jest.fn(async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return json(status, {});
    const u = new URL(url); const page = Number(u.searchParams.get("page") || 1); const size = Number(u.searchParams.get("pageSize") || 2);
    return json(200, { data: { items: items.slice((page - 1) * size, page * size), total: items.length } });
  });
}
const REST_ROWS = [{ ItemNumber: "A-1", title: "Ibuprofen", uom: "PCS" }, { ItemNumber: "A-2", title: "Azithromycin", uom: "BOX" }, { ItemNumber: "A-3", title: "Omeprazole", uom: "PCS" }];
const products = (distributorId) => db.Product.findAll({ where: { distributor_id: distributorId }, order: [["id", "ASC"]] });
const start = (c, scope, d, cap = "PRODUCT_MASTER") => sync.startSync(db, T, 1, { connectionId: c.id, capability: cap, scope }, d);

// ═════════════════════════════ providers ═════════════════════════════
describe("Provider registry & resolution", () => {
  test("statuses are honest: SAP + Generic REST implemented; Oracle/Dynamics foundation only; SOAP future", () => {
    const s = Object.fromEntries(registry.listProviders().map((p) => [p.key, p.status]));
    expect(s).toEqual({ SAP_ODATA: "IMPLEMENTED", GENERIC_REST: "IMPLEMENTED", ORACLE_REST: "FOUNDATION_ONLY", DYNAMICS_REST: "FOUNDATION_ONLY", GENERIC_SOAP: "FUTURE" });
  });
  test("erp_type → provider: SAP→SAP_ODATA, custom→GENERIC_REST, oracle→ORACLE_REST, tally→none; explicit provider wins", () => {
    const k = (o) => registry.resolveProviderKey(o);
    expect(k({ erp_type: "SAP_ECC" })).toBe("SAP_ODATA"); expect(k({ erp_type: "SAP_S4HANA" })).toBe("SAP_ODATA");
    expect(k({ erp_type: "CUSTOM_ERP" })).toBe("GENERIC_REST"); expect(k({ erp_type: "ORACLE_ERP" })).toBe("ORACLE_REST");
    expect(k({ erp_type: "MS_DYNAMICS" })).toBe("DYNAMICS_REST"); expect(k({ erp_type: "TALLY" })).toBeNull();
    expect(k({ erp_type: "ORACLE_ERP", provider: "GENERIC_REST" })).toBe("GENERIC_REST");
  });
  test("implemented providers satisfy the provider contract; the base class refuses unimplemented writes (never a fake success)", async () => {
    const sap = await mgr.buildProvider({ erp_type: "SAP_S4HANA", auth_type: "BASIC", base_url: SAP_BASE, odata_service_path: SAP_PATH, credential_ref: "SAPPROD", timeout_ms: 1000 });
    const rest = await mgr.buildProvider({ erp_type: "CUSTOM_ERP", auth_type: "BEARER_TOKEN", base_url: "https://x.example.com", credential_ref: "RESTBEARER", timeout_ms: 1000 });
    [sap, rest].forEach((p) => { expect(implementsContract(p)).toBe(true); expect(p.supports).toEqual({ fetch: true, create: true, update: true, delete: false }); }); // Phase 16: providers can write (create / update); delete never
    await expect(new ErpProvider().create()).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" }); await expect(rest.delete()).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
    await expect(new ErpProvider().testConnection()).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
  });
  test("PROVIDER_NOT_SUPPORTED for foundation / future / unknown / unselected — and NEVER a fallback to SAP (no request is made)", async () => {
    const f = jest.fn();
    const base = { auth_type: "BASIC", base_url: "https://x.example.com", credential_ref: "SAPPROD", timeout_ms: 1000 };
    for (const o of [{ erp_type: "ORACLE_ERP" }, { erp_type: "MS_DYNAMICS" }, { erp_type: "TALLY" }, { erp_type: "OTHER_ERP" }, { erp_type: "SAP_ECC", provider: "GENERIC_SOAP" }, { erp_type: "SAP_ECC", provider: "NOPE" }]) {
      await expect(mgr.buildProvider({ ...base, ...o }, { fetchImpl: f })).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
    }
    expect(f).not.toHaveBeenCalled();
  });
  test("a provider rejects an authentication type it does not support", async () => {
    await expect(mgr.buildProvider({ erp_type: "SAP_ECC", auth_type: "BEARER_TOKEN", base_url: SAP_BASE, credential_ref: "RESTBEARER", timeout_ms: 1000 })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

describe("Authentication abstraction", () => {
  test("BASIC / BEARER_TOKEN / API_KEY build the right headers; future types are refused", () => {
    expect(auth.buildAuthHeaders("BASIC", { username: "u", password: "p" }).Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(auth.buildAuthHeaders("BEARER_TOKEN", { token: "t" })).toEqual({ Authorization: "Bearer t" });
    expect(auth.buildAuthHeaders("API_KEY", { apiKey: "k" }, { headerName: "X-Key" })).toEqual({ "X-Key": "k" });
    expect(auth.buildAuthHeaders("API_KEY", { apiKey: "k" })).toEqual({ "X-API-Key": "k" });
    for (const t of ["OAUTH2", "CLIENT_CERTIFICATE", "CUSTOM", "WHATEVER"]) expect(() => auth.buildAuthHeaders(t, {})).toThrow(/not available|Unknown/);
    expect(auth.isImplemented("BASIC")).toBe(true); expect(auth.isImplemented("OAUTH2")).toBe(false);
  });
  test("API key header names cannot be reserved or malformed (no header injection)", () => {
    for (const h of ["Authorization", "Host", "Cookie", "Content-Length", "X Bad", "X-Bad\r\nEvil: 1", ""]) expect(() => auth.validateHeaderName(h)).toThrow();
    expect(auth.validateHeaderName("X-Custom-Key")).toBe("X-Custom-Key");
  });
  test("secrets with control characters are refused", () => { expect(() => auth.buildAuthHeaders("BEARER_TOKEN", { token: "a\r\nX: y" })).toThrow(); });
  test("secrets are resolved per auth type from the server environment, never the database", async () => {
    const s = require("../services/erp/secretResolver");
    expect(await s.credentialStatus("RESTKEY", "API_KEY")).toBe("RESOLVED"); expect(await s.credentialStatus("RESTKEY", "BASIC")).toBe("MISSING");
    expect(await s.credentialStatus("SAPPROD", "BASIC")).toBe("RESOLVED"); expect(await s.credentialStatus("SAPPROD", "BEARER_TOKEN")).toBe("MISSING");
    expect(await s.resolveCredentials("RESTBEARER", "BEARER_TOKEN")).toEqual({ token: BEARER });
  });
  test("saving a connection: unsupported auth type / mismatch / header name rules (400); credentials never appear in responses", async () => {
    const bad = async (o) => (await A(erp.create, { body: { name: "x", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://a.example.com", credentialRef: "RESTKEY", authType: "API_KEY", ...o } })).statusCode;
    expect(await bad({ authType: "OAUTH2" })).toBe(400); expect(await bad({ authType: "NOPE" })).toBe(400);
    expect(await bad({ erpType: "SAP_ECC", authType: "API_KEY" })).toBe(400);            // SAP OData provider supports BASIC only
    expect(await bad({ authHeaderName: "Authorization" })).toBe(400);
    expect(await bad({ authType: "BASIC", authHeaderName: "X-A" })).toBe(400);
    const ok = await A(erp.create, { body: { name: "ok", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://a.example.com", credentialRef: "RESTKEY", authType: "API_KEY", authHeaderName: "X-Key" } });
    expect(ok.statusCode).toBe(201); expect(ok.jsonBody.credentials).toEqual({ reference: "RESTKEY", status: "RESOLVED" });
    expect(JSON.stringify(ok.jsonBody)).not.toContain(REST_KEY);
  });
});

describe("Provider configuration (allow-listed, no SSRF / injection surface)", () => {
  test("REST capability config: only known keys; credentials in query refused; bad paths refused", () => {
    expect(pcfg.validateRestCapabilityConfig({ responsePath: "data.items", pagination: { type: "page_number", pageSize: 50 }, query: { status: "A" } }).pagination.type).toBe("PAGE_NUMBER");
    for (const c of [{ headers: { X: "y" } }, { url: "http://evil" }, { query: { api_key: "x" } }, { query: { token: "x" } }, { responsePath: "a..b" }, { responsePath: "__proto__.x" }, { pagination: { type: "WARP" } }, { pagination: { pageSize: 99999 } }, { pagination: { script: "x" } }]) expect(() => pcfg.validateRestCapabilityConfig(c)).toThrow();
  });
  test("OData config accepts select/pageSize only; REST connection config accepts a safe testPath only", () => {
    expect(pcfg.validateODataCapabilityConfig({ select: ["Product"], pageSize: 20 })).toEqual({ select: ["Product"], pageSize: 20 });
    expect(() => pcfg.validateODataCapabilityConfig({ select: ["a;drop"] })).toThrow(); expect(() => pcfg.validateODataCapabilityConfig({ filter: "x" })).toThrow();
    expect(pcfg.validateRestConnectionConfig({ testPath: "/health" })).toEqual({ testPath: "/health" });
    for (const p of ["health", "/a/../b", "/a?b=1", "//x"]) expect(() => pcfg.validateRestConnectionConfig({ testPath: p })).toThrow();
  });
  test("config is validated against the connection's provider on save; foundation providers accept none", async () => {
    const mk = (o) => A(erp.create, { body: { name: "c", erpType: "CUSTOM_ERP", environment: "TEST", baseUrl: "https://a.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN", ...o } });
    expect((await mk({ capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/x", config: { headers: { A: "b" } } }] })).statusCode).toBe(400);
    expect((await mk({ erpType: "ORACLE_ERP", capabilities: [{ capability: "PRODUCT_MASTER", config: { responsePath: "a" } }] })).statusCode).toBe(400);
    expect((await mk({ config: { testPath: "/health" }, capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/x", config: { responsePath: "rows" } }] })).statusCode).toBe(201);
  });
  test("getPath never walks prototypes", () => {
    expect(pcfg.getPath({ a: { b: 1 } }, "a.b")).toBe(1); expect(pcfg.getPath({}, "constructor")).toBeUndefined(); expect(pcfg.getPath({ a: [{ x: 5 }] }, "a.0.x")).toBe(5);
  });
});

describe("Pagination abstraction (provider-neutral)", () => {
  test("PAGE_NUMBER / OFFSET_LIMIT / NEXT_URL / CURSOR translate to {nextCursor, hasMore}", () => {
    const pn = { type: "PAGE_NUMBER", pageSize: 2, totalPath: "t" };
    expect(buildPageRequest(pn, null, 2).query).toEqual({ page: 1, pageSize: 2 });
    expect(readPageResult(pn, { t: 5 }, [1, 2], null, 2)).toMatchObject({ nextCursor: 2, hasMore: true, total: 5 });
    expect(readPageResult(pn, { t: 5 }, [1], 3, 2)).toMatchObject({ nextCursor: null, hasMore: false });
    const ol = { type: "OFFSET_LIMIT", pageSize: 2 };
    expect(buildPageRequest(ol, 4, 2).query).toEqual({ offset: 4, limit: 2 });
    expect(readPageResult(ol, {}, [1, 2], 4, 2)).toMatchObject({ nextCursor: 6, hasMore: true }); expect(readPageResult(ol, {}, [1], 6, 2).hasMore).toBe(false);
    const nu = { type: "NEXT_URL", nextPath: "links.next" };
    expect(buildPageRequest(nu, "https://x/y?p=2", 2).url).toBe("https://x/y?p=2"); expect(readPageResult(nu, { links: { next: "https://x/y?p=3" } }, [1], null, 2).nextCursor).toBe("https://x/y?p=3"); expect(readPageResult(nu, { links: {} }, [1], null, 2).hasMore).toBe(false);
    const cu = { type: "CURSOR", cursorParam: "after", cursorPath: "meta.next" };
    expect(buildPageRequest(cu, "abc", 2).query).toEqual({ after: "abc" }); expect(readPageResult(cu, { meta: { next: "def" } }, [1], null, 2).nextCursor).toBe("def"); expect(readPageResult(cu, { meta: {} }, [1], null, 2).hasMore).toBe(false);
    expect(readPageResult({ type: "NONE" }, {}, [1, 2, 3], null, 2).hasMore).toBe(false);
  });
});

// ═════════════════════════════ error normalization ═════════════════════════════
describe("Error normalization across providers (same categories regardless of ERP)", () => {
  const cases = [
    ["401", () => json(401, {}), "AUTHENTICATION_ERROR"], ["403", () => json(403, {}), "AUTHORIZATION_ERROR"], ["404", () => json(404, {}), "INVALID_ENDPOINT"],
    ["429", () => json(429, {}), "RATE_LIMITED"], ["500", () => json(500, {}), "SERVER_ERROR"], ["400", () => json(400, {}), "REQUEST_REJECTED"],
  ];
  test.each(cases)("HTTP %s → %s for SAP OData AND Generic REST", async (_s, make, code) => {
    const sap = await sapConn(); const rest = await bearerConn({ capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/materials" }], config: { testPath: "/health" } });
    for (const c of [sap, rest]) {
      const r = await conns.testConnection(db, T, 1, c.id, { fetchImpl: jest.fn(async () => make()), logger: () => {} });
      expect(r).toMatchObject({ ok: false, code });
    }
  });
  test("timeout → TIMEOUT and DNS failure → CONNECTION_ERROR (both retryable) for both providers", async () => {
    const sap = await sapConn(); const rest = await bearerConn({ config: { testPath: "/health" } });
    await db.ErpConnection.update({ timeout_ms: 1000 }, { where: { id: [sap.id, rest.id] } });
    const hang = jest.fn((u, init) => new Promise((_a, rej) => init.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; rej(e); })));
    const dns = jest.fn(async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; });
    for (const c of [sap, rest]) {
      expect(await conns.testConnection(db, T, 1, c.id, { fetchImpl: hang, logger: () => {} })).toMatchObject({ ok: false, code: "TIMEOUT", retryable: true });
      expect(await conns.testConnection(db, T, 1, c.id, { fetchImpl: dns, logger: () => {} })).toMatchObject({ ok: false, code: "CONNECTION_ERROR", retryable: true });
    }
  });
  test("a redirect is never followed (credentials stay on the configured host) and a non-JSON body is INVALID_RESPONSE", async () => {
    const rest = await bearerConn({ config: { testPath: "/health" } });
    const f = jest.fn(async () => json(302, ""));
    expect((await conns.testConnection(db, T, 1, rest.id, { fetchImpl: f, logger: () => {} })).code).toBe("INVALID_ENDPOINT"); expect(f.mock.calls[0][1].redirect).toBe("manual");
    expect((await conns.testConnection(db, T, 1, rest.id, { fetchImpl: async () => json(200, "<html/>", "text/html"), logger: () => {} })).code).toBe("INVALID_RESPONSE");
  });
  test("REST connection test: configured testPath, else one record of the first endpoint; with neither → INVALID_CONFIGURATION (no call)", async () => {
    const withPath = await bearerConn({ name: "P", config: { testPath: "/health" } });
    const f = jest.fn(async () => json(200, { ok: true }));
    expect((await conns.testConnection(db, T, 1, withPath.id, { fetchImpl: f, logger: () => {} })).ok).toBe(true); expect(f.mock.calls[0][0]).toBe("https://custom.example.com/health");
    const noPath = await bearerConn({ name: "N" }); const g = jest.fn(async () => json(200, { rows: [], total: 0 }));
    expect((await conns.testConnection(db, T, 1, noPath.id, { fetchImpl: g, logger: () => {} })).ok).toBe(true); expect(g.mock.calls[0][0]).toContain("/materials?");
    const none = await bearerConn({ name: "X", capabilities: [] }); const h = jest.fn();
    expect(await conns.testConnection(db, T, 1, none.id, { fetchImpl: h, logger: () => {} })).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" }); expect(h).not.toHaveBeenCalled();
  });
  test("Oracle / Dynamics foundation providers: testing returns PROVIDER_NOT_SUPPORTED honestly, never 'connected'", async () => {
    const o = await conns.createConnection(db, T, 1, { name: "Oracle", erpType: "ORACLE_ERP", environment: "TEST", baseUrl: "https://o.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN" });
    const f = jest.fn();
    const r = await conns.testConnection(db, T, 1, o.id, { fetchImpl: f, logger: () => {} });
    expect(r).toMatchObject({ ok: false, code: "PROVIDER_NOT_SUPPORTED" }); expect(f).not.toHaveBeenCalled();
    expect(r.connection.provider).toMatchObject({ key: "ORACLE_REST", status: "FOUNDATION_ONLY" });
  });
});

// ═════════════════════════════ mapping & transformation ═════════════════════════════
describe("Transformations (fixed allow-list, no code execution)", () => {
  test("each transform", () => {
    expect(TRANSFORMS.trim("  a ")).toBe("a"); expect(TRANSFORMS.uppercase("ab")).toBe("AB"); expect(TRANSFORMS.lowercase("AB")).toBe("ab");
    expect(TRANSFORMS.strip_leading_zeros("000123")).toBe("123"); expect(TRANSFORMS.strip_leading_zeros("000")).toBe("0");
    expect(TRANSFORMS.to_number("1,234.50")).toBe(1234.5); expect(TRANSFORMS.to_date("/".length ? "2026-03-04T10:00:00Z" : "")).toBe("2026-03-04"); expect(TRANSFORMS.to_boolean("X")).toBe(true);
    expect(() => TRANSFORMS.to_number("abc")).toThrow(); expect(() => TRANSFORMS.to_date("nope")).toThrow(); expect(() => TRANSFORMS.to_boolean("maybe")).toThrow();
  });
  test("unknown / code-like transforms are refused; at most 5", () => {
    for (const s of ["eval", "constructor", "trim,process.exit()", "() => 1"]) expect(() => parseTransformList(s)).toThrow();
    expect(() => parseTransformList("trim,trim,trim,trim,trim,trim")).toThrow(); expect(parseTransformList("trim, uppercase")).toEqual(["trim", "uppercase"]);
  });
  test("mapRecord: three ERPs with different field names map into the same DMS fields; empty key is a MAPPING_ERROR", () => {
    const m = (rows) => rows.map((r) => ({ source_field: r.sourceField, dms_field: r.isKey ? "external_id" : r.dmsField, is_key: !!r.isKey, transform: (r.transform || []).join(",") }));
    expect(mapRecord({ Product: "7", ProductDescription: " Drug " }, m(SAP_MAP.slice(0, 2)))).toEqual({ externalId: "7", values: { name: "Drug" } });
    expect(mapRecord({ ItemNumber: "A-1", title: "Drug" }, m(REST_MAP.slice(0, 2)))).toEqual({ externalId: "A-1", values: { name: "Drug" } });
    expect(mapRecord({ MATNR: "000042", descr: "Drug" }, m(CUSTOM_MAP))).toEqual({ externalId: "42", values: { name: "Drug" } });
    expect(() => mapRecord({ ItemNumber: "", title: "x" }, m(REST_MAP))).toThrow(/key field/);
  });
});

describe("Mapping API (per connection + capability, tenant-scoped, whitelist)", () => {
  test("save → get round-trip; DMS entity is set by the server; replaces the previous set", async () => {
    const c = await sapConn();
    const r = await map(c, SAP_MAP);
    expect(r.mappings).toHaveLength(4); expect(r.mappings.find((x) => x.isKey).sourceField).toBe("Product"); expect(r.target.entityType).toBe("PRODUCT");
    expect((await db.ErpEntityMapping.findAll({ where: { connection_id: c.id } })).every((m) => m.dms_entity === "PRODUCT")).toBe(true);
    await map(c, SAP_MAP.slice(0, 2)); expect((await sync.getMappings(db, T, c.id, "PRODUCT_MASTER")).mappings).toHaveLength(2);
  });
  test("DMS-managed fields cannot be mapped (material_code, distributor_id, hsn_id, reorder_level, id, gst) → 400", async () => {
    const c = await sapConn();
    for (const f of ["material_code", "distributor_id", "hsn_id", "reorder_level", "id", "gst", "createdAt"]) {
      await expect(map(c, [{ sourceField: "Product", isKey: true }, { sourceField: "X", dmsField: "name" }, { sourceField: "Y", dmsField: f }])).rejects.toMatchObject({ statusCode: 400 });
    }
  });
  test("exactly one key, a name mapping, no duplicates, valid source paths, allow-listed transforms", async () => {
    const c = await sapConn(); const k = { sourceField: "P", isKey: true }; const n = { sourceField: "N", dmsField: "name" };
    for (const rows of [[n], [k, { sourceField: "Q", isKey: true }, n], [k], [k, n, { sourceField: "Z", dmsField: "name" }], [k, { sourceField: "a b", dmsField: "name" }], [k, { ...n, transform: ["eval"] }], [k, { ...n, sourceField: "__proto__.x" }]]) {
      await expect(map(c, rows)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: [] })).rejects.toMatchObject({ statusCode: 400 });
  });
  test("a capability with no DMS target cannot be mapped (409; Phase 15: STOCK needs a business decision, DOCUMENT is unsupported)", async () => {
    const c = await sapConn({ capabilities: [{ capability: "STOCK", endpointPath: "/c" }, { capability: "DOCUMENT", endpointPath: "/d" }] });
    await expect(map(c, SAP_MAP, "STOCK")).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" }); // Phase 16: STOCK has a target now; PRODUCT fields are not stock fields
    await expect(map(c, SAP_MAP, "INVOICE")).rejects.toMatchObject({ statusCode: 409, code: "BUSINESS_DECISION_REQUIRED" });
    await expect(map(c, SAP_MAP, "DOCUMENT")).rejects.toMatchObject({ statusCode: 409, code: "CAPABILITY_NOT_SUPPORTED" });
  });
  test("controller: PUT/GET mappings; unknown connection → 404", async () => {
    const c = await sapConn();
    expect((await A(erp.saveMappings, { params: { id: c.id, capability: "product_master" }, body: { mappings: SAP_MAP } })).statusCode).toBe(200);
    expect((await A(erp.getMappings, { params: { id: c.id, capability: "PRODUCT_MASTER" } })).jsonBody.mappings).toHaveLength(4);
    expect((await A(erp.getMappings, { params: { id: 999, capability: "PRODUCT_MASTER" } })).statusCode).toBe(404);
  });
});

// ═════════════════════════════ preflight (no ERP call, neutral codes) ═════════════════════════════
describe("Sync preflight", () => {
  test("MAPPING_NOT_CONFIGURED when no mapping — and the ERP is never contacted", async () => {
    const w = await world(); const c = await sapConn(); const f = sapFetch(SAP_ROWS);
    await expect(start(c, w.scope, deps(f))).rejects.toMatchObject({ statusCode: 409, code: "MAPPING_NOT_CONFIGURED" }); expect(f).not.toHaveBeenCalled();
    expect(await db.ErpSyncJob.count()).toBe(0);
  });
  test("capability not enabled / has no DMS target (customer, stock, sales…) / direction DMS→ERP / inactive / no endpoint", async () => {
    const w = await world(); const f = sapFetch(SAP_ROWS);
    const c = await sapConn({ capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/A_Product" }, { capability: "CUSTOMER_MASTER", endpointPath: "/c" }, { capability: "STOCK", endpointPath: "/s" }, { capability: "SALES", endpointPath: "/o" }] });
    await map(c, SAP_MAP);
    await expect(start(c, w.scope, deps(f), "STOCK")).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); // Phase 16: STOCK has a target but ownership is undecided
    await expect(start(c, w.scope, deps(f), "SALES")).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" }); // Phase 16: SALES defaults to DMS → ERP, nothing is read
    await expect(start(c, w.scope, deps(f), "CUSTOMER_MASTER")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIGURED" }); // Phase 15: has a target, but no mapping yet
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/A_Product", direction: "DMS_TO_ERP" }] });
    await expect(start(c, w.scope, deps(f))).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", message: expect.stringMatching(/DMS → ERP/) });
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [{ capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS" }] });
    await expect(start(c, w.scope, deps(f))).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/A_Product" }] });
    await conns.setStatus(db, T, 1, c.id, { status: "INACTIVE" });
    await expect(start(c, w.scope, deps(f))).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" }); expect(f).not.toHaveBeenCalled();
  });
  test("PROVIDER_NOT_SUPPORTED for Oracle/Dynamics/Tally without an implemented provider (no SAP fallback)", async () => {
    const w = await world(); const f = jest.fn();
    for (const [erpType, name] of [["ORACLE_ERP", "O"], ["MS_DYNAMICS", "D"], ["TALLY", "T"]]) {
      const c = await conns.createConnection(db, T, 1, { name, erpType, environment: "TEST", baseUrl: "https://z.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/p" }] });
      await db.ErpEntityMapping.create({ connection_id: c.id, capability: "PRODUCT_MASTER", source_field: "id", dms_field: "external_id", dms_entity: "PRODUCT", is_key: true });
      await expect(start(c, w.scope, deps(f))).rejects.toMatchObject({ statusCode: 409, code: "PROVIDER_NOT_SUPPORTED" });
    }
    expect(f).not.toHaveBeenCalled();
  });
  test("scope: distributor and HSN are required, must exist and belong together (400)", async () => {
    const w = await world(); const other = await seedDistributor(); const c = await sapConn(); await map(c, SAP_MAP); const f = sapFetch(SAP_ROWS);
    for (const scope of [undefined, {}, { distributorId: w.d.id }, { distributorId: 9999, hsnId: w.hsn.id }, { distributorId: other.id, hsnId: w.hsn.id }, { distributorId: "x", hsnId: 1 }]) await expect(start(c, scope, deps(f))).rejects.toMatchObject({ statusCode: 400 });
    expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════ the engine, through two different providers ═════════════════════════════
describe("Generic Sync Engine ← SAP OData provider", () => {
  test("SAP → provider → engine → mapping → Product: creates, trims/uppercases/converts, follows __next, links external ids, never leaks the secret", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const calls = []; const f = sapFetch(SAP_ROWS, { calls });
    const job = await start(c, w.scope, deps(f));
    const j = await sync.getJob(db, T, job.id);
    expect(j).toMatchObject({ status: "SUCCESS", provider: { key: "SAP_ODATA" }, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", trigger: "MANUAL", counts: { total: 3, processed: 3, created: 3, success: 3, failed: 0, skipped: 0 } });
    const ps = await products(w.d.id);
    expect(ps.map((p) => [p.name, p.unit, Number(p.mrp)])).toEqual([["Paracetamol 500", "PCS", 12.5], ["Amoxicillin 250", "BOX", 40], ["Cetirizine 10", "PCS", 8]]);
    expect(ps.every((p) => p.hsn_id === w.hsn.id && p.distributor_id === w.d.id && /^MTC\d+$/.test(p.material_code))).toBe(true);
    expect(calls).toHaveLength(2);                                                      // 2 pages, second via the ERP's own __next link
    expect(calls[0].url).toContain("sap-client=100"); expect(calls[0].url).toContain("%24top=100"); expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.headers.Authorization).toBe("Basic " + Buffer.from(`SAPUSER:${SAP_PW}`).toString("base64"));
    expect(JSON.stringify([j, await sync.listJobErrors(db, T, job.id), await conns.getConnection(db, T, c.id)])).not.toMatch(new RegExp(`${SAP_PW}|SAPUSER|Basic `));
    expect(console.info.mock.calls.flat().join("\n")).not.toContain(SAP_PW);
    expect(j.correlationId).toBeTruthy(); expect(calls[0].init.headers["X-Correlation-ID"]).toBe(j.correlationId);
  });
  test("IDEMPOTENT: the same sync twice creates no duplicates — second run skips everything", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    await start(c, w.scope, deps(sapFetch(SAP_ROWS)));
    const before = (await products(w.d.id)).map((p) => p.id);
    const second = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS)))).id);
    expect(second.counts).toMatchObject({ total: 3, created: 0, updated: 0, skipped: 3, failed: 0 }); expect(second.status).toBe("SUCCESS");
    expect((await products(w.d.id)).map((p) => p.id)).toEqual(before); expect(await db.ErpExternalLink.count()).toBe(3);
  });
  test("a changed ERP record UPDATES the same product; DMS-managed fields (code, HSN, reorder level, tax) are untouched", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    await start(c, w.scope, deps(sapFetch(SAP_ROWS)));
    const p0 = (await products(w.d.id))[0]; await p0.update({ reorder_level: 77, gst: 5 });
    const changed = SAP_ROWS.map((r) => (r.Product === "1001" ? { ...r, NetPrice: "15.00", ProductDescription: "Paracetamol 650" } : r));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(changed)))).id);
    expect(j.counts).toMatchObject({ updated: 1, skipped: 2, created: 0 });
    const p1 = await db.Product.findByPk(p0.id);
    expect([p1.name, Number(p1.mrp)]).toEqual(["Paracetamol 650", 15]); expect([p1.material_code, p1.hsn_id, p1.reorder_level, Number(p1.gst)]).toEqual([p0.material_code, p0.hsn_id, 77, 5]);
    expect(await products(w.d.id)).toHaveLength(3);
  });
  test("a product deleted in the DMS is re-created and re-linked (no orphan link, no duplicate)", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    await start(c, w.scope, deps(sapFetch(SAP_ROWS)));
    const victim = (await products(w.d.id))[1]; await victim.destroy();
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS)))).id);
    expect(j.counts).toMatchObject({ created: 1, skipped: 2 }); expect(await products(w.d.id)).toHaveLength(3); expect(await db.ErpExternalLink.count()).toBe(3);
  });
  test("one bad record does not stop the others: PARTIAL, with a per-record error (code, external id, retryable=false) and no payload", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const rows = [SAP_ROWS[0], { Product: "BAD", ProductDescription: "Broken", BaseUnit: "pcs", NetPrice: "abc" }, SAP_ROWS[2]];
    const job = await start(c, w.scope, deps(sapFetch(rows))); const j = await sync.getJob(db, T, job.id);
    expect(j).toMatchObject({ status: "PARTIAL", counts: { total: 3, created: 2, failed: 1 } });
    const e = (await sync.listJobErrors(db, T, job.id)).items;
    expect(e).toHaveLength(1); expect(e[0]).toMatchObject({ externalId: "BAD", code: "MAPPING_ERROR", retryable: false, recordIndex: 1 }); expect(e[0].message).not.toMatch(/Broken/);
    expect(await products(w.d.id)).toHaveLength(2);
  });
  test("validation: a record without a name is a VALIDATION_ERROR; all-bad run → FAILED", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch([{ Product: "9", ProductDescription: "", BaseUnit: "x", NetPrice: "1" }])))).id);
    expect(j.status).toBe("FAILED"); expect((await sync.listJobErrors(db, T, j.id)).items[0].code).toBe("VALIDATION_ERROR"); expect(await products(w.d.id)).toHaveLength(0);
  });
  test("transient errors are retried (boundedly); a 500 twice then OK still succeeds", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const good = sapFetch(SAP_ROWS.slice(0, 2)); let n = 0;
    const flaky = jest.fn(async (u, i) => (++n <= 2 ? json(500, {}) : good(u, i)));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(flaky))).id);
    expect(j.status).toBe("SUCCESS"); expect(flaky).toHaveBeenCalledTimes(3);
  });
  test("…but never endlessly: persistent 500 stops after 3 attempts → FAILED (SERVER_ERROR); 429 likewise → RATE_LIMITED", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const f = jest.fn(async () => json(500, {})); const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j).toMatchObject({ status: "FAILED", error: { code: "SERVER_ERROR" } }); expect(f).toHaveBeenCalledTimes(LIMITS.fetchAttempts);
    const g = jest.fn(async () => json(429, {})); const j2 = await sync.getJob(db, T, (await start(c, w.scope, deps(g))).id);
    expect(j2.error.code).toBe("RATE_LIMITED"); expect(g).toHaveBeenCalledTimes(3);
  });
  test("non-transient errors are NOT retried: 401 → AUTHENTICATION_ERROR after exactly one request", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const f = jest.fn(async () => json(401, {}));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j).toMatchObject({ status: "FAILED", error: { code: "AUTHENTICATION_ERROR" }, canRetry: true }); expect(f).toHaveBeenCalledTimes(1);
  });
  test("failure on page 2 keeps page 1's work: PARTIAL with the neutral error code", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const ok = sapFetch(SAP_ROWS); let n = 0;
    const f = jest.fn(async (u, i) => (++n === 1 ? ok(u, i) : json(401, {})));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j).toMatchObject({ status: "PARTIAL", counts: { created: 2 }, error: { code: "AUTHENTICATION_ERROR" } }); expect(await products(w.d.id)).toHaveLength(2);
  });
  test("safety limits: max records → LIMIT_EXCEEDED; a repeated next-link → INVALID_RESPONSE (no endless loop); max pages", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS), { limits: { maxRecords: 1 } }))).id);
    expect(j).toMatchObject({ status: "PARTIAL", error: { code: "LIMIT_EXCEEDED" }, counts: { created: 1 } });
    const loop = jest.fn(async () => json(200, { d: { results: [{ Product: "L1", ProductDescription: "Loop", BaseUnit: "u", NetPrice: "1" }], __next: `${SAP_BASE}${SAP_PATH}/A_Product?$skiptoken=1` } }));
    const j2 = await sync.getJob(db, T, (await start(c, w.scope, deps(loop))).id);
    expect(j2.error.code).toBe("INVALID_RESPONSE"); expect(loop.mock.calls.length).toBeLessThanOrEqual(3);
    const j3 = await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS), { limits: { maxPages: 1 } }))).id);
    expect(j3.error.code).toBe("LIMIT_EXCEEDED");
  });
  test("a next link to a DIFFERENT host is never followed (credentials cannot be sent elsewhere)", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const f = jest.fn(async () => json(200, { d: { results: [SAP_ROWS[0]], __next: "https://evil.example.net/steal" } }));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j.error.code).toBe("INVALID_RESPONSE"); expect(f.mock.calls.every(([u]) => !u.includes("evil.example.net"))).toBe(true);
  });
});

describe("Generic Sync Engine ← Generic REST provider (Oracle-style and custom ERPs, same engine)", () => {
  test("REST (API key, PAGE_NUMBER) → engine → Product; only the configured API-key header is sent", async () => {
    const w = await world(); const c = await restConn(); await map(c, REST_MAP); const calls = []; const f = restFetch(REST_ROWS, { calls });
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j).toMatchObject({ status: "SUCCESS", provider: { key: "GENERIC_REST" }, counts: { total: 3, created: 3 } });
    expect((await products(w.d.id)).map((p) => p.name)).toEqual(["Ibuprofen", "Azithromycin", "Omeprazole"]);
    expect(calls).toHaveLength(2); expect(calls[0].url).toBe("https://oracle.example.com/api/items?page=1&pageSize=2");
    expect(calls[0].init.headers["X-Api-Key"]).toBe(REST_KEY); expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain(REST_KEY);
  });
  test("custom ERP (bearer token, OFFSET_LIMIT, leading-zero key transform)", async () => {
    const w = await world(); const c = await bearerConn(); await map(c, CUSTOM_MAP); const calls = [];
    const rows = [{ MATNR: "000042", descr: "Item 42" }, { MATNR: "000043", descr: "Item 43" }, { MATNR: "000044", descr: "Item 44" }];
    const f = jest.fn(async (url, init) => { calls.push({ url, init }); const u = new URL(url); const o = Number(u.searchParams.get("offset")); const l = Number(u.searchParams.get("limit")); return json(200, { rows: rows.slice(o, o + l), total: rows.length }); });
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(f))).id);
    expect(j.counts).toMatchObject({ total: 3, created: 3 }); expect(calls[0].init.headers.Authorization).toBe(`Bearer ${BEARER}`);
    expect((await db.ErpExternalLink.findAll()).map((l) => l.external_id).sort()).toEqual(["42", "43", "44"]); expect(calls[1].url).toContain("offset=2");
  });
  test("the response path must lead to a list; an object / missing path is INVALID_RESPONSE", async () => {
    const w = await world(); const c = await restConn(); await map(c, REST_MAP);
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(jest.fn(async () => json(200, { data: { items: { not: "a list" } } }))))).id);
    expect(j).toMatchObject({ status: "FAILED", error: { code: "INVALID_RESPONSE" } });
  });
  test("idempotent for REST too", async () => {
    const w = await world(); const c = await restConn(); await map(c, REST_MAP);
    await start(c, w.scope, deps(restFetch(REST_ROWS)));
    const j = await sync.getJob(db, T, (await start(c, w.scope, deps(restFetch(REST_ROWS)))).id);
    expect(j.counts).toMatchObject({ skipped: 3, created: 0 }); expect(await products(w.d.id)).toHaveLength(3);
  });
});

describe("Multi-ERP (one tenant, three ERPs)", () => {
  test("SAP + Oracle (via REST) + Dynamics coexist; Dynamics cannot sync (foundation only); SAP and Oracle sync independently", async () => {
    const w = await world();
    const sap = await sapConn(); const ora = await restConn();
    const dyn = await conns.createConnection(db, T, 1, { name: "Dynamics", erpType: "MS_DYNAMICS", environment: "PRODUCTION", baseUrl: "https://d.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/p" }] });
    await map(sap, SAP_MAP); await map(ora, REST_MAP);
    const list = (await A(erp.list)).jsonBody;
    expect(list.items.map((i) => [i.name, i.provider.key, i.provider.status])).toEqual(expect.arrayContaining([["SAP Production", "SAP_ODATA", "IMPLEMENTED"], ["Oracle Production", "GENERIC_REST", "IMPLEMENTED"], ["Dynamics", "DYNAMICS_REST", "FOUNDATION_ONLY"]]));
    const a = await start(sap, w.scope, deps(sapFetch(SAP_ROWS))); const b = await start(ora, w.scope, deps(restFetch(REST_ROWS)));
    expect((await sync.getJob(db, T, a.id)).status).toBe("SUCCESS"); expect((await sync.getJob(db, T, b.id)).status).toBe("SUCCESS");
    expect(await products(w.d.id)).toHaveLength(6);
    await db.ErpEntityMapping.create({ connection_id: dyn.id, capability: "PRODUCT_MASTER", source_field: "id", dms_field: "external_id", dms_entity: "PRODUCT", is_key: true });
    await expect(start(dyn, w.scope, deps(jest.fn()))).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
    expect((await A(erp.list)).jsonBody.items.find((i) => i.name === "SAP Production").lastSync).toMatchObject({ status: "SUCCESS", capability: "PRODUCT_MASTER" });
  });
  test("the SAME ERP code in two ERPs is two separate external identities (links are per connection)", async () => {
    const w = await world(); const sap = await sapConn(); const ora = await restConn(); await map(sap, SAP_MAP); await map(ora, REST_MAP);
    await start(sap, w.scope, deps(sapFetch([SAP_ROWS[0]]))); await start(ora, w.scope, deps(restFetch([{ ItemNumber: "1001", title: "Other ERP product", uom: "PCS" }])));
    const links = await db.ErpExternalLink.findAll({ where: { external_id: "1001" } });
    expect(links).toHaveLength(2); expect(new Set(links.map((l) => l.connection_id)).size).toBe(2); expect(new Set(links.map((l) => l.dms_entity_id)).size).toBe(2);
  });
});

// ═════════════════════════════ concurrency, retry, history ═════════════════════════════
describe("Concurrency", () => {
  test("two syncs of the same tenant+ERP+capability cannot run together (409); the guard releases when the job ends", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    let release; const gate = new Promise((r) => { release = r; }); const inner = sapFetch(SAP_ROWS);
    const slow = jest.fn(async (u, i) => { await gate; return inner(u, i); });
    const first = await sync.startSync(db, T, 1, { connectionId: c.id, capability: "PRODUCT_MASTER", scope: w.scope }, { fetchImpl: slow, logger: () => {}, retryDelayMs: 0 });
    await expect(start(c, w.scope, deps(sapFetch(SAP_ROWS)))).rejects.toMatchObject({ statusCode: 409, code: "SYNC_ALREADY_RUNNING" });
    release(); expect((await wait(first.id)).status).toBe("SUCCESS");
    expect((await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS)))).id)).status).toBe("SUCCESS");
    expect((await db.ErpSyncJob.findByPk(first.id)).active_key).toBeNull();
  });
  test("the database itself refuses two active jobs for the same key (unique active_key)", async () => {
    const w = await world(); const c = await sapConn(); const row = { tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", active_key: `${T}:${c.id}:PRODUCT_MASTER`, scope: w.scope };
    await db.ErpSyncJob.create(row); await expect(db.ErpSyncJob.create(row)).rejects.toThrow();
    await db.ErpSyncJob.create({ ...row, status: "SUCCESS", active_key: null }); await db.ErpSyncJob.create({ ...row, status: "FAILED", active_key: null }); // finished jobs never conflict
  });
  test("different capabilities / different ERPs may run at once (different keys)", async () => {
    const w = await world(); const a = await sapConn(); const b = await restConn(); await map(a, SAP_MAP); await map(b, REST_MAP);
    await db.ErpSyncJob.create({ tenant_key: T, connection_id: a.id, capability: "PRICING", direction: "ERP_TO_DMS", status: "RUNNING", active_key: `${T}:${a.id}:PRICING` });
    expect((await sync.getJob(db, T, (await start(a, w.scope, deps(sapFetch(SAP_ROWS)))).id)).status).toBe("SUCCESS");
    expect((await sync.getJob(db, T, (await start(b, w.scope, deps(restFetch(REST_ROWS)))).id)).status).toBe("SUCCESS");
  });
  test("a crashed (stale) job no longer blocks: it is closed as FAILED and a new sync starts", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const stale = await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", active_key: `${T}:${c.id}:PRODUCT_MASTER`, heartbeat_at: new Date(Date.now() - 3600 * 1000) });
    expect((await sync.getJob(db, T, (await start(c, w.scope, deps(sapFetch(SAP_ROWS)))).id)).status).toBe("SUCCESS");
    expect(await db.ErpSyncJob.findByPk(stale.id)).toMatchObject({ status: "FAILED", active_key: null, error_code: "INTERNAL_ERROR" });
  });
});

describe("Retry", () => {
  test("a FAILED / PARTIAL job can be retried as a NEW job (trigger RETRY, attempt+1); success / running jobs cannot; bounded to 3 attempts", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const j1 = await start(c, w.scope, deps(jest.fn(async () => json(500, {}))));
    expect((await sync.getJob(db, T, j1.id))).toMatchObject({ status: "FAILED", canRetry: true });
    const r = await sync.retryJob(db, T, 1, j1.id, deps(sapFetch(SAP_ROWS)));
    expect(r).toMatchObject({ trigger: "RETRY", attempt: 2, retryOfJobId: j1.id, status: "SUCCESS" }); expect(await products(w.d.id)).toHaveLength(3);
    await expect(sync.retryJob(db, T, 1, r.id, deps(sapFetch(SAP_ROWS)))).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE" });
    const f2 = await sync.retryJob(db, T, 1, (await start(c, w.scope, deps(jest.fn(async () => json(401, {}))))).id, deps(jest.fn(async () => json(401, {}))));
    expect(f2.attempt).toBe(2); const f3 = await sync.retryJob(db, T, 1, f2.id, deps(jest.fn(async () => json(401, {})))); expect(f3.attempt).toBe(3);
    await expect(sync.retryJob(db, T, 1, f3.id, deps(sapFetch(SAP_ROWS)))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  test("retry is idempotent: records that already succeeded are skipped, not duplicated", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const ok = sapFetch(SAP_ROWS); let n = 0;
    const j1 = await start(c, w.scope, deps(jest.fn(async (u, i) => (++n === 1 ? ok(u, i) : json(500, {})))));
    expect((await sync.getJob(db, T, j1.id)).status).toBe("PARTIAL");
    const r = await sync.retryJob(db, T, 1, j1.id, deps(sapFetch(SAP_ROWS)));
    expect(r.counts).toMatchObject({ total: 3, skipped: 2, created: 1 }); expect(await products(w.d.id)).toHaveLength(3);
  });
});

describe("History, details & dashboard summary", () => {
  test("list with filters + pagination; job detail has ERP / provider / capability / direction / correlation id / duration", async () => {
    const w = await world(); const a = await sapConn(); const b = await restConn(); await map(a, SAP_MAP); await map(b, REST_MAP);
    await start(a, w.scope, deps(sapFetch(SAP_ROWS))); await start(b, w.scope, deps(jest.fn(async () => json(401, {}))));
    const all = await sync.listJobs(db, T, {}); expect(all.total).toBe(2); expect(all.items[0].connection).toMatchObject({ name: "Oracle Production", erpTypeLabel: "Oracle ERP" });
    expect((await sync.listJobs(db, T, { status: "failed" })).items).toHaveLength(1); expect((await sync.listJobs(db, T, { connectionId: a.id })).items[0].provider.key).toBe("SAP_ODATA");
    expect((await sync.listJobs(db, T, { pageSize: 1 })).items).toHaveLength(1);
    for (const q of [{ status: "x" }, { capability: "x" }, { trigger: "x" }, { page: 0 }, { connectionId: "a" }]) await expect(sync.listJobs(db, T, q)).rejects.toMatchObject({ statusCode: 400 });
    const d = await sync.getJob(db, T, all.items[1].id); expect(d).toMatchObject({ correlationId: expect.any(String), direction: "ERP_TO_DMS", capabilityLabel: "Product master" }); expect(typeof d.durationMs).toBe("number");
  });
  test("summary is real: empty tenant → zeros / null / hasSyncActivity=false; after activity → counts and last success", async () => {
    expect(await sync.getSummary(db, T)).toMatchObject({ connections: 0, activeConnections: 0, runningSyncs: 0, failedSyncsLast7Days: 0, lastSuccessfulSync: null, hasSyncActivity: false });
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    await start(c, w.scope, deps(jest.fn(async () => json(500, {})))); await start(c, w.scope, deps(sapFetch(SAP_ROWS)));
    expect(await sync.getSummary(db, T)).toMatchObject({ connections: 1, activeConnections: 1, runningSyncs: 0, failedSyncsLast7Days: 1, hasSyncActivity: true, lastSuccessfulSync: { capability: "PRODUCT_MASTER", connectionName: "SAP Production" } });
  });
});

// ═════════════════════════════ tenant isolation & authorization ═════════════════════════════
describe("Tenant isolation & authorization", () => {
  test("another tenant can never read, start, retry, map or inspect — foreign ids are 404 and the ERP is never called", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const job = await start(c, w.scope, deps(jest.fn(async () => json(401, {})))); const f = sapFetch(SAP_ROWS); const B = "TENANT_B";
    expect(await sync.getJob(db, B, job.id)).toBeNull(); expect(await sync.listJobErrors(db, B, job.id)).toBeNull(); expect(await sync.retryJob(db, B, 1, job.id, deps(f))).toBeNull();
    expect(await sync.startSync(db, B, 1, { connectionId: c.id, capability: "PRODUCT_MASTER", scope: w.scope }, deps(f))).toBeNull();
    expect(await sync.getMappings(db, B, c.id, "PRODUCT_MASTER")).toBeNull(); expect(await sync.saveMappings(db, B, 1, c.id, "PRODUCT_MASTER", { mappings: SAP_MAP })).toBeNull();
    expect((await sync.listJobs(db, B, {})).total).toBe(0); expect((await sync.listJobs(db, B, { connectionId: c.id })).total).toBe(0);
    expect(await sync.getSummary(db, B)).toMatchObject({ connections: 0, hasSyncActivity: false }); expect(f).not.toHaveBeenCalled();
    const asB = { admin: { id: 2, tenantKey: B } };
    for (const [fn, o] of [[erp.getJob, { params: { id: job.id } }], [erp.jobErrors, { params: { id: job.id } }], [erp.retryJob, { params: { id: job.id } }], [erp.startSync, { body: { connectionId: c.id, capability: "PRODUCT_MASTER", scope: w.scope } }], [erp.getMappings, { params: { id: c.id, capability: "PRODUCT_MASTER" } }]]) {
      expect((await A(fn, { ...o, ...asB })).statusCode).toBe(404);
    }
    expect((await db.ErpEntityMapping.count({ where: { connection_id: c.id } }))).toBe(4);   // untouched
  });
  test("the engine itself only loads a connection of the job's own tenant (a tampered job row cannot reach another tenant's ERP)", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP); const f = sapFetch(SAP_ROWS);
    const job = await db.ErpSyncJob.create({ tenant_key: "TENANT_B", connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "QUEUED", scope: w.scope, correlation_id: "x" });
    const done = await runSync(db, job.id, { fetchImpl: f, logger: () => {}, retryDelayMs: 0 });
    expect(done).toMatchObject({ status: "FAILED", error_code: "INVALID_CONFIGURATION" }); expect(f).not.toHaveBeenCalled(); expect(await products(w.d.id)).toHaveLength(0);
  });
  test("a tenantKey in the body / query / scope is ignored — the session decides", async () => {
    const w = await world(); const c = await sapConn(); await map(c, SAP_MAP);
    const spy = jest.spyOn(global, "fetch").mockImplementation(sapFetch(SAP_ROWS));
    const res = await A(erp.startSync, { body: { connectionId: c.id, capability: "PRODUCT_MASTER", scope: w.scope, tenantKey: "TENANT_B" }, query: { tenantKey: "TENANT_B" } });
    expect(res.statusCode).toBe(202); const j = await wait(res.jsonBody.id); expect(j.tenant_key).toBe("DEFAULT"); expect(j.status).toBe("SUCCESS"); expect(spy).toHaveBeenCalled();
  });
  test("every new route requires an Admin session", () => {
    const routes = adminRoutes.stack.filter((l) => l.route && (l.route.path.startsWith("/erp-sync") || l.route.path.includes("/mappings/")));
    expect(routes.length).toBe(19); // Phase 15 added errors, schedules, schedule detail, schedule run; Phase 16 added audit, alerts, outbound (POST + GET); Phase 18 added business overview + reconciliation (POST + GET)
    routes.forEach((l) => expect(l.route.stack[0].handle).toBe(requireAdmin));
  });
  test("controller flow: 202 + background run → history; validation failures are 4xx with neutral codes", async () => {
    const w = await world(); const c = await sapConn();
    expect((await A(erp.startSync, { body: { connectionId: c.id, capability: "PRODUCT_MASTER", scope: w.scope } })).jsonBody.code).toBe("MAPPING_NOT_CONFIGURED");
    expect((await A(erp.startSync, { body: { connectionId: c.id, capability: "NOPE" } })).statusCode).toBe(400);
    expect((await A(erp.startSync, { body: { connectionId: 999, capability: "PRODUCT_MASTER" } })).statusCode).toBe(404);
    expect((await A(erp.syncSummary)).jsonBody.hasSyncActivity).toBe(false);
  });
});

describe("Backward compatibility & neutrality", () => {
  test("legacy vendor-named directions are still accepted on input and stored neutrally", async () => {
    const c = await sapConn({ capabilities: [{ capability: "PRODUCT_MASTER", direction: "SAP_TO_DMS" }, { capability: "INVOICE", direction: "DMS_TO_SAP" }] });
    expect(c.capabilities.map((x) => x.direction).sort()).toEqual(["DMS_TO_ERP", "ERP_TO_DMS"]);
  });
  test("lookups expose providers with honest statuses, supported capabilities (only PRODUCT_MASTER syncs) and no SAP-only vocabulary in the generic model", async () => {
    const l = (await A(erp.lookups)).jsonBody;
    expect(l.providers.map((p) => p.status)).toEqual(expect.arrayContaining(["IMPLEMENTED", "FOUNDATION_ONLY", "FUTURE"]));
    expect(l.capabilities.filter((x) => x.syncSupported).map((x) => x.value)).toEqual(["PRODUCT_MASTER", "CUSTOMER_MASTER", "DISTRIBUTOR_MASTER", "PRICING", "STOCK", "SALES", "PAYMENT"]); // Phase 16 adds STOCK, SALES
    expect(l.erpTypes.find((t) => t.value === "ORACLE_ERP")).toMatchObject({ defaultProvider: "ORACLE_REST", supported: false });
    expect(l.erpTypes.find((t) => t.value === "CUSTOM_ERP").supported).toBe(true); expect(JSON.stringify(l.directions)).not.toMatch(/SAP/);
    expect(l.authTypesFuture).toEqual(["OAUTH2", "CLIENT_CERTIFICATE", "CUSTOM"]);
  });
  test("the generic engine, mapper, targets and registry-agnostic modules contain no SAP vocabulary", () => {
    const fs = require("fs"); const path = require("path");
    for (const f of ["syncEngine.js", "mapper.js", "targets.js", "transforms.js"]) expect(fs.readFileSync(path.join(__dirname, "../services/erp/sync", f), "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/\bsap\b|odata/i);
    for (const f of ["httpClient.js", "providerContract.js", "restPagination.js", "genericRestProvider.js", "authStrategies.js"]) expect(fs.readFileSync(path.join(__dirname, "../services/erp", f), "utf8").replace(/\/\/.*$/gm, "").replace(/odata_service_path/g, "service_path")).not.toMatch(/\bsap\b|odata/i);
  });
});

describe("Migration (Phase 13 → 14)", () => {
  test("up/down/up is idempotent and reversible; legacy directions, error codes and mapping columns are converted; existing rows survive", async () => {
    const { Sequelize } = require("sequelize"); const qi = db.sequelize.getQueryInterface();
    const m = require("../migrations/20261007090000-erp-sync-phase14");
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    await m.down(qi, Sequelize);                                       // → Phase 13 shape
    expect(await tables()).not.toContain("erp_sync_jobs"); expect(await cols("erp_entity_mappings")).toContain("sap_field"); expect(await cols("erp_connections")).not.toContain("provider");
    const now = new Date();
    await qi.bulkInsert("erp_connections", [{ tenant_key: "T1", code: "ERP-001", name: "Legacy", erp_type: "SAP_ECC", environment: "PRODUCTION", odata_version: "V2", base_url: "https://s.example.com", auth_type: "BASIC", timeout_ms: 10000, status: "ERROR", is_default: false, last_test_code: "NETWORK_ERROR", createdAt: now, updatedAt: now }]);
    await qi.bulkInsert("erp_connections", [{ tenant_key: "T1", code: "ERP-002", name: "Legacy 2", erp_type: "SAP_ECC", environment: "PRODUCTION", odata_version: "V2", base_url: "https://s2.example.com", auth_type: "BASIC", timeout_ms: 10000, status: "INACTIVE", is_default: false, createdAt: now, updatedAt: now }]);
    const [[conn]] = await db.sequelize.query("SELECT id FROM erp_connections WHERE code='ERP-001'");
    const [[conn2]] = await db.sequelize.query("SELECT id FROM erp_connections WHERE code='ERP-002'");
    await qi.bulkInsert("erp_connection_capabilities", [{ connection_id: conn.id, capability: "PRODUCT_MASTER", direction: "SAP_TO_DMS", enabled: true, createdAt: now, updatedAt: now }, { connection_id: conn2.id, capability: "INVOICE", direction: "DMS_TO_SAP", enabled: true, createdAt: now, updatedAt: now }]);
    await m.up(qi, Sequelize); await m.up(qi, Sequelize);              // idempotent
    expect(await tables()).toEqual(expect.arrayContaining(["erp_sync_jobs", "erp_sync_errors", "erp_external_links", "sap_sync_records"]));
    expect(await cols("erp_entity_mappings")).toEqual(expect.arrayContaining(["source_field", "source_entity"])); expect(await cols("erp_connections")).toEqual(expect.arrayContaining(["provider", "auth_header_name", "config"]));
    const [dirs] = await db.sequelize.query("SELECT direction FROM erp_connection_capabilities ORDER BY capability");
    expect(dirs.map((d) => d.direction)).toEqual(["DMS_TO_ERP", "ERP_TO_DMS"]);
    expect((await db.sequelize.query("SELECT last_test_code FROM erp_connections WHERE code='ERP-001'"))[0][0].last_test_code).toBe("CONNECTION_ERROR");
    expect((await qi.showIndex("erp_sync_jobs")).map((i) => i.name)).toContain("uq_erp_job_active_key");
    await db.sequelize.query("PRAGMA foreign_keys = OFF");         // sqlite emulates DROP COLUMN by rebuilding the table (MySQL does not)
    await m.down(qi, Sequelize);                                       // reversible: Phase 13 data vocabulary restored, rows kept
    expect((await db.sequelize.query("SELECT direction FROM erp_connection_capabilities ORDER BY capability"))[0].map((d) => d.direction)).toEqual(["DMS_TO_SAP", "SAP_TO_DMS"]);
    expect(await tables()).not.toContain("erp_sync_jobs"); expect(await tables()).toContain("erp_connections");
    await db.sequelize.query("PRAGMA foreign_keys = ON");
    await m.up(qi, Sequelize); expect(await tables()).toContain("erp_sync_jobs");
    await db.sequelize.sync({ force: true });
  });
});
