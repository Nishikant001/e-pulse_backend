// Phase 6 — FEFO & Expiry Management. Runs on the same in-memory sqlite as the other suites.
const {
  db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedCustomer, seedPricing, seedSalesOrder, seedGLAccounts,
} = require("./helpers");
const inventory = require("../services/inventory.service");
const reads = require("../services/inventoryQuery.service");
const rules = require("../services/inventoryRules.service");
const invController = require("../controllers/inventory.controller");
const salesDeliveryController = require("../controllers/salesdelivery.controller");
const salesInvoiceController = require("../controllers/salesinvoice.controller");
const adminSalesOrder = require("../services/adminSalesOrder.service");
const adminDashboard = require("../services/adminDashboard.service");

const NOW = new Date("2026-09-24T10:00:00.000Z");
const day = (n) => new Date(NOW.getTime() + n * 86400000);
const scopeOf = (d) => ({ distributorId: d ? d.id : null });
const reqFor = (d, body = {}, params = {}, query = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body, params, query });
const post = (d, p, b, qty, extra = {}) =>
  inventory.postMovement({ distributorId: d.id, productId: p.id, batchId: b.id, movementType: "IN", quantity: qty, referenceType: "OPENING", ...extra });

// Phase 19 — deterministic clock. Production code (allocateStock, delivery, batch validation) reads the real clock
// via `new Date()`, while this suite seeds expiry dates relative to NOW. Without freezing Date, batches seeded as
// "+15 days" become genuinely expired as real time passes and FEFO correctly skips them (12 failures on 2026-10-10).
// Only Date is frozen; no production behaviour is changed.
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    // Freeze ONLY Date: the sqlite driver and Sequelize still use real timers/microtasks.
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "performance", "hrtime", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback"],
  });
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  jest.useRealTimers();
  await db.sequelize.close();
});

// ───────────────────────────── pure rules ─────────────────────────────
describe("expiry buckets (rules)", () => {
  test("boundaries reuse the Phase 3 dashboard's 30/60/90-day thresholds exactly", () => {
    expect(rules.EXPIRY_BUCKET_THRESHOLDS_DAYS).toEqual({ critical: 30, high: 60, medium: 90 });
    expect(rules.expiryBucket(day(-1), NOW)).toBe("expired");
    expect(rules.expiryBucket(day(0), NOW)).toBe("critical");
    expect(rules.expiryBucket(day(29), NOW)).toBe("critical");
    expect(rules.expiryBucket(day(30), NOW)).toBe("high");
    expect(rules.expiryBucket(day(59), NOW)).toBe("high");
    expect(rules.expiryBucket(day(60), NOW)).toBe("medium");
    expect(rules.expiryBucket(day(89), NOW)).toBe("medium");
    expect(rules.expiryBucket(day(90), NOW)).toBe("healthy");
    expect(rules.expiryBucket(null, NOW)).toBe("healthy");
  });
  test("REGULATORY_HOLD is a valid non-saleable reason (additive; no migration needed)", () => {
    expect(rules.NON_SALEABLE_REASONS.REGULATORY_HOLD).toBe("Regulatory hold");
    expect(rules.isNonSaleableReason("REGULATORY_HOLD")).toBe(true);
  });
  test("adminDashboard's exported thresholds are the SAME object the Phase 6 screens use (single source of truth)", () => {
    expect(adminDashboard.NEAR_EXPIRY_DAYS).toBe(rules.EXPIRY_BUCKET_THRESHOLDS_DAYS);
  });
});

