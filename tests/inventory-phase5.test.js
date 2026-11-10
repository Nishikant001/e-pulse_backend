// Phase 5 — Inventory & Batch Management. Runs on the same in-memory sqlite as the existing suites.
const {
  db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedVendor, seedCustomer, seedSalesOrder, seedGLAccounts,
} = require("./helpers");
const inventory = require("../services/inventory.service");
const reads = require("../services/inventoryQuery.service");
const rules = require("../services/inventoryRules.service");
const { validateBatchInput, BatchValidationError } = require("../services/batchValidation.service");
const invController = require("../controllers/inventory.controller");
const batchController = require("../controllers/stock.controller");
const salesDeliveryController = require("../controllers/salesdelivery.controller");
const salesInvoiceController = require("../controllers/salesinvoice.controller");
const purchaseOrderController = require("../controllers/purchaseorder.controller");
const purchaseDeliveryController = require("../controllers/purchasedelivery.controller");
const salesReturnController = require("../controllers/salesreturn.controller");

const NOW = new Date("2026-09-24T10:00:00.000Z");
const day = (n) => new Date(NOW.getTime() + n * 86400000);

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

const reqFor = (d, body = {}, params = {}, query = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body, params, query });
const post = (d, p, b, qty, extra = {}) =>
  inventory.postMovement({ distributorId: d.id, productId: p.id, batchId: b.id, movementType: "IN", quantity: qty, referenceType: "OPENING", ...extra });

// ───────────────────────────── pure rules ─────────────────────────────
describe("inventoryRules", () => {
  test("expiry status: expired / near expiry / healthy / no date", () => {
    expect(rules.expiryStatus(day(-1), NOW)).toBe("expired");
    expect(rules.expiryStatus(day(30), NOW)).toBe("near_expiry");
    expect(rules.expiryStatus(day(89), NOW)).toBe("near_expiry");
    expect(rules.expiryStatus(day(91), NOW)).toBe("healthy");
    expect(rules.expiryStatus(null, NOW)).toBe("healthy");
  });
  test("near-expiry window is configurable (documented default 90 days)", () => {
    expect(rules.getNearExpiryDays({})).toBe(90);
    expect(rules.getNearExpiryDays({ INVENTORY_NEAR_EXPIRY_DAYS: "45" })).toBe(45);
    expect(rules.getNearExpiryDays({ INVENTORY_NEAR_EXPIRY_DAYS: "abc" })).toBe(90);
    expect(rules.expiryStatus(day(60), NOW, 45)).toBe("healthy");
  });
  test("saleable split: expired / inactive batches are entirely non-saleable", () => {
    expect(rules.splitBatchQuantities({ saleableState: 10, nonSaleableState: 2, expDate: day(200) }, NOW)).toMatchObject({ onHand: 12, saleable: 10, nonSaleable: 2 });
    expect(rules.splitBatchQuantities({ saleableState: 10, nonSaleableState: 2, expDate: day(-5) }, NOW)).toMatchObject({ saleable: 0, nonSaleable: 12 });
    expect(rules.splitBatchQuantities({ saleableState: 10, expDate: day(200), batchActive: false }, NOW)).toMatchObject({ saleable: 0, nonSaleable: 10 });
  });
  test("batch and product statuses", () => {
    expect(rules.batchStatus({ expDate: day(200), saleableState: 5 }, NOW)).toBe("healthy");
    expect(rules.batchStatus({ expDate: day(20), saleableState: 5 }, NOW)).toBe("near_expiry");
    expect(rules.batchStatus({ expDate: day(-1), saleableState: 5 }, NOW)).toBe("expired");
    expect(rules.batchStatus({ expDate: day(200), saleableState: 0, nonSaleableState: 5 }, NOW)).toBe("non_saleable");
    expect(rules.batchStatus({ expDate: day(200), saleableState: 0 }, NOW)).toBe("out_of_stock");
    expect(rules.productStatus({ expiredQty: 1, productSaleable: 500, reorderLevel: 10 })).toBe("expired");
    expect(rules.productStatus({ productSaleable: 10, reorderLevel: 10 })).toBe("low_stock");
    expect(rules.productStatus({ nearExpiryQty: 3, productSaleable: 100, reorderLevel: 10 })).toBe("near_expiry");
    expect(rules.productStatus({ productSaleable: 0, reorderLevel: 0 })).toBe("healthy"); // reorder level 0 disables low stock
  });
  test("transaction classification", () => {
    expect(rules.classifyTransaction("PURCHASE", "IN").key).toBe("purchase");
    expect(rules.classifyTransaction("SALES", "OUT").key).toBe("sale");
    expect(rules.classifyTransaction("RETURN", "IN").key).toBe("sales_return");
    expect(rules.classifyTransaction("RETURN", "OUT").key).toBe("purchase_return");
    expect(rules.classifyTransaction("DAMAGE", "OUT").key).toBe("adjustment");
    expect(rules.classifyTransaction("TRANSFER", "IN").key).toBe("transfer");
  });
});

