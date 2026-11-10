// Phase 21 — the DMS works as a standalone application: core business journey (stock → order → delivery → invoice → posting → payment) is run through the
// EXISTING controllers under five ERP conditions, and the Admin dashboard's figures and ERP card are checked against the underlying records.
// In-memory sqlite only: this proves behaviour and logic, NOT MySQL compatibility. No real ERP is ever contacted (fetch is mocked and counted).
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedSalesOrder, seedGLAccounts } = require("./helpers");
const H = require("./helpers-http");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const audit = require("../services/erpAudit.service");
const monitoring = require("../services/erpMonitoring.service");
const inventory = require("../services/inventory.service");
const dash = require("../services/adminDashboard.service");
const salesDelivery = require("../controllers/salesdelivery.controller");
const salesInvoice = require("../controllers/salesinvoice.controller");
const paymentCtl = require("../controllers/payment.controller");

const T = "DEFAULT"; const T2 = "TENANT_B";
let server; let call; let realFetch;
beforeAll(async () => { realFetch = global.fetch; server = await H.listen(H.buildApp()); call = H.client(server); });
beforeEach(async () => {
  require("../middleware/erpAccess")._resetDenyThrottle(); await resetDb(); jest.restoreAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); jest.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.ERP_RESTBEARER_TOKEN;
});
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { server.close(); await audit.flush(); await db.sequelize.close(); });

const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) } });
const reqFor = (d, body, params = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body, params });
const bearerConn = (o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/materials", config: { responsePath: "rows", pagination: { type: "NONE" } } }], ...o });
const CUSTOM_MAP = [{ sourceField: "MATNR", isKey: true, transform: ["strip_leading_zeros"] }, { sourceField: "descr", dmsField: "name" }];
const erpCounts = async () => ({ jobs: await db.ErpSyncJob.count(), links: await db.ErpExternalLink.count(), outbound: await db.ErpOutboundEvent.count(), sapRows: await db.SapSyncRecord.count() });

// ── the ERP conditions required by the Phase 21 brief ──
async function runSyncThatFails(fetchImpl) {
  const d = await seedDistributor(); const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });
  const c = await bearerConn(); await sync.saveMappings(db, T, 1, c.id, "PRODUCT_MASTER", { mappings: CUSTOM_MAP });
  return sync.startSync(db, T, 1, { connectionId: c.id, capability: "PRODUCT_MASTER", scope: { distributorId: d.id, hsnId: hsn.id } }, { await: true, fetchImpl, logger: () => {}, retryDelayMs: 0 });
}
const CONDITIONS = {
  "no ERP connection exists": async () => ({ expect: { configured: false } }),
  "an ERP connection exists but is disabled": async () => { const c = await bearerConn(); await conns.setStatus(db, T, 1, c.id, { status: "INACTIVE", clearDefault: true }); return { expect: { configured: true, activeConnections: 0 } }; },
  "the ERP provider is unreachable": async () => { process.env.ERP_RESTBEARER_TOKEN = "tok"; const c = await bearerConn(); const down = jest.fn(async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); });
    const r = await conns.testConnection(db, T, 1, c.id, { fetchImpl: down, logger: () => {} }); expect(r.ok).toBe(false); return { expect: { configured: true } }; },
  "a sync job fails": async () => { process.env.ERP_RESTBEARER_TOKEN = "tok"; const j = await runSyncThatFails(jest.fn(async () => json(500, {}))); expect(j.status).toBe("FAILED"); return { expect: { configured: true, health: "ERROR", failed: 1 } }; },
  "ERP credentials are absent": async () => { const c = await bearerConn(); const r = await conns.testConnection(db, T, 1, c.id, { fetchImpl: jest.fn(async () => json(200, {})), logger: () => {} }); expect(r.ok).toBe(false); return { expect: { configured: true } }; },
};