// ───────────────────────────── FEFO engine ─────────────────────────────
describe("FEFO allocation", () => {
  test("earliest expiry first; exact multi-batch split example from the brief (50/100/200, request 180 -> 50+100+30)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const A = await seedBatch(d.id, p.id, { batch_no: "BATCH-A", exp_date: day(15) });
    const B = await seedBatch(d.id, p.id, { batch_no: "BATCH-B", exp_date: day(45) });
    const C = await seedBatch(d.id, p.id, { batch_no: "BATCH-C", exp_date: day(300) });
    await post(d, p, A, 50);
    await post(d, p, B, 100);
    await post(d, p, C, 200);

    const allocations = await inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 180 });
    expect(allocations).toEqual([
      { batchId: A.id, quantity: 50 },
      { batchId: B.id, quantity: 100 },
      { batchId: C.id, quantity: 30 },
    ]);
  });

  test("expired and non-saleable batches are skipped by FEFO even when they expire earliest", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const expired = await seedBatch(d.id, p.id, { batch_no: "EXP", exp_date: day(-5) });
    const held = await seedBatch(d.id, p.id, { batch_no: "HELD", exp_date: day(10) });
    const healthy = await seedBatch(d.id, p.id, { batch_no: "OK", exp_date: day(400) });
    await post(d, p, expired, 100);
    await post(d, p, held, 100);
    await post(d, p, healthy, 100);
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: held.id, quantity: 100, reasonCode: "QUALITY_ISSUE", transaction: t });
    await t.commit();

    const allocations = await inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 50 });
    expect(allocations).toEqual([{ batchId: healthy.id, quantity: 50 }]);
  });

  test("insufficient eligible stock: all-or-nothing (existing policy, unchanged) — nothing is posted, clear business error", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(30) });
    await post(d, p, b, 100);
    const before = await db.StockLedger.count();
    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 150 })).rejects.toThrow(/Insufficient saleable stock to fulfill requested quantity/);
    expect(await db.StockLedger.count()).toBe(before); // no half-allocation, no ledger rows from the failed attempt
  });

  test("same-expiry-date tie-break is deterministic: lower batch id (recorded first) is consumed first, every time", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const sameExp = day(60);
    const first = await seedBatch(d.id, p.id, { batch_no: "TIE-1", exp_date: sameExp });
    const second = await seedBatch(d.id, p.id, { batch_no: "TIE-2", exp_date: sameExp });
    await post(d, p, first, 20);
    await post(d, p, second, 20);
    for (let i = 0; i < 3; i++) {
      const rows = await inventory.getAvailableBatches({ productId: p.id, distributorId: d.id });
      expect(rows.map((r) => r.batch.id)).toEqual([first.id, second.id]);
    }
  });

  test("a batch with no recorded expiry date is ordered AFTER known expiry dates, not before (bug fix)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const noDate = await seedBatch(d.id, p.id, { batch_no: "NODATE" }); // exp_date left null by the helper
    const known = await seedBatch(d.id, p.id, { batch_no: "KNOWN", exp_date: day(400) });
    await post(d, p, noDate, 10);
    await post(d, p, known, 10);
    const rows = await inventory.getAvailableBatches({ productId: p.id, distributorId: d.id });
    expect(rows.map((r) => r.batch.id)).toEqual([known.id, noDate.id]);
  });

  test("preview matches what allocateStock actually does, and never posts anything itself", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const A = await seedBatch(d.id, p.id, { batch_no: "A", exp_date: day(15) });
    const B = await seedBatch(d.id, p.id, { batch_no: "B", exp_date: day(45) });
    await post(d, p, A, 50);
    await post(d, p, B, 100);

    const before = await db.StockLedger.count();
    const preview = await inventory.previewFefoAllocation({ productId: p.id, distributorId: d.id, quantity: 120 });
    expect(await db.StockLedger.count()).toBe(before); // read-only
    expect(preview.sufficient).toBe(true);
    expect(preview.allocations).toEqual([
      { batchId: A.id, batchNo: "A", expDate: A.exp_date, available: 50, allocated: 50 },
      { batchId: B.id, batchNo: "B", expDate: B.exp_date, available: 100, allocated: 70 },
    ]);

    const actual = await inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 120 });
    expect(actual).toEqual(preview.allocations.map((a) => ({ batchId: a.batchId, quantity: a.allocated })));
  });

  test("preview reports an insufficient request without throwing, so a UI can show it inline", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(30) });
    await post(d, p, b, 40);
    const preview = await inventory.previewFefoAllocation({ productId: p.id, distributorId: d.id, quantity: 100 });
    expect(preview).toMatchObject({ sufficient: false, totalAllocated: 40, remaining: 60 });
  });

  test("previewFefoAllocation validates its own input and tenant/warehouse scope", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    await expect(inventory.previewFefoAllocation({ productId: p.id, distributorId: d.id, quantity: 0 })).rejects.toThrow(/positive integer/);
    await expect(inventory.previewFefoAllocation({ productId: p.id, distributorId: d.id, quantity: 5, warehouseId: 999999 })).rejects.toThrow(/Invalid warehouse/);
  });
});