// ───────────────────────────── batch validation ─────────────────────────────
describe("batch validation (server-side)", () => {
  test("expiry must be after manufacturing; future MFG rejected; bad dates rejected", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const base = { distributorId: d.id, productId: p.id, now: NOW };
    await expect(validateBatchInput({ ...base, input: { batch_no: "A1", mfg_date: "2026-05-01", exp_date: "2026-05-01" } })).rejects.toMatchObject({ code: "EXPIRY_BEFORE_MFG" });
    await expect(validateBatchInput({ ...base, input: { batch_no: "A1", mfg_date: "2027-01-01", exp_date: "2029-01-01" } })).rejects.toMatchObject({ code: "MFG_IN_FUTURE" });
    await expect(validateBatchInput({ ...base, input: { batch_no: "A1", exp_date: "not-a-date" } })).rejects.toMatchObject({ code: "INVALID_DATE" });
    await expect(validateBatchInput({ ...base, input: { batch_no: "A1", mrp: -5 } })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    const ok = await validateBatchInput({ ...base, input: { batch_no: " A1 ", mfg_date: "2026-01-01", exp_date: "2028-01-01", mrp: "42.5" } });
    expect(ok.values).toMatchObject({ batch_no: "A1", mrp: 42.5 });
  });
  test("product must exist in the caller's tenant; duplicate batch number rejected per product", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    await expect(validateBatchInput({ distributorId: b.id, productId: pa.id, input: { batch_no: "X" } })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND", statusCode: 404 });
    await seedBatch(a.id, pa.id, { batch_no: "DUP-1" });
    await expect(validateBatchInput({ distributorId: a.id, productId: pa.id, input: { batch_no: "DUP-1" } })).rejects.toMatchObject({ code: "DUPLICATE_BATCH" });
    const pa2 = await seedProduct(a.id);
    await expect(validateBatchInput({ distributorId: a.id, productId: pa2.id, input: { batch_no: "DUP-1" } })).resolves.toBeTruthy(); // same number, other product: allowed
  });
  test("legacy compatibility: a legacy batch can change status without re-validating untouched dates; the model also guards dates when changed", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    // a legacy row that violates MFG < EXP, written around the validators
    const legacy = await seedBatch(d.id, p.id, { batch_no: "OLD" });
    await db.Batch.update({ mfg_date: new Date("2027-01-01"), exp_date: new Date("2026-01-01") }, { where: { id: legacy.id }, validate: false, hooks: false });
    const fresh = await db.Batch.findByPk(legacy.id);
    const { values } = await validateBatchInput({ distributorId: d.id, productId: p.id, input: { status: "inactive" }, existing: fresh });
    await fresh.update(values);
    expect((await db.Batch.findByPk(legacy.id)).status).toBe("inactive");
    // changing a date runs the model validator
    await expect(fresh.update({ exp_date: new Date("2025-01-01") })).rejects.toThrow(/after the manufacturing date/);
  });
  test("controller: create rejects invalid dates with 400 and stores MRP", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const bad = mockRes();
    await batchController.createBatch(reqFor(d, { batch_no: "B1", productId: p.id, mfg_date: "2026-06-01", exp_date: "2026-01-01" }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);
    const good = mockRes();
    await batchController.createBatch(reqFor(d, { batch_no: "B1", productId: p.id, mfg_date: "2026-01-01", exp_date: "2028-01-01", mrp: 55, purchase_price: 40 }), good);
    expect(good.status).toHaveBeenCalledWith(201);
    expect(Number(good.jsonBody.batch.mrp)).toBe(55);
    const dup = mockRes();
    await batchController.createBatch(reqFor(d, { batch_no: "B1", productId: p.id }), dup);
    expect(dup.status).toHaveBeenCalledWith(400);
  });
});