async function coreJourney(d) {
  await seedGLAccounts(d);
  const product = await seedProduct(d.id, { cgst: 6, sgst: 6 });
  const batch = await seedBatch(d.id, product.id, { exp_date: new Date("2030-01-01"), purchase_price: 5 });
  await inventory.postMovement({ distributorId: d.id, productId: product.id, batchId: batch.id, movementType: "IN", quantity: 60, referenceType: "OPENING" });
  const so = await seedSalesOrder(d, { productId: product.id, quantity: 10, pricePerUnit: 20, status: "CONFIRMED" });
  const dRes = mockRes();
  await salesDelivery.create(reqFor(d, { order_number: so.order_number, deliveryDate: new Date(), lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }] }), dRes);
  expect(dRes.status).not.toHaveBeenCalledWith(400); const deliveryId = dRes.jsonBody.delivery.id;
  const iRes = mockRes(); await salesInvoice.create(reqFor(d, { deliveryId }), iRes); expect(iRes.status).toHaveBeenCalledWith(201); const invoiceId = iRes.jsonBody.invoice.id;
  const pRes = mockRes(); await salesInvoice.post(reqFor(d, {}, { id: invoiceId }), pRes); expect(pRes.jsonBody.invoice.status).toBe("POSTED");
  const payRes = mockRes(); await paymentCtl.receivePayment(reqFor(d, { customer_id: so.customerId, amount: 100, reference_no: "RCPT-1", mode: "UPI" }), payRes); expect(payRes.statusCode).toBe(200);
  return { product, batch, so, invoiceId };
}

describe.each(Object.keys(CONDITIONS))("core DMS journey when %s", (name) => {
  test("stock → order → delivery → invoice → posting → payment all work, balance correctly, and never touch the ERP", async () => {
    const state = await CONDITIONS[name]();
    const fetchSpy = jest.fn(async () => { throw new Error("core DMS operations must never call an ERP"); }); global.fetch = fetchSpy;
    const before = await erpCounts();
    const d = await seedDistributor(); const j = await coreJourney(d);

    // inventory & StockLedger: 60 in − 10 out, derived through the existing service
    const rows = await db.StockLedger.findAll({ where: { batchId: j.batch.id } });
    expect(rows.reduce((s, r) => s + (r.movement_type === "OUT" ? -Number(r.quantity) : Number(r.quantity)), 0)).toBe(50);
    // accounting: invoice journal balanced at the total incl. GST (200 + 6% + 6% = 224); the payment journal balanced at 100
    const inv = await db.JournalEntry.findAll({ where: { reference_no: j.invoiceId } });
    expect(inv.reduce((s, e) => s + Number(e.debit), 0)).toBe(224); expect(inv.reduce((s, e) => s + Number(e.credit), 0)).toBe(224);
    const pay = await db.JournalEntry.findAll({ where: { reference_type: "CUSTOMER_PAYMENT", distributor_code: d.distributor_code } });
    expect(pay.reduce((s, e) => s + Number(e.debit), 0)).toBe(100); expect(pay.reduce((s, e) => s + Number(e.credit), 0)).toBe(100);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await erpCounts()).toEqual(before); // the core journey created no ERP job, link, outbound event or SAP record

    // the Admin dashboard is still served, with real figures, and tells the truth about the ERP state
    const admin = await H.adminCookie("ADMIN");
    const r = await call("GET", "/dashboard/summary", { cookie: admin.cookie });
    expect(r.status).toBe(200);
    const body = r.json.data || r.json;
    expect(body.kpis.totalSecondarySales.value).toBe(200);
    expect(body.kpis.outstanding.value).toBe(124); // AR: 224 debited by the invoice − 100 credited by the payment
    expect(body.sap.erp.access).toBe("OK"); expect(body.sap.erp.configured).toBe(state.expect.configured);
    if (state.expect.activeConnections !== undefined) expect(body.sap.erp.activeConnections).toBe(state.expect.activeConnections);
    if (state.expect.health) { expect(body.sap.erp.health).toBe(state.expect.health); expect(body.sap.erp.failedSyncsLast7Days).toBe(state.expect.failed); }
    expect(r.text).not.toMatch(/custom\.example\.com|RESTBEARER|credentialRef|baseUrl|Authorization/);
  });
});