// ───────────────────────────── FEFO Monitor (listBatchStock, fefoEligible) ─────────────────────────────
describe("FEFO Monitor", () => {
  async function world() {
    const d = await seedDistributor();
    const p = await seedProduct(d.id, { name: "Paracetamol 500mg" });
    const A = await seedBatch(d.id, p.id, { batch_no: "A", exp_date: day(15), purchase_price: 2 }); // critical
    const B = await seedBatch(d.id, p.id, { batch_no: "B", exp_date: day(45), purchase_price: 2 }); // high
    const C = await seedBatch(d.id, p.id, { batch_no: "C", exp_date: day(300), purchase_price: 2 }); // healthy — largest stock value (200 units)
    const X = await seedBatch(d.id, p.id, { batch_no: "X", exp_date: day(-5), purchase_price: 2 }); // expired
    const Y = await seedBatch(d.id, p.id, { batch_no: "Y", exp_date: day(20), purchase_price: 2 }); // will be marked non-saleable, but still critical-dated
    for (const [b, q] of [[A, 50], [B, 100], [C, 200], [X, 30], [Y, 40]]) await post(d, p, b, q);
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: Y.id, quantity: 40, reasonCode: "DAMAGED", transaction: t });
    await t.commit();
    return { d, p, A, B, C, X, Y };
  }

  test("eligibility excludes expired, non-saleable and out-of-stock; includes healthy and near_expiry, in FEFO order with priority ranks", async () => {
    const w = await world();
    const r = await reads.listBatchStock(db, { fefoEligible: "1", sort: "priority", dir: "asc" }, scopeOf(w.d), { now: NOW });
    expect(r.items.map((i) => i.batchNo)).toEqual(["A", "B", "C"]);
    expect(r.items.map((i) => i.priority)).toEqual([1, 2, 3]);
    expect(r.items.every((i) => ["healthy", "near_expiry"].includes(i.status))).toBe(true);
  });

  test("sort=priority without fefoEligible=1 is rejected (priority is meaningless outside the eligible set)", async () => {
    await expect(reads.listBatchStock(db, { sort: "priority" }, scopeOf(null), { now: NOW })).rejects.toThrow(/fefoEligible/);
  });

  test("expiryBucket is present on every batch row, independent of fefoEligible", async () => {
    const w = await world();
    const r = await reads.listBatchStock(db, { includeEmpty: "1" }, scopeOf(w.d), { now: NOW });
    const by = (n) => r.items.find((i) => i.batchNo === n);
    expect(by("A").expiryBucket).toBe("critical");
    expect(by("B").expiryBucket).toBe("high");
    expect(by("C").expiryBucket).toBe("healthy");
    expect(by("X").expiryBucket).toBe("expired");
    expect(by("A").priority).toBeNull(); // only computed when fefoEligible=1
  });

  test("priority ranking is scoped per (distributor, warehouse, product) — a second product does not affect it", async () => {
    const w = await world();
    const p2 = await seedProduct(w.d.id, { name: "Other product" });
    const other = await seedBatch(w.d.id, p2.id, { exp_date: day(1) }); // earliest overall, but a different product
    await post(w.d, p2, other, 10);
    const r = await reads.listBatchStock(db, { fefoEligible: "1", productId: String(w.p.id) }, scopeOf(w.d), { now: NOW });
    expect(r.items.map((i) => i.priority)).toEqual([1, 2, 3]); // unaffected by the other product's earlier expiry
  });

  test("bucket filter (critical/high/medium/healthy/expired) — a date-only filter; it does not exclude non-saleable batches, only the KPI summary does", async () => {
    const w = await world();
    // Y is critical-dated but already fully non-saleable: it still shows up here (Status conveys that), matching the
    // Near Expiry page's intent — a list of what's in the window, whatever its state — distinct from
    // getExpiryBucketSummary's KPI totals, which deliberately exclude stock already dealt with.
    for (const [bucket, expected] of [["critical", ["A", "Y"]], ["high", ["B"]], ["healthy", ["C"]], ["expired", ["X"]]]) {
      const r = await reads.listBatchStock(db, { bucket, includeEmpty: "1" }, scopeOf(w.d), { now: NOW });
      expect(r.items.map((i) => i.batchNo).sort()).toEqual(expected.sort());
    }
    expect((await reads.listBatchStock(db, { bucket: "critical", includeEmpty: "1" }, scopeOf(w.d), { now: NOW })).items.find((i) => i.batchNo === "Y").status).toBe("non_saleable");
    await expect(reads.listBatchStock(db, { bucket: "bogus" }, scopeOf(null))).rejects.toThrow(/bucket/);
  });

  test("expiry date-range filter (Near Expiry page)", async () => {
    const w = await world();
    const from = day(10).toISOString().slice(0, 10);
    const to = day(50).toISOString().slice(0, 10);
    const r = await reads.listBatchStock(db, { expFrom: from, expTo: to, includeEmpty: "1" }, scopeOf(w.d), { now: NOW });
    expect(r.items.map((i) => i.batchNo).sort()).toEqual(["A", "B", "Y"]); // Y is in range too (it's just non-saleable, still has that expiry date)
  });

  test("default sort stays FEFO-oriented (earliest expiry first); other sortable columns still work", async () => {
    const w = await world();
    const def = await reads.listBatchStock(db, {}, scopeOf(w.d), { now: NOW });
    expect(def.items[0].batchNo).toBe("X"); // expired sorts earliest of all by exp_date ASC
    const byValue = await reads.listBatchStock(db, { sort: "value", dir: "desc", includeEmpty: "1" }, scopeOf(w.d), { now: NOW });
    expect(byValue.items[0].batchNo).toBe("C"); // 200 units, largest stock value
  });
});

