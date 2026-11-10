// Phase 7 — Product / Batch / Pricing / Tax Masters (Admin portal). Runs on the same in-memory sqlite as the
// existing suites. Admin controllers are called directly (same convention as the other admin/controller tests in
// this repo — see inventory.controllers.test.js) rather than through HTTP, since requireAdmin is a thin cookie
// check already covered by admin.auth tests; these tests exercise admin.masters.controller + adminMasters.service.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedPricing } = require("./helpers");
const adminMasters = require("../controllers/admin.masters.controller");
const tax = require("../services/tax.service");

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

const adminReq = (overrides = {}) => ({ admin: { id: 1, name: "Admin", role: "ADMIN" }, body: {}, params: {}, query: {}, ...overrides });

describe("tax.service.splitGstRate", () => {
  test("halves the rate for CGST/SGST and mirrors it for IGST", () => {
    expect(tax.splitGstRate(12)).toEqual({ gstRate: 12, cgstRate: 6, sgstRate: 6, igstRate: 12 });
    expect(tax.splitGstRate(5)).toEqual({ gstRate: 5, cgstRate: 2.5, sgstRate: 2.5, igstRate: 5 });
    expect(tax.splitGstRate(null)).toEqual({ gstRate: 0, cgstRate: 0, sgstRate: 0, igstRate: 0 });
  });
});