// ───────────────────────────── engine: saleable, non-saleable, warehouses, transfers ─────────────────────────────
describe("inventory engine (Phase 5 extensions)", () => {
  test("default warehouse is provisioned on first posting and stamped on the ledger row", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    const row = await post(d, p, b, 100);
    const wh = await db.Warehouse.findOne({ where: { distributor_id: d.id } });
    expect(wh).toMatchObject({ code: "MAIN", is_default: true });
    expect(row.warehouse_id).toBe(wh.id);
    expect(row.stock_state).toBe("SALEABLE");
  });

  test("non-saleable stock is excluded from allocation but stays on the ledger", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 100);
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 30, reasonCode: "DAMAGED", transaction: t });
    await t.commit();

    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id })).toBe(70);
    expect(await inventory.getBatchNonSaleableQty({ batchId: b.id, distributorId: d.id })).toBe(30);
    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 71 })).rejects.toThrow(/Insufficient saleable stock/);
    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 70, batchId: b.id })).resolves.toEqual([{ batchId: b.id, quantity: 70 }]);
    expect(await db.StockLedger.count({ where: { batchId: b.id } })).toBe(3); // opening + OUT saleable + IN non-saleable — nothing deleted

    const t2 = await db.sequelize.transaction();
    await inventory.releaseNonSaleable({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 10, reasonCode: "DAMAGED", transaction: t2 });
    await t2.commit();
    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id })).toBe(80);
    expect(await inventory.getBatchNonSaleableQty({ batchId: b.id, distributorId: d.id, reason: "DAMAGED" })).toBe(20);
  });

  test("reclassification validates quantity, reason and is atomic (both rows or neither)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 10);
    const args = { distributorId: d.id, productId: p.id, batchId: b.id };
    let t = await db.sequelize.transaction();
    await expect(inventory.markNonSaleable({ ...args, quantity: 11, reasonCode: "DAMAGED", transaction: t })).rejects.toThrow(/Insufficient stock/);
    await t.rollback();
    t = await db.sequelize.transaction();
    await expect(inventory.markNonSaleable({ ...args, quantity: 5, reasonCode: "NOPE", transaction: t })).rejects.toThrow(/reasonCode/);
    await expect(inventory.markNonSaleable({ ...args, quantity: 5, reasonCode: "OTHER", transaction: t })).rejects.toThrow(/reason is required/);
    await t.rollback();
    // rollback after the OUT row was written leaves nothing behind
    t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ ...args, quantity: 5, reasonCode: "QUALITY_ISSUE", transaction: t });
    await t.rollback();
    expect(await db.StockLedger.count({ where: { batchId: b.id } })).toBe(1);
    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id })).toBe(10);
  });

  test("stock transfer foundation: OUT + IN in one transaction, sales ship from the dispatch warehouse only", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 100);
    const main = await inventory.ensureDefaultWarehouse({ distributorId: d.id });
    const second = await db.Warehouse.create({ distributor_id: d.id, code: "COLD", name: "Cold Store", is_default: false });

    const t = await db.sequelize.transaction();
    const tr = await inventory.transferStock({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 40, fromWarehouseId: main.id, toWarehouseId: second.id, transaction: t });
    await t.commit();
    expect(tr.transfer_no).toMatch(/^TRF-\d{6}$/);
    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id, warehouseId: main.id })).toBe(60);
    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id, warehouseId: second.id })).toBe(40);
    expect(await inventory.getBatchAvailableQty({ batchId: b.id, distributorId: d.id })).toBe(100); // whole-distributor total unchanged

    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 61 })).rejects.toThrow(/Insufficient saleable stock/); // dispatch warehouse holds 60
    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 60 })).resolves.toEqual([{ batchId: b.id, quantity: 60 }]);

    // failed transfer (not enough stock) rolls back completely, including the StockTransfer row
    const t2 = await db.sequelize.transaction();
    await expect(inventory.transferStock({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 999, fromWarehouseId: main.id, toWarehouseId: second.id, transaction: t2 })).rejects.toThrow(/Insufficient/);
    await t2.rollback();
    expect(await db.StockTransfer.count()).toBe(1);
    await expect(inventory.resolveWarehouse({ distributorId: d.id, warehouseId: 99999 })).rejects.toThrow(/Invalid warehouse/);
  });

  test("a warehouse of another distributor is rejected", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const p = await seedProduct(a.id);
    const batch = await seedBatch(a.id, p.id, { exp_date: day(400) });
    const foreign = await inventory.ensureDefaultWarehouse({ distributorId: b.id });
    await expect(post(a, p, batch, 5, { warehouseId: foreign.id })).rejects.toThrow(/Invalid warehouse/);
  });
});

// ───────────────────────────── read model ─────────────────────────────
// Two tenants, several warehouses / batches in every state.
async function world() {
  const A = await seedDistributor({ name: "Alpha Pharma" });
  const B = await seedDistributor({ name: "Beta Meds" });
  const paraA = await seedProduct(A.id, { name: "Paracetamol 500", category: "Analgesics", reorder_level: 50 });
  const amoxA = await seedProduct(A.id, { name: "Amoxicillin 250", category: "Antibiotics", reorder_level: 10 });
  const insuA = await seedProduct(A.id, { name: "Insulin Glargine", category: "Diabetes", reorder_level: 5 });
  const paraB = await seedProduct(B.id, { name: "Paracetamol 650", category: "Analgesics", reorder_level: 10 });

  const healthy = await seedBatch(A.id, paraA.id, { batch_no: "PCM-H1", mfg_date: day(-100), exp_date: day(400), purchase_price: 2, mrp: 3 });
  const near = await seedBatch(A.id, amoxA.id, { batch_no: "AMX-N1", mfg_date: day(-500), exp_date: day(40), purchase_price: 10, mrp: 14 });
  const expired = await seedBatch(A.id, insuA.id, { batch_no: "INS-X1", exp_date: day(-10), purchase_price: 100 });
  const insuOk = await seedBatch(A.id, insuA.id, { batch_no: "INS-H2", exp_date: day(300), purchase_price: 100 });
  const bBatch = await seedBatch(B.id, paraB.id, { batch_no: "PCM-B1", exp_date: day(400), purchase_price: 2 });

  await post(A, paraA, healthy, 40); // below its reorder level 50 → low stock
  await post(A, amoxA, near, 100);
  await post(A, insuA, expired, 8);
  await post(A, insuA, insuOk, 20);
  await post(B, paraB, bBatch, 500);

  const t = await db.sequelize.transaction();
  await inventory.markNonSaleable({ distributorId: A.id, productId: amoxA.id, batchId: near.id, quantity: 15, reasonCode: "DAMAGED", transaction: t });
  await t.commit();
  return { A, B, paraA, amoxA, insuA, paraB, healthy, near, expired, insuOk, bBatch };
}
const scopeOf = (d) => ({ distributorId: d ? d.id : null });