describe("Admin dashboard figures match the underlying records (service-level, real rows, no sample data)", () => {
  test("sales, orders today, receivable, inventory, registered counts equal what the tables hold; an empty database reports zeros / null, never invented numbers", async () => {
    const empty = await dash.getAdminDashboardSummary(db, { from: "2020-01-01", to: "2020-01-31" });
    expect(empty.kpis.totalSecondarySales.value).toBe(0); expect(empty.kpis.outstanding.value).toBeNull(); expect(empty.kpis.currentInventory.units).toBe(0);
    expect(empty.distributors).toEqual([]); expect(empty.topProducts).toEqual([]); expect(empty.alerts).toEqual([]); expect(empty.activity).toEqual([]);

    const d = await seedDistributor(); const j = await coreJourney(d);
    const today = new Date().toISOString().slice(0, 10); const from = `${today.slice(0, 7)}-01`;
    const s = await dash.getAdminDashboardSummary(db, { from, to: today });
    const invoices = await db.SalesInvoiceHeader.findAll({ where: { status: ["POSTED", "PARTIALLY_PAID", "PAID"] } });
    expect(s.kpis.totalSecondarySales.value).toBe(invoices.reduce((t, i) => t + Number(i.netValue), 0));
    expect(s.kpis.currentInventory).toMatchObject({ units: 50, value: 50 * 5, batches: 1 });
    expect(s.kpis.activeDistributors).toMatchObject({ value: 1, registered: await db.Distributor.count() });
    expect(s.kpis.activeRetailers.registered).toBe(await db.Customer.count());
    expect(s.kpis.outstanding.value).toBe(124);
    expect(s.distributors[0]).toMatchObject({ id: d.id, sales: 200, outstanding: 124 });
    expect(s.topProducts[0]).toMatchObject({ name: j.product.name, sales: 200, quantity: 10 });
    // a range that excludes the invoice excludes its sales but keeps the point-in-time snapshots
    const past = await dash.getAdminDashboardSummary(db, { from: "2020-01-01", to: "2020-01-31" });
    expect(past.kpis.totalSecondarySales.value).toBe(0); expect(past.kpis.currentInventory.units).toBe(50); expect(past.kpis.outstanding.value).toBe(124);
    expect(s.meta.appliedTo.snapshot).toEqual(expect.arrayContaining(["currentInventory", "outstanding"]));
  });
  test("known gaps are real: the dashboard has NO payables, pending-claims or pending-returns KPI (documented, not invented)", async () => {
    const s = await dash.getAdminDashboardSummary(db, { from: "2020-01-01", to: "2020-01-31" });
    expect(Object.keys(s.kpis).sort()).toEqual(["activeDistributors", "activeRetailers", "currentInventory", "nearExpiryStock", "outstanding", "salesReturns", "todaysOrders", "totalSecondarySales"]);
  });
});

describe("dashboard ERP card (Phase 21) — real data, role-aware, tenant-scoped, failure-tolerant", () => {
  const get = async (role) => { const a = await H.adminCookie(role); const r = await call("GET", "/dashboard/summary", { cookie: a.cookie }); return { r, body: r.json.data || r.json }; };

  test("the old hard-coded 'not_configured' is gone: with a configured connection the status is 'configured' and the figures come from the ERP tables", async () => {
    await bearerConn();
    const { r, body } = await get("ERP_VIEWER");
    expect(r.status).toBe(200); expect(body.sap.status).toBe("configured"); expect(body.sap.erp).toMatchObject({ access: "OK", configured: true, connections: 1, activeConnections: 1, health: "UNKNOWN", failedSyncsLast7Days: 0 });
  });
  test("a role without ERP_VIEW still gets the whole dashboard, but no ERP figure or connection detail", async () => {
    await bearerConn({ name: "Secret Name ERP" });
    const { r, body } = await get("SALES_EXEC");
    expect(r.status).toBe(200); expect(body.sap.erp).toEqual({ access: "RESTRICTED" }); expect(r.text).not.toMatch(/Secret Name ERP/); expect(body.kpis).toBeTruthy();
  });
  test("another tenant's connections are never counted", async () => {
    await bearerConn({ name: "Tenant B ERP" }, T2);
    const { body } = await get("ADMIN");
    expect(body.sap.erp).toMatchObject({ configured: false, connections: 0 }); expect(JSON.stringify(body)).not.toMatch(/Tenant B ERP/);
  });
  test("if reading ERP state fails the dashboard is still 200 and reports 'UNAVAILABLE' (the DMS does not depend on the ERP tables being readable)", async () => {
    jest.spyOn(monitoring, "getSummary").mockRejectedValue(new Error("db exploded: secret internal detail"));
    const { r, body } = await get("ADMIN");
    expect(r.status).toBe(200); expect(body.sap.erp).toEqual({ access: "UNAVAILABLE" }); expect(r.text).not.toMatch(/exploded|secret internal/);
  });
  test("the dashboard endpoint stays authenticated: no session → 401, and the dashboard makes no outbound ERP request", async () => {
    const fetchSpy = jest.fn(); global.fetch = fetchSpy; await bearerConn();
    expect((await call("GET", "/dashboard/summary")).status).toBe(401);
    expect((await get("ADMIN")).r.status).toBe(200); expect(fetchSpy).not.toHaveBeenCalled();
  });
});
