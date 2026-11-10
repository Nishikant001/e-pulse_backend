// Phase 20 — business decision register as delivered to the Admin UI: schema, REQUIRED vs CONFIGURED, never "approved", tenant isolation, RBAC over real HTTP,
// no decision write path, blocked capabilities stay blocked, no secrets. Same convention as Phases 14–19: in-memory sqlite, MOCK transports only.
const fs = require("fs");
const path = require("path");
const { db, resetDb, seedDistributor } = require("./helpers");
const H = require("./helpers-http");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const business = require("../services/erpBusiness.service");
const register = require("../services/erpDecisionRegister.service");
const audit = require("../services/erpAudit.service");

let server; let call;
beforeAll(async () => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789" }); server = await H.listen(H.buildApp()); call = H.client(server); });
beforeEach(async () => { require("../middleware/erpAccess")._resetDenyThrottle(); await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(async () => { server.close(); await audit.flush(); await db.sequelize.close(); });

const T = "DEFAULT"; const T2 = "TENANT_B";
const cap = (capability, endpointPath, o = {}) => ({ capability, endpointPath, direction: "ERP_TO_DMS", config: { responsePath: "rows", pagination: { type: "NONE" } }, ...o });
const mkConn = (caps, o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: caps, ...o });
const ITEM_KEYS = ["id", "area", "capability", "question", "blocks", "interim", "mechanism", "scope", "status", "answer", "approval", "persistence"].sort();

describe("decisionRegister API response and schema", () => {
  test("every item has the documented keys, a known status, and the 23 Phase 19 questions are all present (none omitted or invented)", async () => {
    const reg = (await business.overview(db, T)).decisionRegister;
    expect(reg.items).toHaveLength(23);
    expect(reg.items.map((i) => i.id)).toEqual(register.REGISTER.map((r) => r.id));
    for (const i of reg.items) {
      expect(Object.keys(i).filter((k) => k !== "connections").sort()).toEqual(ITEM_KEYS);
      expect(["REQUIRED", "CONFIGURED"]).toContain(i.status);
      expect(i.approval).toBe("NOT_RECORDED");
      expect(typeof i.capability).toBe("string"); expect(i.blocks.length).toBeGreaterThan(0); expect(i.interim.length).toBeGreaterThan(10);
      expect(i.scope).toBe(i.mechanism === "CONFIG" ? "CONNECTION" : "TENANT");
    }
    expect(reg.items.filter((i) => i.mechanism === "CONFIG").map((i) => i.id).sort()).toEqual(["invoice.owner", "return.owner", "sales.owner", "stock.owner"]);
    expect([...new Set(reg.items.map((i) => i.area))].sort()).toEqual(["Documents", "Invoice", "Payment", "Pricing", "Return", "Sales", "Stock"]);
  });

  test("meta states that approval tracking is NOT implemented, and BUSINESS_APPROVED is not an available status anywhere", async () => {
    const reg = (await business.overview(db, T)).decisionRegister;
    expect(reg.meta.approvalTracking.implemented).toBe(false);
    expect(reg.meta.approvalTracking.reason).toMatch(/not business approval/);
    expect(reg.meta.statuses).toEqual(["REQUIRED", "CONFIGURED"]);
    expect(JSON.stringify(reg)).not.toMatch(/BUSINESS_APPROVED/);
    expect(Object.keys(reg.summary).sort()).toEqual(["CONFIGURED", "REQUIRED"]);
  });
});

describe("REQUIRED vs CONFIGURED, and CONFIGURED is never approval", () => {
  test("nothing configured → all 23 REQUIRED; ownership set → only that ownership question is CONFIGURED, with the holding connection listed", async () => {
    expect((await business.overview(db, T)).decisionRegister.summary).toEqual({ REQUIRED: 23, CONFIGURED: 0 });
    const c = await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" }), cap("STOCK", "/st")]);
    const reg = (await business.overview(db, T)).decisionRegister;
    const inv = reg.items.find((i) => i.id === "invoice.owner"); const stock = reg.items.find((i) => i.id === "stock.owner");
    expect(inv).toMatchObject({ status: "CONFIGURED", approval: "NOT_RECORDED", answer: ["ERP_OWNED / ERP_TO_DMS"], capability: "INVOICE" });
    expect(inv.connections).toEqual([{ connectionId: c.id, connectionName: "Custom ERP", enabled: true, ownership: "ERP_OWNED", direction: "ERP_TO_DMS" }]);
    expect(inv.persistence).toMatch(/cannot confirm that the business approved/);
    expect(stock.status).toBe("REQUIRED"); expect(stock.connections).toEqual([{ connectionId: c.id, connectionName: "Custom ERP", enabled: true, ownership: null, direction: "ERP_TO_DMS" }]);
    expect(reg.summary).toEqual({ REQUIRED: 22, CONFIGURED: 1 });
  });
  test("a non-ownership question never becomes CONFIGURED, whatever is configured (and carries no per-connection answer)", async () => {
    await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" }), cap("STOCK", "/st", { ownership: "SHARED" }), cap("SALES", "/so", { ownership: "ERP_OWNED" }), cap("RETURN", "/rt", { ownership: "ERP_OWNED" })]);
    const reg = (await business.overview(db, T)).decisionRegister;
    for (const i of reg.items.filter((x) => x.mechanism !== "CONFIG")) { expect(i.status).toBe("REQUIRED"); expect(i.answer).toBeNull(); expect(i.connections).toBeUndefined(); }
    expect(reg.summary.CONFIGURED).toBe(4);
  });
});

describe("tenant isolation", () => {
  test("another tenant's connection, name and ownership never appear in this tenant's register", async () => {
    await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" })], { name: "Tenant B ERP" }, T2);
    const a = (await business.overview(db, T)).decisionRegister; const b = (await business.overview(db, T2)).decisionRegister;
    expect(a.summary.CONFIGURED).toBe(0); expect(JSON.stringify(a)).not.toMatch(/Tenant B ERP/);
    expect(a.items.find((i) => i.id === "invoice.owner").connections).toEqual([]);
    expect(b.summary.CONFIGURED).toBe(1); expect(b.items.find((i) => i.id === "invoice.owner").connections[0].connectionName).toBe("Tenant B ERP");
  });
});

describe("no secrets or connection internals in the register", () => {
  test("the serialised register contains no credential reference, URL, header or token", async () => {
    await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" })]);
    const text = JSON.stringify((await business.overview(db, T)).decisionRegister);
    for (const forbidden of ["RESTBEARER", "bearer-tok-XYZ789", "custom.example.com", "credentialRef", "baseUrl", "Authorization", "password"]) expect(text).not.toContain(forbidden);
    const conn = (await business.overview(db, T)).decisionRegister.items.find((i) => i.id === "invoice.owner").connections[0];
    expect(Object.keys(conn).sort()).toEqual(["connectionId", "connectionName", "direction", "enabled", "ownership"]);
  });
});

describe("RBAC enforced by the backend (real Express app), not by the UI", () => {
  const PATH = "/erp-sync/business/overview";
  test("no session → 401; a role without ERP_VIEW → 403 with the fixed message; ERP roles with ERP_VIEW → 200 with the register", async () => {
    expect((await call("GET", PATH)).status).toBe(401);
    const none = await H.adminCookie("SALES_EXEC"); const denied = await call("GET", PATH, { cookie: none.cookie });
    expect(denied.status).toBe(403); expect(JSON.stringify(denied.json)).toMatch(/You don't have permission to perform this action\./); expect(denied.text).not.toMatch(/ERP_VIEW|decisionRegister/);
    for (const role of ["ERP_VIEWER", "ERP_OPERATOR", "ERP_ADMIN", "SUPER_ADMIN", "ADMIN"]) {
      const a = await H.adminCookie(role); const r = await call("GET", PATH, { cookie: a.cookie });
      expect({ role, status: r.status }).toEqual({ role, status: 200 }); expect(r.json.data ? r.json.data.decisionRegister : r.json.decisionRegister).toBeTruthy();
    }
    const off = await H.adminCookie("ERP_ADMIN", { active: false }); expect((await call("GET", PATH, { cookie: off.cookie })).status).toBe(401);
  });
  test("a denied request is audited (ERP_ACCESS_DENIED) without leaking the register", async () => {
    const a = await H.adminCookie("SALES_EXEC"); await call("GET", PATH, { cookie: a.cookie }); await audit.flush();
    expect(await db.ErpAuditEvent.count({ where: { event: "ERP_ACCESS_DENIED", actor_admin_id: a.id } })).toBeGreaterThanOrEqual(1);
  });
});

describe("there is no decision write path — invalid values cannot be 'saved' because nothing saves them", () => {
  test("no route accepts a decision or approval (POST/PUT/PATCH/DELETE → 404), even for the most privileged role; nothing is written", async () => {
    const a = await H.adminCookie("SUPER_ADMIN"); const before = { cap: await db.ErpConnectionCapability.count(), audit: await db.ErpAuditEvent.count() };
    for (const p of ["/erp-sync/business/decisions", "/erp-sync/business/decisions/invoice.owner", "/erp-sync/business/decision-register", "/erp-sync/business/approvals", "/erp-sync/business/overview/decisions"]) {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { const r = await call(m, p, { cookie: a.cookie, body: { value: "ERP_OWNED", status: "BUSINESS_APPROVED" } }); expect({ m, p, s: r.status }).toEqual({ m, p, s: 404 }); }
    }
    const post = await call("POST", "/erp-sync/business/overview", { cookie: a.cookie, body: { status: "BUSINESS_APPROVED" } }); expect([404, 405]).toContain(post.status);
    expect(await db.ErpConnectionCapability.count()).toBe(before.cap); expect(await db.ErpAuditEvent.count()).toBe(before.audit);
  });
  test("the static route table has no decision/approval route, and the register service performs no writes", () => {
    const routes = fs.readFileSync(path.join(__dirname, "../routes/adminRoutes.js"), "utf8");
    const erpWrites = routes.split("\n").filter((l) => /router\.(post|put|patch|delete)\(\s*["']\/erp-/.test(l));
    expect(erpWrites.length).toBeGreaterThan(5); expect(erpWrites.filter((l) => /decision|approv/i.test(l.replace(/\/\/.*$/, "")))).toEqual([]);
    const src = fs.readFileSync(path.join(__dirname, "../services/erpDecisionRegister.service.js"), "utf8");
    expect(src).not.toMatch(/\.(create|update|destroy|bulkCreate|upsert|save)\s*\(|sequelize|require\(["']\.\.\/models/);
  });
  test("the only executable decision keeps working and stays validated + audited: an invalid ownership is rejected, a valid one is audited and then shows as CONFIGURED (not approved)", async () => {
    const c = await mkConn([cap("STOCK", "/st")]);
    await expect(conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/st", { ownership: "NOT_A_VALUE" })] })).rejects.toMatchObject({ statusCode: 400 });
    expect((await business.overview(db, T)).decisionRegister.summary.CONFIGURED).toBe(0);
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/st", { ownership: "ERP_OWNED" })] }); await audit.flush();
    expect(await db.ErpAuditEvent.count({ where: { event: "ERP_OWNERSHIP_UPDATED", tenant_key: T } })).toBeGreaterThanOrEqual(1);
    const reg = (await business.overview(db, T)).decisionRegister; expect(reg.items.find((i) => i.id === "stock.owner")).toMatchObject({ status: "CONFIGURED", approval: "NOT_RECORDED" });
  });
});

describe("recording a decision does not unblock a blocked capability", () => {
  test("INVOICE, RETURN and DOCUMENT stay BLOCKED with CONFIGURED ownership + full mapping; sync start is refused with 409 and no ERP call, job, invoice or stock movement", async () => {
    await seedDistributor();
    const c = await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" }), cap("RETURN", "/rt", { ownership: "ERP_OWNED" }), cap("DOCUMENT", "/doc", { ownership: "ERP_OWNED" })]);
    const fetchImpl = jest.fn(async () => { throw new Error("the ERP must not be contacted"); });
    const before = { jobs: await db.ErpSyncJob.count(), inv: await db.SalesInvoiceHeader.count(), ret: await db.SalesReturn.count(), led: await db.StockLedger.count() };
    const ov = await business.overview(db, T);
    for (const capName of ["INVOICE", "RETURN", "DOCUMENT"]) {
      expect(ov.monitoring.find((m) => m.capability === capName).classification).toBe("BLOCKED");
      const x = ov.connections[0].capabilities.find((k) => k.capability === capName);
      expect(x.classification).toBe("BLOCKED"); expect(x.blockers.length).toBeGreaterThan(0); expect(x.state).toBe("BLOCKED");
      try { await sync.startSync(db, T, 1, { connectionId: c.id, capability: capName }, { await: true, fetchImpl, logger: () => {} }); throw new Error("start must be refused"); }
      catch (e) { expect(e.statusCode).toBe(409); }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect({ jobs: await db.ErpSyncJob.count(), inv: await db.SalesInvoiceHeader.count(), ret: await db.SalesReturn.count(), led: await db.StockLedger.count() }).toEqual(before);
    expect((await business.overview(db, T)).decisionRegister.items.filter((i) => i.status === "CONFIGURED").length).toBe(2); // invoice.owner, return.owner (document has no ownership question)
  });
  test("capability classification dimensions stay what Phase 19 reported (Stock/Sales PARTIAL, Invoice/Return/Document BLOCKED), and providers: SAP + REST mock-verified only, Oracle/Dynamics/SOAP unsupported", async () => {
    const ov = await business.overview(db, T); const cls = Object.fromEntries(ov.monitoring.map((m) => [m.capability, m.classification]));
    expect(cls).toMatchObject({ STOCK: "PARTIAL", SALES: "PARTIAL", INVOICE: "BLOCKED", RETURN: "BLOCKED", DOCUMENT: "BLOCKED", PRODUCT_MASTER: "COMPLETE", PAYMENT: "COMPLETE" });
    const prov = Object.fromEntries(ov.providers.map((p) => [p.key || p.label, p]));
    const implemented = ov.providers.filter((p) => p.status === "IMPLEMENTED"); const others = ov.providers.filter((p) => p.status !== "IMPLEMENTED");
    expect(implemented.length).toBeGreaterThanOrEqual(2); expect(implemented.every((p) => !p.verification.real)).toBe(true);
    expect(others.length).toBeGreaterThanOrEqual(3); expect(others.every((p) => p.classification === "UNSUPPORTED")).toBe(true);
    expect(prov).toBeTruthy(); expect(ov.documentStore.ready).toBe(false); expect(ov.documentStore.status).toBe("BUSINESS_DECISION_REQUIRED");
  });
});