describe("Current Stock", () => {
  test("lists product rows with derived quantities, value and status; nothing hard-coded in the UI", async () => {
    const w = await world();
    const r = await reads.listCurrentStock(db, {}, scopeOf(null), { now: NOW });
    expect(r.total).toBe(4);
    const by = (name) => r.items.find((i) => i.product === name);
    expect(by("Paracetamol 500")).toMatchObject({ availableQty: 40, saleableQty: 40, nonSaleableQty: 0, stockValue: 80, status: "low_stock" });
    expect(by("Amoxicillin 250")).toMatchObject({ availableQty: 100, saleableQty: 85, nonSaleableQty: 15, status: "near_expiry", stockValue: 1000 });
    expect(by("Insulin Glargine")).toMatchObject({ availableQty: 28, saleableQty: 20, nonSaleableQty: 8, expiredQty: 8, status: "expired", stockValue: 2800 });
    expect(by("Paracetamol 650")).toMatchObject({ availableQty: 500, status: "healthy", distributor: { name: "Beta Meds" } });
    expect(by("Paracetamol 500").warehouse).toMatchObject({ code: "MAIN", implicit: false });
    expect(w.A.id).toBeTruthy();
  });

  test("status filter, product / category / batch / distributor / warehouse filters and global search", async () => {
    const w = await world();
    const list = (query, scope = scopeOf(null)) => reads.listCurrentStock(db, query, scope, { now: NOW });
    for (const s of rules.PRODUCT_STATUSES) {
      const r = await list({ status: s });
      r.items.forEach((i) => expect(i.status).toBe(s)); // SQL filter and SQL status agree
    }
    expect((await list({ status: "low_stock" })).total).toBe(1);
    expect((await list({ category: "Analgesics" })).total).toBe(2);
    expect((await list({ product: "insulin" })).total).toBe(1);
    expect((await list({ batch: "AMX-N" })).items.map((i) => i.product)).toEqual(["Amoxicillin 250"]);
    expect((await list({ distributorId: String(w.B.id) })).total).toBe(1);
    expect((await list({ q: "beta" })).total).toBe(1); // distributor name
    expect((await list({ q: "PCM-H1" })).total).toBe(1); // batch number
    expect((await list({ q: "main warehouse" })).total).toBe(4); // warehouse name
    expect((await list({ q: "%" })).total).toBe(0); // wildcard is literal
    const wh = await db.Warehouse.findOne({ where: { distributor_id: w.A.id } });
    expect((await list({ warehouseId: String(wh.id) })).total).toBe(3);
  });

  test("server-side pagination and sorting", async () => {
    await world();
    const p1 = await reads.listCurrentStock(db, { pageSize: "2", page: "1", sort: "available", dir: "desc" }, scopeOf(null), { now: NOW });
    const p2 = await reads.listCurrentStock(db, { pageSize: "2", page: "2", sort: "available", dir: "desc" }, scopeOf(null), { now: NOW });
    expect(p1.total).toBe(4);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(2);
    expect(p1.items[0].availableQty).toBeGreaterThanOrEqual(p1.items[1].availableQty);
    await expect(reads.listCurrentStock(db, { sort: "password" }, scopeOf(null))).rejects.toThrow(/sort/);
    await expect(reads.listCurrentStock(db, { pageSize: "9999" }, scopeOf(null))).rejects.toThrow(/pageSize/);
    await expect(reads.listCurrentStock(db, { status: "bogus" }, scopeOf(null))).rejects.toThrow(/status/);
  });

  test("KPIs are derived from the same data", async () => {
    await world();
    const k = await reads.getSummary(db, {}, scopeOf(null), { now: NOW });
    expect(k).toMatchObject({ totalSkus: 4, totalBatches: 5, totalStockValue: 80 + 1000 + 2800 + 1000, lowStockItems: 1, nearExpiryItems: 1, expiredItems: 1 });
    expect(k.onHandQty).toBe(k.saleableQty + k.nonSaleableQty);
    expect(k.valuation.basis).toBe("COST");
  });

  test("reserved quantity = undelivered units on confirmed orders (informational)", async () => {
    const w = await world();
    await seedSalesOrder(w.A, { productId: w.paraA.id, quantity: 25, status: "CONFIRMED" });
    await seedSalesOrder(w.A, { productId: w.paraA.id, quantity: 99, status: "DRAFT" }); // drafts reserve nothing
    const r = await reads.listCurrentStock(db, { product: "Paracetamol 500" }, scopeOf(w.A), { now: NOW });
    expect(r.items[0].reservedQty).toBe(25);
  });

  test("legacy data: ledger rows with NULL warehouse and no Warehouse table rows still read as the implicit default warehouse", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id, { name: "Legacy Tabs" });
    const b = await seedBatch(d.id, p.id, { exp_date: day(300) });
    await db.StockLedger.create({ movement_type: "IN", quantity: 12, reference_type: "OPENING", batchId: b.id, productId: p.id, distributor_id: d.id }); // as before Phase 5
    const r = await reads.listCurrentStock(db, {}, scopeOf(d), { now: NOW });
    expect(r.items[0]).toMatchObject({ availableQty: 12, saleableQty: 12, warehouse: { name: "Main Warehouse", implicit: true } });
    expect((await reads.listLedger(db, {}, scopeOf(d))).items[0]).toMatchObject({ inQty: 12, balance: 12, warehouse: { implicit: true } });
  });
});