// ───────────────────────────── Expiry bucket summary (KPIs / dashboard) ─────────────────────────────
describe("getExpiryBucketSummary", () => {
  test("critical/high/medium count only SALEABLE, active, not-yet-expired stock; expired counts full on-hand", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const A = await seedBatch(d.id, p.id, { exp_date: day(10), purchase_price: 2 }); // critical
    const held = await seedBatch(d.id, p.id, { exp_date: day(10), purchase_price: 2 }); // critical but fully non-saleable
    const X = await seedBatch(d.id, p.id, { exp_date: day(-2), purchase_price: 2 }); // expired
    await post(d, p, A, 10);
    await post(d, p, held, 10);
    await post(d, p, X, 10);
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: held.id, quantity: 10, reasonCode: "DAMAGED", transaction: t });
    await t.commit();

    const s = await reads.getExpiryBucketSummary(db, { distributorId: d.id }, { now: NOW });
    expect(s.critical).toMatchObject({ batches: 1, products: 1, units: 10, value: 20 }); // `held` excluded — already dealt with
    expect(s.expired).toMatchObject({ batches: 1, products: 1, units: 10, value: 20 });
  });

  test("distributorId null aggregates across every tenant (Admin Dashboard use case); a specific id scopes to one", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    await post(a, pa, await seedBatch(a.id, pa.id, { exp_date: day(10) }), 5);
    await post(b, pb, await seedBatch(b.id, pb.id, { exp_date: day(10) }), 7);
    expect((await reads.getExpiryBucketSummary(db, { distributorId: a.id }, { now: NOW })).critical.units).toBe(5);
    expect((await reads.getExpiryBucketSummary(db, { distributorId: null }, { now: NOW })).critical.units).toBe(12);
  });
});