describe("Product Master (Admin)", () => {
  test("lists products across distributors, paginated, and can filter by distributor/category/status", async () => {
    const d1 = await seedDistributor();
    const d2 = await seedDistributor();
    await seedProduct(d1.id, { name: "Paracetamol 500mg", category: "Analgesic", status: "active" });
    await seedProduct(d1.id, { name: "Old Discontinued Syrup", category: "Cough Syrup", status: "inactive" });
    await seedProduct(d2.id, { name: "Amoxicillin 250mg", category: "Antibiotic", status: "active" });

    const resAll = mockRes();
    await adminMasters.listProducts(adminReq({ query: {} }), resAll);
    expect(resAll.statusCode).toBe(200);
    expect(resAll.jsonBody.total).toBe(3);

    const resD1 = mockRes();
    await adminMasters.listProducts(adminReq({ query: { distributorId: String(d1.id) } }), resD1);
    expect(resD1.jsonBody.total).toBe(2);

    const resActive = mockRes();
    await adminMasters.listProducts(adminReq({ query: { distributorId: String(d1.id), status: "active" } }), resActive);
    expect(resActive.jsonBody.total).toBe(1);
    expect(resActive.jsonBody.items[0].name).toBe("Paracetamol 500mg");

    const resSearch = mockRes();
    await adminMasters.listProducts(adminReq({ query: { q: "amox" } }), resSearch);
    expect(resSearch.jsonBody.items.map((i) => i.name)).toEqual(["Amoxicillin 250mg"]);
  });

  test("product detail includes distributor, HSN/GST split, batches and pricing", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id, { name: "Paracetamol 500mg", gst: 12 });
    await seedBatch(d.id, product.id, { batch_no: "PCM-001" });
    await seedPricing(d, product, (await db.CustomerGroup.create({ code: "RET", name: "Retail", distributor_id: d.id })).id);

    const res = mockRes();
    await adminMasters.getProduct(adminReq({ params: { id: String(product.id) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.distributor.id).toBe(d.id);
    expect(res.jsonBody.gst).toEqual({ rate: 12, cgstRate: 6, sgstRate: 6, igstRate: 12 });
    expect(res.jsonBody.batches).toHaveLength(1);
    expect(res.jsonBody.pricing).toHaveLength(1);

    const missing = mockRes();
    await adminMasters.getProduct(adminReq({ params: { id: "999999" } }), missing);
    expect(missing.statusCode).toBe(404);
  });

  test("create requires distributorId and a valid HSN; new product belongs to the named distributor", async () => {
    const d = await seedDistributor();
    const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });

    const badRes = mockRes();
    await adminMasters.createProduct(adminReq({ body: { name: "No distributor", hsn_id: hsn.id } }), badRes);
    expect(badRes.statusCode).toBe(400);

    const res = mockRes();
    await adminMasters.createProduct(
      adminReq({ body: { distributorId: d.id, name: "Cetrizine 10mg", unit: "TAB", hsn_id: hsn.id, mrp: 25.5, sale_price: 20, status: "active" } }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.distributor_id).toBe(d.id);
    expect(res.jsonBody.material_code).toMatch(/^MTC\d+$/);

    const created = await db.Product.findByPk(res.jsonBody.id);
    expect(Number(created.mrp)).toBe(25.5);
  });

  test("update resolves the owning distributor from the record — a spoofed distributorId in the body is ignored", async () => {
    const d1 = await seedDistributor();
    const d2 = await seedDistributor();
    const product = await seedProduct(d1.id, { name: "Ibuprofen 400mg" });

    const res = mockRes();
    await adminMasters.updateProduct(adminReq({ params: { id: String(product.id) }, body: { distributorId: d2.id, name: "Ibuprofen 400mg Renamed" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.name).toBe("Ibuprofen 400mg Renamed");

    const reloaded = await db.Product.findByPk(product.id);
    expect(reloaded.distributor_id).toBe(d1.id); // unchanged — the spoofed distributorId never took effect
  });

  test("deactivate / reactivate toggle status without a destructive delete", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id, { status: "active" });

    const off = mockRes();
    await adminMasters.setProductStatus("inactive")(adminReq({ params: { id: String(product.id) } }), off);
    expect(off.statusCode).toBe(200);
    expect(off.jsonBody.status).toBe("inactive");
    expect(await db.Product.findByPk(product.id)).not.toBeNull(); // still exists — not deleted

    const on = mockRes();
    await adminMasters.setProductStatus("active")(adminReq({ params: { id: String(product.id) } }), on);
    expect(on.jsonBody.status).toBe("active");
  });
});

describe("Batch Master (Admin)", () => {
  test("lists batches across distributors and filters by product/status", async () => {
    const d = await seedDistributor();
    const p1 = await seedProduct(d.id, { name: "Paracetamol 500mg" });
    const p2 = await seedProduct(d.id, { name: "Amoxicillin 250mg" });
    await seedBatch(d.id, p1.id, { batch_no: "PCM-001", status: "active" });
    await seedBatch(d.id, p1.id, { batch_no: "PCM-002", status: "inactive" });
    await seedBatch(d.id, p2.id, { batch_no: "AMX-001", status: "active" });

    const res = mockRes();
    await adminMasters.listBatches(adminReq({ query: { productId: String(p1.id) } }), res);
    expect(res.jsonBody.total).toBe(2);

    const activeOnly = mockRes();
    await adminMasters.listBatches(adminReq({ query: { productId: String(p1.id), status: "active" } }), activeOnly);
    expect(activeOnly.jsonBody.total).toBe(1);
    expect(activeOnly.jsonBody.items[0].batchNo).toBe("PCM-001");
  });

  test("create posts identity fields via the existing Batch validation and rejects a duplicate batch number", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);

    const res = mockRes();
    await adminMasters.createBatch(
      adminReq({ body: { distributorId: d.id, productId: product.id, batch_no: "B-100", mfg_date: "2026-01-01", exp_date: "2027-01-01", mrp: 50 } }),
      res
    );
    expect(res.statusCode).toBe(201);

    const dup = mockRes();
    await adminMasters.createBatch(
      adminReq({ body: { distributorId: d.id, productId: product.id, batch_no: "B-100", mfg_date: "2026-01-01", exp_date: "2027-01-01" } }),
      dup
    );
    expect(dup.statusCode).toBe(400);
    expect(dup.jsonBody.message).toMatch(/already exists/i);
  });

  test("rejects expiry on/before manufacturing date (existing batchValidation rule, not re-implemented)", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const res = mockRes();
    await adminMasters.createBatch(
      adminReq({ body: { distributorId: d.id, productId: product.id, batch_no: "B-BAD", mfg_date: "2026-06-01", exp_date: "2026-01-01" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.message).toMatch(/expiry date must be after/i);
  });

  test("optional openingQty posts an OPENING stock ledger movement alongside batch creation", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const inventory = require("../services/inventory.service");

    const res = mockRes();
    await adminMasters.createBatch(
      adminReq({ body: { distributorId: d.id, productId: product.id, batch_no: "B-200", mfg_date: "2026-01-01", exp_date: "2027-01-01", openingQty: 100 } }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.openingStockPosted).toBe(true);

    const available = await inventory.getBatchAvailableQty({ batchId: res.jsonBody.batch.id, distributorId: d.id });
    expect(available).toBe(100);

    const ledgerRow = await db.StockLedger.findOne({ where: { batchId: res.jsonBody.batch.id } });
    expect(ledgerRow.reference_type).toBe("OPENING");
  });

  test("batch detail reuses the existing Inventory Batch Detail (stock + expiry), unscoped across tenants", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const batch = await seedBatch(d.id, product.id, { batch_no: "B-300", mrp: 42 });

    const res = mockRes();
    await adminMasters.getBatch(adminReq({ params: { id: String(batch.id) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.batchNo).toBe("B-300");
    expect(res.jsonBody.stock).toBeDefined();
    expect(res.jsonBody.expiryBucket).toBeDefined();
  });

  test("deactivate / reactivate toggle batch status", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const batch = await seedBatch(d.id, product.id, { status: "active" });

    const off = mockRes();
    await adminMasters.setBatchStatus("inactive")(adminReq({ params: { id: String(batch.id) } }), off);
    expect(off.jsonBody.batch.status).toBe("inactive");
  });
});

describe("Pricing Master (Admin)", () => {
  test("lists pricing records with product/customer group/distributor context and active/inactive filters", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const group = await db.CustomerGroup.create({ code: "WS", name: "Wholesale", distributor_id: d.id });
    await seedPricing(d, product, group.id, { basePrice: 100, discountPercent: 10 });

    const res = mockRes();
    await adminMasters.listPricing(adminReq({ query: { distributorId: String(d.id) } }), res);
    expect(res.jsonBody.total).toBe(1);
    expect(res.jsonBody.items[0].unitPrice).toBe(90);
    expect(res.jsonBody.items[0].active).toBe(true);
  });

  test("create reuses pricing.service's referenced-ownership validation (product/group must belong to the target distributor)", async () => {
    const d1 = await seedDistributor();
    const d2 = await seedDistributor();
    const productD1 = await seedProduct(d1.id);
    const groupD2 = await db.CustomerGroup.create({ code: "RET", name: "Retail", distributor_id: d2.id });

    const res = mockRes();
    await adminMasters.createPricing(
      adminReq({ body: { distributorId: d1.id, productId: productD1.id, customer_group_id: groupD2.id, base_price: 50, valid_from: "2026-01-01" } }),
      res
    );
    expect(res.statusCode).toBe(400); // groupD2 does not belong to d1
  });

  test("detail's history reflects the single row the schema allows per (product, group, distributor)", async () => {
    // PricingMaster has a hard unique index on (productId, customer_group_id, distributor_id) — only one row can
    // ever exist per combination, so "history" always resolves to exactly that current row (see service comment).
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const group = await db.CustomerGroup.create({ code: "RET", name: "Retail", distributor_id: d.id });
    const current = await seedPricing(d, product, group.id, { basePrice: 50 });

    const res = mockRes();
    await adminMasters.getPricing(adminReq({ params: { id: String(current.id) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.history).toHaveLength(1);
    expect(res.jsonBody.history[0]).toMatchObject({ current: true, basePrice: 50 });
  });

  test("deactivate ends validity (valid_to) instead of deleting the row, preserving history", async () => {
    const d = await seedDistributor();
    const product = await seedProduct(d.id);
    const group = await db.CustomerGroup.create({ code: "RET", name: "Retail", distributor_id: d.id });
    const pricing = await seedPricing(d, product, group.id);

    const res = mockRes();
    await adminMasters.deactivatePricing(adminReq({ params: { id: String(pricing.id) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.valid_to).not.toBeNull();
    expect(await db.PricingMaster.findByPk(pricing.id)).not.toBeNull();
  });
});

describe("Tax Master / HSN (Admin)", () => {
  test("lists HSN records with the CGST/SGST/IGST split computed from tax.service, not duplicated inline", async () => {
    const d = await seedDistributor();
    await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });

    const res = mockRes();
    await adminMasters.listTaxes(adminReq({ query: {} }), res);
    expect(res.jsonBody.total).toBe(1);
    expect(res.jsonBody.items[0]).toMatchObject({ hsnCode: "3004", gstRate: 12, cgstRate: 6, sgstRate: 6, igstRate: 12 });
  });

  test("create rejects a duplicate HSN code for the same distributor (existing hsngroup.controller rule)", async () => {
    const d = await seedDistributor();
    const first = mockRes();
    await adminMasters.createTax(adminReq({ body: { distributorId: d.id, hsn_code: "3004", description: "Medicaments", gst_rate: 12 } }), first);
    expect(first.statusCode).toBe(201);

    const dup = mockRes();
    await adminMasters.createTax(adminReq({ body: { distributorId: d.id, hsn_code: "3004", description: "Medicaments (dup)", gst_rate: 5 } }), dup);
    expect(dup.statusCode).toBe(400);
  });

  test("update edits description/rate — functionality that did not exist before this phase", async () => {
    const d = await seedDistributor();
    const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });

    const res = mockRes();
    await adminMasters.updateTax(adminReq({ params: { id: String(hsn.id) }, body: { gst_rate: 18, description: "Medicaments (revised)" } }), res);
    expect(res.statusCode).toBe(200);
    expect(Number(res.jsonBody.gst_rate)).toBe(18);
    expect(res.jsonBody.description).toBe("Medicaments (revised)");
  });

  test("detail lists the products currently on this HSN", async () => {
    const d = await seedDistributor();
    const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });
    await seedProduct(d.id, { hsn_id: hsn.id, name: "Paracetamol 500mg" });

    const res = mockRes();
    await adminMasters.getTax(adminReq({ params: { id: String(hsn.id) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.products.map((p) => p.name)).toEqual(["Paracetamol 500mg"]);
  });
});