describe("Batch Stock & detail", () => {
  test("lists batches with MFG/EXP, quantities, MRP, value and status; empty batches hidden unless requested", async () => {
    const w = await world();
    const empty = await seedBatch(w.A.id, w.paraA.id, { batch_no: "PCM-EMPTY", exp_date: day(200) });
    await post(w.A, w.paraA, empty, 5);
    await inventory.postMovement({ distributorId: w.A.id, productId: w.paraA.id, batchId: empty.id, movementType: "OUT", quantity: 5, referenceType: "CORRECTION" });
    const r = await reads.listBatchStock(db, { sort: "batch_no", dir: "asc" }, scopeOf(null), { now: NOW });
    expect(r.items.map((i) => i.batchNo)).toEqual(["AMX-N1", "INS-H2", "INS-X1", "PCM-B1", "PCM-H1"]);
    const by = (n) => r.items.find((i) => i.batchNo === n);
    expect(by("PCM-H1")).toMatchObject({ mfgDate: day(-100).toISOString().slice(0, 10), mrp: 3, status: "healthy", stockValue: 80 });
    expect(by("AMX-N1")).toMatchObject({ availableQty: 100, saleableQty: 85, nonSaleableQty: 15, status: "near_expiry", mrp: 14 });
    expect(by("INS-X1")).toMatchObject({ availableQty: 8, saleableQty: 0, nonSaleableQty: 8, status: "expired" });
    expect(by("INS-H2").mrp).toBeNull();
    const all = await reads.listBatchStock(db, { includeEmpty: "1" }, scopeOf(null), { now: NOW });
    expect(all.items.find((i) => i.batchNo === "PCM-EMPTY")).toMatchObject({ availableQty: 0, status: "out_of_stock" });
    for (const s of ["healthy", "near_expiry", "expired", "non_saleable"]) {
      (await reads.listBatchStock(db, { status: s }, scopeOf(null), { now: NOW })).items.forEach((i) => expect(i.status).toBe(s));
    }
  });

  test("a batch entirely marked non-saleable shows Non-Saleable", async () => {
    const w = await world();
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: w.A.id, productId: w.paraA.id, batchId: w.healthy.id, quantity: 40, reasonCode: "QUALITY_ISSUE", transaction: t });
    await t.commit();
    const r = await reads.listBatchStock(db, { batch: "PCM-H1" }, scopeOf(w.A), { now: NOW });
    expect(r.items[0]).toMatchObject({ status: "non_saleable", saleableQty: 0, nonSaleableQty: 40 });
  });

  test("detail: batch info, stock split, locations and non-saleable breakdown from the ledger", async () => {
    const w = await world();
    await db.Batch.update({}, { where: { id: w.near.id } });
    await w.paraA.update({ mfg_by: "Acme Labs", gst: 12 });
    const d = await reads.getBatchDetail(db, w.near.id, scopeOf(w.A), { now: NOW });
    expect(d).toMatchObject({
      batchNo: "AMX-N1", status: "near_expiry", mrp: 14, unitCost: 10,
      product: { name: "Amoxicillin 250" }, distributor: { name: "Alpha Pharma" },
      stock: { totalQty: 100, saleableQty: 85, nonSaleableQty: 15, stockValue: 1000 },
    });
    expect(d.stock.nonSaleableBreakdown).toEqual([{ reason: "DAMAGED", label: "Damaged", qty: 15 }]);
    expect(d.locations).toHaveLength(1);
    const d2 = await reads.getBatchDetail(db, w.expired.id, scopeOf(w.A), { now: NOW });
    expect(d2.stock.nonSaleableBreakdown).toEqual([{ reason: "EXPIRED", label: "Expired batch", qty: 8 }]);
    const p = await reads.getBatchDetail(db, w.healthy.id, scopeOf(w.A), { now: NOW });
    expect(p.product).toMatchObject({ manufacturer: "Acme Labs" });
    expect(p.gstRate).toBe(12);
  });

  test("detail reserved quantity counts undelivered units on batch-named order lines", async () => {
    const w = await world();
    await seedSalesOrder(w.A, { productId: w.paraA.id, batchId: w.healthy.id, quantity: 7, status: "CONFIRMED" });
    expect((await reads.getBatchDetail(db, w.healthy.id, scopeOf(w.A), { now: NOW })).stock.reservedQty).toBe(7);
  });
});