// ───────────────────────────── Batch Detail integration (item 20) ─────────────────────────────
describe("Batch Detail: FEFO priority and expiry bucket", () => {
  test("extends the existing detail response; priority matches the FEFO Monitor's SQL-computed priority for the same batch", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const A = await seedBatch(d.id, p.id, { batch_no: "A", exp_date: day(15) });
    const B = await seedBatch(d.id, p.id, { batch_no: "B", exp_date: day(45) });
    await post(d, p, A, 50);
    await post(d, p, B, 100);

    const detailA = await reads.getBatchDetail(db, A.id, scopeOf(d), { now: NOW });
    const detailB = await reads.getBatchDetail(db, B.id, scopeOf(d), { now: NOW });
    expect(detailA.expiryBucket).toBe("critical");
    expect(detailA.fefo.priority).toBe(1);
    expect(detailB.fefo.priority).toBe(2);
    expect(detailA.fefo.warehouse).toMatchObject({ code: "MAIN" });

    const monitor = await reads.listBatchStock(db, { fefoEligible: "1" }, scopeOf(d), { now: NOW });
    expect(detailA.fefo.priority).toBe(monitor.items.find((i) => i.batchNo === "A").priority);
    expect(detailB.fefo.priority).toBe(monitor.items.find((i) => i.batchNo === "B").priority);
  });

  test("priority is null (not applicable) with an explanatory note when the batch is expired or fully non-saleable", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const expired = await seedBatch(d.id, p.id, { exp_date: day(-1) });
    await post(d, p, expired, 10);
    const det = await reads.getBatchDetail(db, expired.id, scopeOf(d), { now: NOW });
    expect(det.fefo.priority).toBeNull();
    expect(det.fefo.note).toMatch(/not currently eligible/i);
  });
});

// ───────────────────────────── Sales integration & regression ─────────────────────────────
describe("Sales flow regression with multi-batch FEFO allocation", () => {
  test("order for 180 draws 50 + 100 + 30 across three batches; stock, ledger and invoice all agree", async () => {
    const d = await seedDistributor();
    await seedGLAccounts(d);
    const p = await seedProduct(d.id, { name: "Flow Tabs", reorder_level: 5 });
    const A = await seedBatch(d.id, p.id, { batch_no: "FLOW-A", exp_date: day(15), purchase_price: 2, mrp: 3 });
    const B = await seedBatch(d.id, p.id, { batch_no: "FLOW-B", exp_date: day(45), purchase_price: 2, mrp: 3 });
    const C = await seedBatch(d.id, p.id, { batch_no: "FLOW-C", exp_date: day(300), purchase_price: 2, mrp: 3 });
    await post(d, p, A, 50);
    await post(d, p, B, 100);
    await post(d, p, C, 200);

    const so = await seedSalesOrder(d, { productId: p.id, quantity: 180, status: "CONFIRMED" }); // batchId null → automatic FEFO at delivery
    const sd = mockRes();
    await salesDeliveryController.create(reqFor(d, { order_number: so.order_number, deliveryDate: new Date(), lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 180 }] }), sd);
    expect(sd.status).not.toHaveBeenCalledWith(400);
    const deliveryId = sd.jsonBody.delivery.id;

    const inv = mockRes();
    await salesInvoiceController.create(reqFor(d, { deliveryId }), inv);
    await salesInvoiceController.post(reqFor(d, {}, { id: inv.jsonBody.invoice.id }), mockRes());

    // Stock: 0 / 0 / 170 left
    const stock = await reads.listBatchStock(db, { includeEmpty: "1" }, scopeOf(d), { now: NOW });
    const by = (n) => stock.items.find((i) => i.batchNo === n);
    expect(by("FLOW-A").availableQty).toBe(0);
    expect(by("FLOW-B").availableQty).toBe(0);
    expect(by("FLOW-C").availableQty).toBe(170);

    // Ledger: three SALES rows, in FEFO order, for the SAME delivery line
    const led = await reads.listLedger(db, { productId: String(p.id), txnType: "sale", dir: "asc" }, scopeOf(d));
    expect(led.items.map((i) => [i.batchNo, i.outQty])).toEqual([["FLOW-A", 50], ["FLOW-B", 100], ["FLOW-C", 30]]);

    // Invoice: the batch breakdown per line, straight from the ledger (services/adminSales.service.js) — proves the
    // real Sales/Invoice flow already surfaces a FEFO split by batch (Phase 4 behaviour, unchanged by Phase 6).
    const adminSales = require("../services/adminSales.service");
    const invoiceDetail = await adminSales.getInvoice(db, inv.jsonBody.invoice.id);
    const line = invoiceDetail.lines[0];
    expect(line.batches.map((b) => [b.batchNo, b.quantity]).sort()).toEqual([["FLOW-A", 50], ["FLOW-B", 100], ["FLOW-C", 30]].sort());
  });

  test("an expired batch is excluded from FEFO, cannot be sold, appears in Expired Stock, and stays traceable (not deleted)", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const expired = await seedBatch(d.id, p.id, { batch_no: "OLD-1", exp_date: day(-2) });
    await post(d, p, expired, 50);

    // excluded from FEFO
    const rows = await inventory.getAvailableBatches({ productId: p.id, distributorId: d.id });
    expect(rows.find((r) => r.batch.id === expired.id)).toBeUndefined();

    // cannot be sold, nothing half-posted
    const so = await seedSalesOrder(d, { productId: p.id, batchId: expired.id, quantity: 5, status: "CONFIRMED" });
    const r = mockRes();
    await salesDeliveryController.create(reqFor(d, { order_number: so.order_number, deliveryDate: new Date(), lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 5, batchId: expired.id }] }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(await db.StockLedger.count({ where: { reference_type: "SALES" } })).toBe(0);

    // appears in Expired Stock, unchanged and traceable
    const list = await reads.listBatchStock(db, { status: "expired" }, scopeOf(d), { now: NOW });
    expect(list.items.map((i) => i.batchNo)).toEqual(["OLD-1"]);
    expect(list.items[0].availableQty).toBe(50); // still there — never deleted
    expect(await db.Batch.findByPk(expired.id)).not.toBeNull();
  });

  test("Sales Order preview's FEFO allocation breakdown matches what delivery actually allocates", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id, { name: "Preview Tabs" });
    const cust = await seedCustomer(d.id);
    await seedPricing(d, p, cust.customer_group_id, { basePrice: 20 });
    const A = await seedBatch(d.id, p.id, { batch_no: "PVA", exp_date: day(15) });
    const B = await seedBatch(d.id, p.id, { batch_no: "PVB", exp_date: day(45) });
    await post(d, p, A, 50);
    await post(d, p, B, 100);

    const preview = await adminSalesOrder.previewOrder({ distributorId: d.id, customerId: cust.id, paymentTerms: "Net 30", lines: [{ productId: p.id, quantity: 120 }] });
    expect(preview.lines[0].fefoAllocation).toEqual([
      { batchId: A.id, batchNo: "PVA", expDate: A.exp_date.toISOString().slice(0, 10), available: 50, allocated: 50 },
      { batchId: B.id, batchNo: "PVB", expDate: B.exp_date.toISOString().slice(0, 10), available: 100, allocated: 70 },
    ]);
    expect(preview.lines[0].fefoSufficient).toBe(true);

    const actual = await inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 120 });
    expect(actual).toEqual([{ batchId: A.id, quantity: 50 }, { batchId: B.id, quantity: 70 }]);
  });
});

