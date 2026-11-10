// e-Pulse Phase 1 — vendor-less Purchase Orders + read-only Admin PO view. Same in-memory sqlite + direct-controller convention as earlier phases.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedVendor } = require("./helpers");
const poCtrl = require("../controllers/purchaseorder.controller");
const deliveryCtrl = require("../controllers/purchasedelivery.controller");
const invoiceCtrl = require("../controllers/purchaseinvoice.controller");
const adminPo = require("../controllers/admin.purchaseorders.controller");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const reqFor = (d, body = {}, params = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body, params, query: {} });
const adminReq = (query = {}, params = {}) => ({ admin: { id: 1 }, query, params });

async function createPo(distributor, product, extra = {}) {
  const res = mockRes();
  await poCtrl.create(reqFor(distributor, { orderDate: new Date(), lines: [{ productId: product.id, quantity: 10, pricePerUnit: 100 }], ...extra }), res);
  return res;
}

describe("Distributor PO without a vendor", () => {
  test("creates a DRAFT PO with no vendorId", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const res = await createPo(d, p);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.jsonBody.header.status).toBe("DRAFT");
    expect(res.jsonBody.header.vendorId).toBeNull();
    expect(Number(res.jsonBody.header.netValue)).toBe(1000);
  });

  test("still requires orderDate and at least one line", async () => {
    const d = await seedDistributor();
    const res = mockRes();
    await poCtrl.create(reqFor(d, { orderDate: new Date(), lines: [] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("a vendorId, when supplied, must still belong to the distributor", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const p = await seedProduct(a.id);
    const foreignVendor = await seedVendor(b.id);
    const res = await createPo(a, p, { vendorId: foreignVendor.id });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("a vendor-less PO can be listed, fetched, edited while DRAFT and confirmed", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const created = await createPo(d, p);
    const id = created.jsonBody.header.id;

    const list = mockRes();
    await poCtrl.getAll(reqFor(d), list);
    expect(list.jsonBody).toHaveLength(1);
    expect(list.jsonBody[0].vendor).toBeNull();

    const upd = mockRes();
    await poCtrl.update(reqFor(d, { description: "urgent", lines: [{ productId: p.id, quantity: 5, pricePerUnit: 100 }] }, { id }), upd);
    expect(upd.jsonBody.message).toBe("Purchase order updated");

    const conf = mockRes();
    await poCtrl.confirm(reqFor(d, {}, { id }), conf);
    expect(conf.jsonBody.header.status).toBe("CONFIRMED");
  });

  test("purchase INVOICE for a delivery of a vendor-less PO uses the auto-created company supplier (no longer blocked)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const batch = await seedBatch(d.id, p.id);
    const created = await createPo(d, p);
    const id = created.jsonBody.header.id;
    await poCtrl.confirm(reqFor(d, {}, { id }), mockRes());
    const po = await db.PurchaseOrderHeader.findByPk(id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });

    const del = mockRes();
    await deliveryCtrl.create(reqFor(d, { order_number: po.order_number, deliveryDate: new Date(), lines: [{ orderLineId: po.lines[0].id, quantityReceived: 10, batchId: batch.id }] }), del);
    expect(del.status).toHaveBeenCalledWith(201);

    const inv = mockRes();
    await invoiceCtrl.create(reqFor(d, { deliveryId: del.jsonBody.delivery.id }), inv);
    expect(inv.status).toHaveBeenCalledWith(201);
    expect(await db.PurchaseInvoiceHeader.count()).toBe(1);
    const supplier = await db.Vendor.findByPk(inv.jsonBody.invoice.vendor_id);
    expect(supplier.name).toBe("Company (Admin supply)");
    expect(supplier.distributor_id).toBe(d.id);
  });
});

describe("Admin (tenant admin) purchase-order view", () => {
  test("admin sees POs of every distributor, with the owning distributor", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    await createPo(a, pa);
    await createPo(b, pb);

    const res = mockRes();
    await adminPo.list(adminReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.jsonBody.total).toBe(2);
    expect(res.jsonBody.items.map((i) => i.distributor.code).sort()).toEqual([a.distributor_code, b.distributor_code].sort());
    expect(res.jsonBody.items[0].vendorName).toBeNull();
  });

  test("filters by distributor, status and search text", async () => {
    const a = await seedDistributor({ name: "Alpha Pharma" });
    const b = await seedDistributor({ name: "Beta Pharma" });
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    const first = await createPo(a, pa);
    await createPo(b, pb);
    await poCtrl.confirm(reqFor(a, {}, { id: first.jsonBody.header.id }), mockRes());

    const byDist = mockRes();
    await adminPo.list(adminReq({ distributorId: String(b.id) }), byDist);
    expect(byDist.jsonBody.total).toBe(1);

    const byStatus = mockRes();
    await adminPo.list(adminReq({ status: "confirmed" }), byStatus);
    expect(byStatus.jsonBody.total).toBe(1);
    expect(byStatus.jsonBody.items[0].distributor.id).toBe(a.id);

    const byText = mockRes();
    await adminPo.list(adminReq({ q: "alpha" }), byText);
    expect(byText.jsonBody.total).toBe(1);

    const byNumber = mockRes();
    await adminPo.list(adminReq({ q: first.jsonBody.order_number }), byNumber);
    expect(byNumber.jsonBody.total).toBe(1);
  });

  test("rejects bad filters with 400 and never reaches SQL", async () => {
    const res = mockRes();
    await adminPo.list(adminReq({ status: "bogus" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    const res2 = mockRes();
    await adminPo.list(adminReq({ sort: "id; drop table x" }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test("detail returns lines, totals, receiving progress and deliveries; unknown id is 404", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const batch = await seedBatch(d.id, p.id);
    const created = await createPo(d, p);
    const id = created.jsonBody.header.id;
    await poCtrl.confirm(reqFor(d, {}, { id }), mockRes());
    const po = await db.PurchaseOrderHeader.findByPk(id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
    await deliveryCtrl.create(reqFor(d, { order_number: po.order_number, deliveryDate: new Date(), lines: [{ orderLineId: po.lines[0].id, quantityReceived: 4, batchId: batch.id }] }), mockRes());

    const res = mockRes();
    await adminPo.get(adminReq({}, { id: String(id) }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.jsonBody.vendor).toBeNull();
    expect(res.jsonBody.distributor.code).toBe(d.distributor_code);
    expect(res.jsonBody.lines[0].receivedQuantity).toBe(4);
    expect(res.jsonBody.lines[0].remainingQuantity).toBe(6);
    expect(res.jsonBody.deliveries).toHaveLength(1);
    expect(res.jsonBody.totals.netValue).toBe(1000);

    const missing = mockRes();
    await adminPo.get(adminReq({}, { id: "999999" }), missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  test("the admin controller exposes read handlers only", () => {
    expect(Object.keys(adminPo).sort()).toEqual(["get", "list", "lookups"]);
  });
});