describe("Stock Ledger & movement", () => {
  // Phase 19 — this test seeds ledger rows at the real time and then filters by "today" (a UTC date). A run that
  // straddles 00:00 UTC (05:30 IST) made the seed and the assertion see different dates (reproduced). Date is frozen
  // for this describe only; no production behaviour is changed.
  beforeAll(() => {
    jest.useFakeTimers({
      now: NOW,
      // Freeze ONLY Date: the sqlite driver and Sequelize still use real timers/microtasks.
      doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "performance", "hrtime", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback"],
    });
  });
  afterAll(() => {
    jest.useRealTimers();
  });
  test("entries, running balance, transaction types and filters", async () => {
    const w = await world();
    const all = await reads.listLedger(db, { batch: "AMX-N1", dir: "asc" }, scopeOf(w.A));
    expect(all.total).toBe(3);
    expect(all.items.map((i) => [i.transactionType, i.inQty, i.outQty, i.balance, i.stockState])).toEqual([
      ["opening", 100, null, 100, "saleable"],
      ["status_change", null, 15, 85, "saleable"],
      ["status_change", 15, null, 100, "non_saleable"],
    ]);
    expect(all.items[2].nonSaleableReason).toBe("DAMAGED");
    expect((await reads.listLedger(db, { txnType: "opening" }, scopeOf(null))).total).toBe(5);
    expect((await reads.listLedger(db, { txnType: "sale" }, scopeOf(null))).total).toBe(0);
    expect((await reads.listLedger(db, { productId: String(w.insuA.id) }, scopeOf(w.A))).total).toBe(2);
    expect((await reads.listLedger(db, { product: "amox" }, scopeOf(w.A))).total).toBe(3);
    expect((await reads.listLedger(db, { q: "ins-h2" }, scopeOf(w.A))).total).toBe(1);
    const today = new Date().toISOString().slice(0, 10);
    expect((await reads.listLedger(db, { from: today, to: today }, scopeOf(null))).total).toBe(7);
    expect((await reads.listLedger(db, { from: "2001-01-01", to: "2001-01-31" }, scopeOf(null))).total).toBe(0);
    const paged = await reads.listLedger(db, { pageSize: "3", page: "3" }, scopeOf(null));
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(7);
    await expect(reads.listLedger(db, { txnType: "bogus" }, scopeOf(null))).rejects.toThrow(/txnType/);
    await expect(reads.listLedger(db, { from: "2026-02-31" }, scopeOf(null))).rejects.toThrow(/from/);
  });

  test("movement: opening + in + out + returns + transfers + adjustments === closing === current balance", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 100);
    await inventory.postMovement({ distributorId: d.id, productId: p.id, batchId: b.id, movementType: "IN", quantity: 50, referenceType: "PURCHASE", referenceId: 1, referenceLineId: 1 });
    await inventory.postMovement({ distributorId: d.id, productId: p.id, batchId: b.id, movementType: "OUT", quantity: 30, referenceType: "SALES", referenceId: 1, referenceLineId: 1 });
    await inventory.postMovement({ distributorId: d.id, productId: p.id, batchId: b.id, movementType: "IN", quantity: 5, referenceType: "RETURN", referenceId: 1, referenceLineId: 1 });
    await inventory.postAdjustment({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 3, direction: "OUT", reasonType: "DAMAGE", reason: "broken" });
    const main = await inventory.ensureDefaultWarehouse({ distributorId: d.id });
    const cold = await db.Warehouse.create({ distributor_id: d.id, code: "COLD", name: "Cold", is_default: false });
    const t = await db.sequelize.transaction();
    await inventory.transferStock({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 20, fromWarehouseId: main.id, toWarehouseId: cold.id, transaction: t });
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 4, reasonCode: "BLOCKED", transaction: t });
    await t.commit();

    const m = await reads.getMovement(db, { batchId: String(b.id) }, scopeOf(d));
    expect(m).toMatchObject({ opening: 0, stockIn: 150, stockOut: 30, returns: 5, transfers: 0, adjustments: -3, other: 0, closing: 122 });
    expect(m.opening + m.stockIn - m.stockOut + m.returns + m.transfers + m.adjustments + m.other).toBe(m.closing);
    const cur = await reads.listCurrentStock(db, {}, scopeOf(d), { now: NOW });
    expect(cur.items.reduce((a, i) => a + i.availableQty, 0)).toBe(m.closing);
    // per-warehouse: the cold store received 20
    const mc = await reads.getMovement(db, { batchId: String(b.id), warehouseId: String(cold.id) }, scopeOf(d));
    expect(mc).toMatchObject({ transfers: 20, closing: 20 });
    // period: everything happened "now", so a future window has opening == full balance and no movement
    const future = await reads.getMovement(db, { batchId: String(b.id), from: "2099-01-01" }, scopeOf(d));
    expect(future).toMatchObject({ opening: 122, stockIn: 0, closing: 122 });
    await expect(reads.getMovement(db, {}, scopeOf(d))).rejects.toThrow(/productId or batchId/);
  });
});