// ───────────────────────────── Security / tenant isolation for the new surfaces ─────────────────────────────
describe("tenant isolation (Phase 6 additions)", () => {
  test("fefoEligible / bucket / expFrom-expTo filters never leak another distributor's batches", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    await post(a, pa, await seedBatch(a.id, pa.id, { exp_date: day(10) }), 10);
    await post(b, pb, await seedBatch(b.id, pb.id, { exp_date: day(10) }), 10);
    const scopeA = scopeOf(a);
    expect((await reads.listBatchStock(db, { fefoEligible: "1", distributorId: String(b.id) }, scopeA, { now: NOW })).items.every((i) => i.distributor.id === a.id)).toBe(true);
    expect((await reads.listBatchStock(db, { bucket: "critical", distributorId: String(b.id) }, scopeA, { now: NOW })).items.every((i) => i.distributor.id === a.id)).toBe(true);
  });

  test("HTTP: distributor fefo-preview always previews itself; a spoofed distributorId in the query is ignored", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    await post(a, pa, await seedBatch(a.id, pa.id, { exp_date: day(10) }), 10);
    const res = mockRes();
    res.set = jest.fn();
    await invController.distributorReads.fefoPreview(reqFor(a, {}, {}, { productId: String(pa.id), quantity: "5", distributorId: String(b.id) }), res);
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.jsonBody.distributorId).toBe(a.id);
    expect(res.jsonBody.sufficient).toBe(true);
  });

  test("HTTP: admin fefo-preview requires an explicit distributorId (no cross-tenant default)", async () => {
    const res = mockRes();
    res.set = jest.fn();
    await invController.adminReads.fefoPreview(reqFor({ id: 0 }, {}, {}, { productId: "1", quantity: "5" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("HTTP: expiry-summary — distributor session is always scoped to itself; admin may scope or see all", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const pb = await seedProduct(b.id);
    await post(a, pa, await seedBatch(a.id, pa.id, { exp_date: day(10) }), 3);
    await post(b, pb, await seedBatch(b.id, pb.id, { exp_date: day(10) }), 4);

    const distRes = mockRes();
    distRes.set = jest.fn();
    await invController.distributorReads.expirySummary(reqFor(a, {}, {}, { distributorId: String(b.id) }), distRes); // spoof attempt
    expect(distRes.jsonBody.critical.units).toBe(3); // ignored — always its own tenant

    const adminAll = mockRes();
    adminAll.set = jest.fn();
    await invController.adminReads.expirySummary(reqFor({ id: 0 }, {}, {}, {}), adminAll);
    expect(adminAll.jsonBody.critical.units).toBe(7); // both tenants

    const adminOne = mockRes();
    adminOne.set = jest.fn();
    await invController.adminReads.expirySummary(reqFor({ id: 0 }, {}, {}, { distributorId: String(a.id) }), adminOne);
    expect(adminOne.jsonBody.critical.units).toBe(3);
  });

  test("previewFefoAllocation rejects another distributor's warehouse and never returns another tenant's batches", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    await post(a, pa, await seedBatch(a.id, pa.id, { exp_date: day(10) }), 10);
    const foreign = await inventory.ensureDefaultWarehouse({ distributorId: b.id });
    await expect(inventory.previewFefoAllocation({ productId: pa.id, distributorId: a.id, quantity: 5, warehouseId: foreign.id })).rejects.toThrow(/Invalid warehouse/);
    // asking distributor b to preview a's product finds nothing allocatable (batches are tenant-scoped)
    const cross = await inventory.previewFefoAllocation({ productId: pa.id, distributorId: b.id, quantity: 5 });
    expect(cross).toMatchObject({ totalAllocated: 0, allocations: [], sufficient: false });
  });

  test("Batch Detail's fefo.priority computation never crosses tenant boundaries (dispatch warehouse resolved within the batch's own distributor)", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const pa = await seedProduct(a.id);
    const ba = await seedBatch(a.id, pa.id, { exp_date: day(5) });
    await post(a, pa, ba, 10);
    // Distributor b has an earlier-expiring batch of an unrelated product — must not affect a's priority.
    const pb = await seedProduct(b.id);
    await post(b, pb, await seedBatch(b.id, pb.id, { exp_date: day(1) }), 10);
    const det = await reads.getBatchDetail(db, ba.id, scopeOf(a), { now: NOW });
    expect(det.fefo.priority).toBe(1);
  });
});

// ───────────────────────────── Regression: the rest of the suite is exercised by the other test files ─────────────────────────────
describe("regression smoke (Phase 6 changes do not alter unrelated behaviour)", () => {
  test("allocateStock's return shape for a manually-specified batch is unchanged", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 10);
    await expect(inventory.allocateStock({ productId: p.id, distributorId: d.id, quantity: 5, batchId: b.id })).resolves.toEqual([{ batchId: b.id, quantity: 5 }]);
  });

  test("markNonSaleable/releaseNonSaleable still accept REGULATORY_HOLD as a normal reason", async () => {
    const d = await seedDistributor();
    const p = await seedProduct(d.id);
    const b = await seedBatch(d.id, p.id, { exp_date: day(400) });
    await post(d, p, b, 10);
    const t = await db.sequelize.transaction();
    await inventory.markNonSaleable({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 10, reasonCode: "REGULATORY_HOLD", transaction: t });
    await t.commit();
    expect(await inventory.getBatchNonSaleableQty({ batchId: b.id, distributorId: d.id, reason: "REGULATORY_HOLD" })).toBe(10);
  });
});
