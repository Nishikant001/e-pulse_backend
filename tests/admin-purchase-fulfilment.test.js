// Admin fulfils a distributor's purchase order: delivery (stock-in) + invoice. Same in-memory sqlite + direct-controller convention.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedGLAccounts } = require("./helpers");
const poCtrl = require("../controllers/purchaseorder.controller");
const adminFulfil = require("../controllers/admin.purchaseFulfilment.controller");
const adminPo = require("../controllers/admin.purchaseorders.controller");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const reqFor = (d, body = {}, params = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body, params, query: {} });
const adminReq = (body = {}, params = {}) => ({ admin: { id: 1 }, body, params, query: {} });

async function confirmedPo(distributor, product, quantity = 10) {
  const res = mockRes();
  await poCtrl.create(reqFor(distributor, { orderDate: new Date(), lines: [{ productId: product.id, quantity, pricePerUnit: 100 }] }), res);
  const id = res.jsonBody.header.id;
  await poCtrl.confirm(reqFor(distributor, {}, { id }), mockRes());
  return db.PurchaseOrderHeader.findByPk(id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
}
const stockOf = async (batchId) => Number((await db.StockLedger.sum("quantity", { where: { batchId } })) || 0);
const deliverBody = (po, over = {}) => ({ lines: [{ orderLineId: po.lines[0].id, quantityReceived: 10, batchNo: "B-100", mfgDate: "2026-01-01", expDate: "2028-01-01", ...over }] });

describe("admin delivers a distributor PO", () => {
  test("creates the batch, records the delivery and adds stock to the distributor", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const po = await confirmedPo(d, p);

    const res = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po), { id: po.id }), res);
    expect(res.status).toHaveBeenCalledWith(201);

    const batch = await db.Batch.findOne({ where: { productId: p.id, distributor_id: d.id, batch_no: "B-100" } });
    expect(batch).not.toBeNull();
    expect(await stockOf(batch.id)).toBe(10);
    expect((await db.PurchaseOrderHeader.findByPk(po.id)).status).toBe("FULLY_RECEIVED");
  });

  test("reuses an existing batch instead of duplicating it", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const existing = await seedBatch(d.id, p.id, { batch_no: "B-100" });
    const po = await confirmedPo(d, p);
    const res = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po, { expDate: undefined }), { id: po.id }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(await db.Batch.count({ where: { productId: p.id } })).toBe(1);
    expect(await stockOf(existing.id)).toBe(10);
  });

  test("rejects: draft PO, missing batch number, over-receive, missing expiry on a new batch", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const created = mockRes();
    await poCtrl.create(reqFor(d, { orderDate: new Date(), lines: [{ productId: p.id, quantity: 10, pricePerUnit: 100 }] }), created);
    const draft = await db.PurchaseOrderHeader.findByPk(created.jsonBody.header.id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
    const r0 = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(draft), { id: draft.id }), r0);
    expect(r0.status).toHaveBeenCalledWith(400);
    expect(r0.jsonBody.message).toMatch(/must confirm/i);

    const po = await confirmedPo(d, p);
    const r1 = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po, { batchNo: "" }), { id: po.id }), r1);
    expect(r1.status).toHaveBeenCalledWith(400);
    const r2 = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po, { quantityReceived: 11 }), { id: po.id }), r2);
    expect(r2.status).toHaveBeenCalledWith(400);
    const r3 = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po, { expDate: undefined }), { id: po.id }), r3);
    expect(r3.status).toHaveBeenCalledWith(400);
    expect(r3.jsonBody.message).toMatch(/expiry/i);
  });
});

describe("admin invoices a delivery", () => {
  test("creates and posts the invoice with the company supplier; shows on the admin PO detail", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    await seedGLAccounts(d);
    const po = await confirmedPo(d, p);
    const del = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po), { id: po.id }), del);

    const res = mockRes();
    await adminFulfil.invoice(adminReq({}, { id: po.id, deliveryId: del.jsonBody.delivery.id }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    const inv = await db.PurchaseInvoiceHeader.findByPk(res.jsonBody.invoiceId);
    expect(inv.status).toBe("POSTED");
    expect(Number(inv.netValue)).toBe(1000);
    expect(await db.JournalEntry.count({ where: { distributor_code: d.distributor_code } })).toBeGreaterThan(0);

    const detail = mockRes();
    await adminPo.get(adminReq({}, { id: String(po.id) }), detail);
    expect(detail.jsonBody.deliveries[0].invoice.status).toBe("POSTED");
    expect(detail.jsonBody.canReceive).toBe(false);

    const again = mockRes();
    await adminFulfil.invoice(adminReq({}, { id: po.id, deliveryId: del.jsonBody.delivery.id }), again);
    expect(again.status).toHaveBeenCalledWith(400);
  });

  test("works even when no GL accounts were configured (auto-provisioned)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const po = await confirmedPo(d, p);
    const del = mockRes();
    await adminFulfil.deliver(adminReq(deliverBody(po), { id: po.id }), del);
    const res = mockRes();
    await adminFulfil.invoice(adminReq({}, { id: po.id, deliveryId: del.jsonBody.delivery.id }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