// ───────────────────────────── tenant isolation ─────────────────────────────
describe("tenant isolation", () => {
  test("a scoped caller never sees another distributor's stock, batch, ledger or warehouses — by id or by filter", async () => {
    const w = await world();
    const scopeA = scopeOf(w.A);
    // ignoring a spoofed distributorId in the query
    const spoof = await reads.listCurrentStock(db, { distributorId: String(w.B.id) }, scopeA, { now: NOW });
    expect(spoof.items.every((i) => i.distributor.id === w.A.id)).toBe(true);
    expect((await reads.listBatchStock(db, { distributorId: String(w.B.id) }, scopeA, { now: NOW })).items.every((i) => i.distributor.id === w.A.id)).toBe(true);
    expect((await reads.listLedger(db, { distributorId: String(w.B.id) }, scopeA)).items.every((i) => i.distributor.id === w.A.id)).toBe(true);
    // foreign ids
    expect(await reads.getBatchDetail(db, w.bBatch.id, scopeA, { now: NOW })).toBeNull();
    expect((await reads.listLedger(db, { batchId: String(w.bBatch.id) }, scopeA)).total).toBe(0);
    expect((await reads.listCurrentStock(db, { productId: String(w.paraB.id) }, scopeA, { now: NOW })).total).toBe(0);
    const whB = await db.Warehouse.findOne({ where: { distributor_id: w.B.id } });
    await expect(reads.listCurrentStock(db, { warehouseId: String(whB.id) }, scopeA)).rejects.toMatchObject({ statusCode: 404 });
    await expect(reads.getMovement(db, { productId: String(w.paraB.id) }, scopeA)).resolves.toMatchObject({ closing: 0 });
    const lk = await reads.getLookups(db, scopeA);
    expect(lk.warehouses.every((x) => x.distributorId === w.A.id)).toBe(true);
    expect(lk.distributors).toEqual([]);
    expect(lk.categories).not.toContain(undefined);
  });

  test("HTTP layer: distributor controller uses the token's id; foreign batch detail is 404; writes are tenant-checked", async () => {
    const w = await world();
    const res = mockRes();
    res.set = jest.fn();
    await invController.distributorReads.batchDetail(reqFor(w.A, {}, { id: String(w.bBatch.id) }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    const ok = mockRes();
    ok.set = jest.fn();
    await invController.distributorReads.current(reqFor(w.A, {}, {}, { distributorId: String(w.B.id) }), ok);
    expect(ok.jsonBody.items.every((i) => i.distributor.id === w.A.id)).toBe(true);

    const bad = mockRes();
    bad.set = jest.fn();
    await invController.changeSaleability(reqFor(w.A, { batchId: w.bBatch.id, quantity: 1, action: "MARK", reasonCode: "DAMAGED" }), bad);
    expect(bad.status).toHaveBeenCalledWith(404);
    expect(await inventory.getBatchNonSaleableQty({ batchId: w.bBatch.id, distributorId: w.B.id })).toBe(0);

    const invalid = mockRes();
    invalid.set = jest.fn();
    await invController.changeSaleability(reqFor(w.A, { batchId: w.healthy.id, quantity: 0, action: "MARK", reasonCode: "DAMAGED" }), invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(invalid.jsonBody.message).toMatch(/Invalid batch quantity/);

    const done = mockRes();
    done.set = jest.fn();
    await invController.changeSaleability(reqFor(w.A, { batchId: w.healthy.id, quantity: 5, action: "MARK", reasonCode: "DAMAGED" }), done);
    expect(done.status).toHaveBeenCalledWith(201);
    expect(await inventory.getBatchNonSaleableQty({ batchId: w.healthy.id, distributorId: w.A.id })).toBe(5);
  });

  test("warehouse endpoints are tenant-scoped and validate input", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const mk = async (d, body) => {
      const r = mockRes();
      r.set = jest.fn();
      await invController.createWarehouse(reqFor(d, body), r);
      return r;
    };
    expect((await mk(a, { code: "cold", name: "Cold Store" })).status).toHaveBeenCalledWith(201);
    expect((await mk(a, { code: "COLD", name: "Again" })).status).toHaveBeenCalledWith(400);
    expect((await mk(a, { code: "!", name: "Bad" })).status).toHaveBeenCalledWith(400);
    expect((await mk(b, { code: "COLD", name: "B's own cold store" })).status).toHaveBeenCalledWith(201); // same code, other tenant
    const foreign = await db.Warehouse.findOne({ where: { distributor_id: a.id, code: "COLD" } });
    const upd = mockRes();
    upd.set = jest.fn();
    await invController.updateWarehouse(reqFor(b, { name: "hijack" }, { id: String(foreign.id) }), upd);
    expect(upd.status).toHaveBeenCalledWith(404);
    const main = await db.Warehouse.findOne({ where: { distributor_id: a.id, is_default: true } });
    const deact = mockRes();
    deact.set = jest.fn();
    await invController.updateWarehouse(reqFor(a, { status: "inactive" }, { id: String(main.id) }), deact);
    expect(deact.status).toHaveBeenCalledWith(400);
  });
});

// ───────────────────────────── integration: Purchase → Sale → Return through the EXISTING flows ─────────────────────────────
describe("integration with the existing Purchase / Sales / Return flows", () => {
  test("purchase increases stock, sale decreases it, return restores it; batch traceability and ledger stay consistent", async () => {
    const d = await seedDistributor();
    await seedGLAccounts(d);
    const product = await seedProduct(d.id, { name: "Flow Tabs", reorder_level: 5 });
    const batch = await seedBatch(d.id, product.id, { batch_no: "FLOW-1", mfg_date: day(-30), exp_date: day(700), purchase_price: 10, mrp: 15 });
    const vendor = await seedVendor(d.id);

    // Purchase (order → confirm → delivery)
    const poRes = mockRes();
    await purchaseOrderController.create(reqFor(d, { orderDate: new Date(), vendorId: vendor.id, lines: [{ productId: product.id, quantity: 100, pricePerUnit: 10 }] }), poRes);
    const po = await db.PurchaseOrderHeader.findByPk(poRes.jsonBody.header.id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
    await purchaseOrderController.confirm(reqFor(d, {}, { id: po.id }), mockRes());
    const pd = mockRes();
    await purchaseDeliveryController.create(reqFor(d, { order_number: po.order_number, deliveryDate: new Date(), lines: [{ orderLineId: po.lines[0].id, quantityReceived: 100, batchId: batch.id }] }), pd);
    expect(pd.status).not.toHaveBeenCalledWith(400);
    let cur = await reads.listCurrentStock(db, {}, scopeOf(d));
    expect(cur.items[0]).toMatchObject({ availableQty: 100, saleableQty: 100, status: "healthy", stockValue: 1000 });

    // Sales order → delivery → invoice → post
    const so = await seedSalesOrder(d, { productId: product.id, quantity: 30, pricePerUnit: 20, status: "CONFIRMED" });
    const res = await reads.listCurrentStock(db, {}, scopeOf(d));
    expect(res.items[0].reservedQty).toBe(30); // committed on the confirmed order
    const sd = mockRes();
    await salesDeliveryController.create(reqFor(d, { order_number: so.order_number, deliveryDate: new Date(), lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 30, batchId: batch.id }] }), sd);
    const deliveryId = sd.jsonBody.delivery.id;
    const inv = mockRes();
    await salesInvoiceController.create(reqFor(d, { deliveryId }), inv);
    await salesInvoiceController.post(reqFor(d, {}, { id: inv.jsonBody.invoice.id }), mockRes());
    cur = await reads.listCurrentStock(db, {}, scopeOf(d));
    expect(cur.items[0]).toMatchObject({ availableQty: 70, reservedQty: 0 }); // delivered → no longer reserved

    // Sales return (post) restores stock, traceable by batch and return reference
    const invoice = await db.SalesInvoiceHeader.findByPk(inv.jsonBody.invoice.id, { include: [{ model: db.SalesInvoiceLine, as: "lines" }] });
    const rc = mockRes();
    await salesReturnController.create(reqFor(d, { invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 8, batchId: batch.id, reason: "Damaged" }] }), rc);
    const rp = mockRes();
    await salesReturnController.post(reqFor(d, {}, { id: rc.jsonBody.salesReturn.id }), rp);
    expect(rp.jsonBody.salesReturn.status).toBe("POSTED");

    const b = await reads.listBatchStock(db, { batch: "FLOW-1" }, scopeOf(d));
    expect(b.items[0]).toMatchObject({ availableQty: 78, saleableQty: 78 });
    const led = await reads.listLedger(db, { batchId: String(batch.id), dir: "asc" }, scopeOf(d));
    expect(led.items.map((i) => [i.transactionType, i.inQty, i.outQty, i.balance])).toEqual([
      ["purchase", 100, null, 100],
      ["sale", null, 30, 70],
      ["sales_return", 8, null, 78],
    ]);
    expect(led.items[2].reference).toBe((await db.SalesReturn.findByPk(rc.jsonBody.salesReturn.id)).return_number);
    expect((await reads.listLedger(db, { q: led.items[2].reference }, scopeOf(d))).total).toBe(1); // searchable by return reference
    expect(led.items.every((i) => i.warehouse.code === "MAIN")).toBe(true);

    // ledger is the single source of truth: engine balance == read-model balance == movement closing
    expect(await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: d.id })).toBe(78);
    expect((await reads.getMovement(db, { batchId: String(batch.id) }, scopeOf(d))).closing).toBe(78);
  });

  test("a sale of an expired or non-saleable batch is rejected by the existing delivery flow", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const expired = await seedBatch(d.id, product.id, { exp_date: day(-2) });
    await post(d, product, expired, 50);
    const so = await seedSalesOrder(d, { productId: product.id, quantity: 5, status: "CONFIRMED" });
    const r = mockRes();
    await salesDeliveryController.create(reqFor(d, { order_number: so.order_number, deliveryDate: new Date(), lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 5, batchId: expired.id }] }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(await db.StockLedger.count({ where: { reference_type: "SALES" } })).toBe(0); // no half-posted stock
  });
});

