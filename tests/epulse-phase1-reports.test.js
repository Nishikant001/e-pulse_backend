// e-Pulse Phase 1 — Distributor reports are read-only and tenant-scoped.
const fs = require("fs");
const path = require("path");
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedCustomer } = require("./helpers");
const reportCtrl = require("../controllers/report.controller");
const svc = require("../services/distributorReports.service");

// These tests seed invoice rows directly (the sales lifecycle is covered elsewhere), so SQLite FK enforcement is switched off for them.
beforeEach(async () => { await resetDb(); await db.sequelize.query("PRAGMA foreign_keys = OFF"); });
afterAll(async () => { await db.sequelize.close(); });

const reqFor = (d, params = {}, query = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, params, query, body: {} });
async function run(d, section, query = {}) {
  const res = mockRes();
  await reportCtrl.run(reqFor(d, { section }, query), res);
  return res;
}

let deliverySeq = 1000;
async function seedInvoice(d, customer, overrides = {}) {
  deliverySeq += 1;
  return db.SalesInvoiceHeader.create({
    invoiceDate: new Date(), distributor_id: d.id, distributor_code: d.distributor_code, invoice_number: `${d.distributor_code}-INV-${deliverySeq}`,
    customer_id: customer.id, deliveryId: deliverySeq, status: "POSTED", netValue: 100, totalAmount: 118, outstandingAmount: 118, dueDate: new Date(Date.now() - 5 * 86400000),
    ...overrides,
  });
}

describe("Reports list and routing", () => {
  test("lists all nine sections", async () => {
    const d = await seedDistributor();
    const res = mockRes();
    await reportCtrl.sections(reqFor(d), res);
    expect(res.jsonBody.sections.map((s) => s.id)).toEqual(["sales", "stock", "expiry", "distributor", "customers", "scheme", "returns", "outstanding", "sap-sync"]);
  });

  test("every section answers 200, flagged readOnly, for a distributor with no data", async () => {
    const d = await seedDistributor();
    for (const s of svc.SECTIONS) {
      const res = await run(d, s.id);
      expect([s.id, res.statusCode]).toEqual([s.id, 200]);
      expect(res.jsonBody.readOnly).toBe(true);
      expect(Array.isArray(res.jsonBody.columns)).toBe(true);
      expect(Array.isArray(res.jsonBody.items)).toBe(true);
    }
  });

  test("unknown section is 404; bad filters are 400", async () => {
    const d = await seedDistributor();
    expect((await run(d, "payroll")).statusCode).toBe(404);
    expect((await run(d, "sales", { from: "not-a-date" })).statusCode).toBe(400);
    expect((await run(d, "sales", { status: "WHATEVER" })).statusCode).toBe(400);
    expect((await run(d, "customers", { pageSize: "100000" })).statusCode).toBe(400);
  });

  test("an unauthenticated or inactive distributor gets no report", async () => {
    const res = mockRes();
    await reportCtrl.run({ user: null, params: { section: "sales" }, query: {} }, res);
    expect(res.statusCode).toBe(401);
    const d = await seedDistributor({ status: "inactive" });
    expect((await run(d, "sales")).statusCode).toBe(403);
  });
});

describe("Tenant isolation", () => {
  test("customers, sales and outstanding show only the caller's own rows, even if another distributor id is passed in the query", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const ca = await seedCustomer(a.id, { name: "A-Customer" });
    const cb = await seedCustomer(b.id, { name: "B-Customer" });
    await seedInvoice(a, ca);
    await seedInvoice(b, cb);

    const cust = await run(a, "customers", { distributor_id: b.id, distributorId: b.id });
    expect(cust.jsonBody.items.map((i) => i.name)).toEqual(["A-Customer"]);

    const sales = await run(a, "sales", { distributorId: b.id });
    expect(sales.jsonBody.total).toBe(1);
    expect(sales.jsonBody.items[0].customer).toBe("A-Customer");

    const out = await run(b, "outstanding");
    expect(out.jsonBody.items.map((i) => i.customer)).toEqual(["B-Customer"]);
    expect(out.jsonBody.totals.outstandingAmount).toBe(118);
    expect(out.jsonBody.items[0].daysOverdue).toBeGreaterThanOrEqual(4);
  });

  test("stock and expiry are scoped to the caller", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    await seedBatch(a.id, pa.id);
    await seedBatch(b.id, pb.id);
    const stock = await run(a, "stock", { includeEmpty: "1" });
    expect(stock.statusCode).toBe(200);
    expect(stock.jsonBody.items.every((i) => i.productId === pa.id)).toBe(true);
    const exp = await run(a, "expiry", { includeEmpty: "1" });
    expect(exp.statusCode).toBe(200);
    expect(exp.jsonBody.items.every((i) => i.productId === pa.id)).toBe(true);
  });

  test("schemes: only ALL-scope schemes or ones assigned to the caller", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const base = { scheme_type: "PERCENT_DISCOUNT", discount_percent: 5, valid_from: "2026-01-01", status: "active" };
    await db.Scheme.create({ ...base, scheme_code: "ALLS", name: "For everyone", distributor_scope: "ALL" });
    const only = await db.Scheme.create({ ...base, scheme_code: "ONLYB", name: "Only B", distributor_scope: "SPECIFIC" });
    await db.SchemeDistributor.create({ scheme_id: only.id, distributor_id: b.id });
    const ra = await run(a, "scheme");
    expect(ra.jsonBody.items.map((i) => i.code)).toEqual(["ALLS"]);
    const rb = await run(b, "scheme");
    expect(rb.jsonBody.items.map((i) => i.code).sort()).toEqual(["ALLS", "ONLYB"]);
  });

  test("SAP sync report never returns the stored error text", async () => {
    const a = await seedDistributor();
    await db.SapSyncRecord.create({ distributor_id: a.id, entity_type: "SALES_ORDER", entity_id: 1, status: "FAILED", last_error: "ECONNREFUSED 10.0.0.5:8000 secret-host", last_attempt_at: new Date() });
    const res = await run(a, "sap-sync");
    expect(res.jsonBody.items[0].hasError).toBe(true);
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/ECONNREFUSED|secret-host|10\.0\.0\.5/);
  });
});

describe("Read-only guarantee", () => {
  test("the controller and service export no write operation", () => {
    expect(Object.keys(reportCtrl).sort()).toEqual(["run", "sections"]);
    expect(Object.keys(svc).sort()).toEqual(["SECTIONS", "runReport"]);
  });

  test("the route table registers /reports for GET only", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "allRoutes.js"), "utf8");
    const lines = src.split("\n").filter((l) => /["'`]\/reports/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((l) => expect(l).toMatch(/router\.get\(/));
  });

  test("reports do not change any row (counts before == after)", async () => {
    const a = await seedDistributor();
    const c = await seedCustomer(a.id);
    await seedInvoice(a, c);
    const before = [await db.SalesInvoiceHeader.count(), await db.Customer.count(), await db.SapSyncRecord.count()];
    for (const s of svc.SECTIONS) await run(a, s.id);
    expect([await db.SalesInvoiceHeader.count(), await db.Customer.count(), await db.SapSyncRecord.count()]).toEqual(before);
  });
});