// ───────────────────────────── performance sanity ─────────────────────────────
describe("larger dataset", () => {
  test("server-side paging over ~1,000 batches returns one page; every SQL status equals the JS rule", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id, { name: "Bulk", reorder_level: 20 });
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({ batch_no: `BLK-${String(i).padStart(4, "0")}`, distributor_id: d.id, productId: p.id, status: "active", exp_date: day((i % 9) * 60 - 100), purchase_price: 1 });
    }
    await db.Batch.bulkCreate(rows, { validate: false, hooks: false });
    const batches = await db.Batch.findAll({ where: { distributor_id: d.id } });
    await db.StockLedger.bulkCreate(batches.map((b, i) => ({ movement_type: "IN", quantity: 1 + (i % 7), reference_type: "OPENING", batchId: b.id, productId: p.id, distributor_id: d.id })));

    const page = await reads.listBatchStock(db, { pageSize: "25", page: "3", sort: "batch_no", dir: "asc" }, scopeOf(d), { now: NOW });
    expect(page.total).toBe(1000);
    expect(page.items).toHaveLength(25);
    expect(page.items[0].batchNo).toBe("BLK-0050");
    const all = await reads.listBatchStock(db, { pageSize: "100", page: "1" }, scopeOf(d), { now: NOW });
    all.items.forEach((i) => {
      const expected = rules.batchStatus({ expDate: i.expDate ? new Date(i.expDate) : null, batchActive: true, saleableState: i.availableQty, nonSaleableState: 0 }, NOW);
      // batches expired at write time were flipped inactive by the model hook only when saved through it; bulkCreate bypassed it
      expect(i.status).toBe(expected);
    });
  });
});
