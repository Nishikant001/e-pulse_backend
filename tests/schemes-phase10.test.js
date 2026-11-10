// Phase 10 — Scheme Engine. Same in-memory sqlite + direct-controller convention as Phases 7–9.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedCustomer } = require("./helpers");
const adminCtrl = require("../controllers/admin.schemes.controller");
const distCtrl = require("../controllers/scheme.controller");
const engine = require("../services/schemeEngine.service");
const requireAdmin = require("../middleware/adminAuth");
const adminRoutes = require("../routes/adminRoutes");
const allRoutes = require("../routes/allRoutes");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const adminReq = (o = {}) => ({ admin: { id: 1, name: "Admin", role: "ADMIN" }, body: {}, params: {}, query: {}, ...o });
const distReq = (d, o = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body: {}, params: {}, query: {}, ...o });
const callAdmin = async (fn, o) => { const res = mockRes(); await fn(adminReq(o), res); return res; };
const callDist = async (fn, d, o) => { const res = mockRes(); await fn(distReq(d, o), res); return res; };

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const buy10 = (p, o = {}) => ({ name: "Buy 10 Get 1", scheme_code: "BUY10GET1", scheme_type: "QUANTITY_FREE", product_scope: "PRODUCTS", product_ids: [p.id], buy_quantity: 10, free_quantity: 1, valid_from: day(-5), valid_to: day(30), ...o });
const create = async (b) => { const r = await callAdmin(adminCtrl.create, { body: b }); return r; };
const evalFor = async (d, lines, extra = {}) => (await callDist(distCtrl.evaluate, d, { body: { lines, ...extra } })).jsonBody;

describe("Admin CRUD & validation", () => {
  test("create → get → list → edit → deactivate/activate", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const c = await create(buy10(p));
    expect(c.statusCode).toBe(201);
    expect(c.jsonBody.code).toBe("BUY10GET1");
    expect(c.jsonBody.effectiveStatus).toBe("active");
    expect(c.jsonBody.products[0].id).toBe(p.id);
    const id = c.jsonBody.id;
    expect((await callAdmin(adminCtrl.get, { params: { id } })).jsonBody.ruleSummary).toBe("Buy 10 get 1 free");
    const list = await callAdmin(adminCtrl.list, { query: {} });
    expect(list.jsonBody.total).toBe(1);
    const up = await callAdmin(adminCtrl.update, { params: { id }, body: { name: "Renamed", free_quantity: 2, priority: 5 } });
    expect(up.statusCode).toBe(200);
    expect(up.jsonBody.freeQuantity).toBe(2);
    expect(up.jsonBody.priority).toBe(5);
    const off = await callAdmin(adminCtrl.setStatus, { params: { id }, body: { status: "inactive" } });
    expect(off.jsonBody.status).toBe("inactive");
    expect(off.jsonBody.effectiveStatus).toBe("inactive");
    expect((await callAdmin(adminCtrl.setStatus, { params: { id }, body: { status: "active" } })).jsonBody.status).toBe("active");
    expect((await callAdmin(adminCtrl.setStatus, { params: { id }, body: { status: "bogus" } })).statusCode).toBe(400);
  });

  test("auto-generates a code; duplicate code rejected (409)", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const auto = await create(buy10(p, { scheme_code: undefined }));
    expect(auto.jsonBody.code).toMatch(/^SCH\d{4}$/);
    expect((await create(buy10(p))).statusCode).toBe(201);
    const dup = await create(buy10(p, { name: "again" }));
    expect(dup.statusCode).toBe(409);
    expect(dup.jsonBody.code).toBe("DUPLICATE_CODE");
  });

  test.each([
    ["missing name", { name: "" }],
    ["zero buy quantity", { buy_quantity: 0 }],
    ["negative free quantity", { free_quantity: -1 }],
    ["valid_to before valid_from", { valid_to: day(-10) }],
    ["bad type", { scheme_type: "BOGO" }],
    ["no products", { product_ids: [] }],
    ["unknown product", { product_ids: [99999] }],
    ["bad code format", { scheme_code: "a b" }],
  ])("rejects %s", async (_n, o) => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const r = await create(buy10(p, o));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(await db.Scheme.count()).toBe(0);
  });

  test("percent / fixed rule validation", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const base = { name: "X", product_scope: "PRODUCTS", product_ids: [p.id], valid_from: day(-1) };
    expect((await create({ ...base, scheme_type: "PERCENT_DISCOUNT", discount_percent: -5 })).statusCode).toBe(400);
    expect((await create({ ...base, scheme_type: "PERCENT_DISCOUNT", discount_percent: 101 })).statusCode).toBe(400);
    expect((await create({ ...base, scheme_type: "FIXED_DISCOUNT", discount_amount: 0 })).statusCode).toBe(400);
    expect((await create({ ...base, scheme_type: "PERCENT_DISCOUNT", discount_percent: 10, min_quantity: 10, max_quantity: 5 })).statusCode).toBe(400);
    expect((await create({ ...base, scheme_type: "PERCENT_DISCOUNT", discount_percent: 10 })).statusCode).toBe(201);
  });

  test("type and code are immutable; unknown fields ignored (no mass assignment)", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const id = (await create(buy10(p))).jsonBody.id;
    expect((await callAdmin(adminCtrl.update, { params: { id }, body: { scheme_type: "PERCENT_DISCOUNT" } })).statusCode).toBe(400);
    expect((await callAdmin(adminCtrl.update, { params: { id }, body: { scheme_code: "OTHER" } })).statusCode).toBe(400);
    await callAdmin(adminCtrl.update, { params: { id }, body: { id: 999, created_by_admin_id: 77 } });
    expect((await db.Scheme.findByPk(id)).created_by_admin_id).toBe(1);
  });

  test("applicability consistency: product / retailer of another distributor rejected", async () => {
    const d1 = await seedDistributor(); const d2 = await seedDistributor();
    const p1 = await seedProduct(d1.id); const p2 = await seedProduct(d2.id);
    const r2 = await seedCustomer(d2.id);
    expect((await create(buy10(p2, { distributor_scope: "SPECIFIC", distributor_ids: [d1.id] }))).statusCode).toBe(400);
    expect((await create(buy10(p1, { distributor_scope: "SPECIFIC", distributor_ids: [d1.id], retailer_scope: "SPECIFIC", retailer_ids: [r2.id] }))).statusCode).toBe(400);
    expect((await create(buy10(p1, { distributor_scope: "SPECIFIC", distributor_ids: [999] }))).statusCode).toBe(400);
    expect((await create(buy10(p1, { distributor_scope: "SPECIFIC", distributor_ids: [d1.id] }))).statusCode).toBe(201);
  });

  test("search / filter / sort / paginate", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id); const p2 = await seedProduct(d.id);
    await create(buy10(p, { scheme_code: "AAA1", name: "Alpha" }));
    await create({ name: "Beta pct", scheme_code: "BBB1", scheme_type: "PERCENT_DISCOUNT", discount_percent: 5, product_ids: [p2.id], valid_from: day(5) });
    const off = (await create(buy10(p2, { scheme_code: "CCC1", name: "Gamma", valid_from: day(-30), valid_to: day(-2) }))).jsonBody;
    await callAdmin(adminCtrl.setStatus, { params: { id: off.id }, body: { status: "inactive" } });
    const L = async (query) => (await callAdmin(adminCtrl.list, { query })).jsonBody;
    expect((await L({ q: "alpha" })).total).toBe(1);
    expect((await L({ q: "%" })).total).toBe(0); // wildcard escaped
    expect((await L({ status: "inactive" })).total).toBe(1);
    expect((await L({ type: "PERCENT_DISCOUNT" })).total).toBe(1);
    expect((await L({ productId: p2.id })).total).toBe(2);
    expect((await L({ validity: "current" })).total).toBe(1);
    expect((await L({ validity: "upcoming" })).total).toBe(1);
    expect((await L({ validity: "expired" })).total).toBe(1);
    expect((await L({ distributorId: d.id })).total).toBe(3);
    const s = await L({ sort: "name", dir: "asc", pageSize: 2, page: 2 });
    expect(s.rows).toHaveLength(1);
    expect(s.totalPages).toBe(2);
    expect((await callAdmin(adminCtrl.list, { query: { sort: "id; DROP" } })).statusCode).toBe(400);
    expect((await callAdmin(adminCtrl.list, { query: { pageSize: 5000 } })).statusCode).toBe(400);
  });
});

describe("Calculation", () => {
  test("Buy 10 get 1: 9 → not eligible, 10 → 1 free, 20 → 2 free, 25 → 2 free; paid and free kept apart", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create(buy10(p));
    const r = await evalFor(d, [{ productId: p.id, quantity: 9 }, { productId: p.id, quantity: 10 }, { productId: p.id, quantity: 20 }, { productId: p.id, quantity: 25 }]);
    expect(r.lines[0].applied).toBeNull();
    expect(r.lines[0].considered[0]).toMatchObject({ eligible: false, reason: "BELOW_MINIMUM_QUANTITY" });
    expect(r.lines[1].applied).toMatchObject({ eligible: true, schemeCode: "BUY10GET1", benefitType: "FREE_QUANTITY", buyQuantity: 10, freeQuantity: 1, purchasedQuantity: 10, totalQuantity: 11 });
    expect(r.lines[2].applied).toMatchObject({ freeQuantity: 2, purchasedQuantity: 20, totalQuantity: 22 });
    expect(r.lines[3].applied.freeQuantity).toBe(2);
    expect(r.stacking).toBe(false);
  });

  test("max_quantity caps the quantity that earns free goods", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create(buy10(p, { max_quantity: 30 }));
    const r = await evalFor(d, [{ productId: p.id, quantity: 100 }]);
    expect(r.lines[0].applied.freeQuantity).toBe(3);
  });

  test("percent and fixed discounts, min quantity, max discount cap", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create({ name: "P", scheme_code: "PCT", scheme_type: "PERCENT_DISCOUNT", discount_percent: 10, min_quantity: 5, max_discount: 50, product_ids: [p.id], valid_from: day(-1), priority: 1 });
    let r = await evalFor(d, [{ productId: p.id, quantity: 4, unitPrice: 100 }, { productId: p.id, quantity: 5, unitPrice: 100 }, { productId: p.id, quantity: 20, unitPrice: 100 }, { productId: p.id, quantity: 5 }]);
    expect(r.lines[0].applied).toBeNull();
    expect(r.lines[1].applied.discountAmount).toBe(50);
    expect(r.lines[2].applied.discountAmount).toBe(50); // capped by max_discount
    expect(r.lines[3].applied.discountAmount).toBeNull(); // no price supplied
    await db.Scheme.destroy({ where: {} });
    await create({ name: "F", scheme_code: "FIX", scheme_type: "FIXED_DISCOUNT", discount_amount: 500, product_ids: [p.id], valid_from: day(-1) });
    r = await evalFor(d, [{ productId: p.id, quantity: 1, unitPrice: 100 }, { productId: p.id, quantity: 10, unitPrice: 100 }]);
    expect(r.lines[0].applied.discountAmount).toBe(100); // never more than the line value
    expect(r.lines[1].applied.discountAmount).toBe(500);
  });

  test("expired, future and inactive schemes never apply", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create(buy10(p, { scheme_code: "EXP", valid_from: day(-30), valid_to: day(-1) }));
    await create(buy10(p, { scheme_code: "FUT", valid_from: day(1), valid_to: null }));
    const off = (await create(buy10(p, { scheme_code: "OFF" }))).jsonBody;
    await callAdmin(adminCtrl.setStatus, { params: { id: off.id }, body: { status: "inactive" } });
    expect((await evalFor(d, [{ productId: p.id, quantity: 50 }])).lines[0].applied).toBeNull();
    // boundaries are inclusive and asOf-driven (backend clock, not the client)
    const on = await evalFor(d, [{ productId: p.id, quantity: 50 }], { asOf: day(1) });
    expect(on.lines[0].applied.schemeCode).toBe("FUT");
    const last = await evalFor(d, [{ productId: p.id, quantity: 50 }], { asOf: day(-1) });
    expect(last.lines[0].applied.schemeCode).toBe("EXP");
  });

  test("multiple schemes: lowest priority number wins, no stacking; equal priority = conflict, nothing applied", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create(buy10(p, { scheme_code: "SCH-A", priority: 20 }));
    await create({ name: "B", scheme_code: "SCH-B", scheme_type: "PERCENT_DISCOUNT", discount_percent: 10, product_ids: [p.id], valid_from: day(-1), priority: 10 });
    let l = (await evalFor(d, [{ productId: p.id, quantity: 10, unitPrice: 100 }])).lines[0];
    expect(l.eligibleSchemes).toHaveLength(2);
    expect(l.applied.schemeCode).toBe("SCH-B");
    expect(l.conflict).toBe(false);
    await create({ name: "C", scheme_code: "SCH-C", scheme_type: "PERCENT_DISCOUNT", discount_percent: 15, product_ids: [p.id], valid_from: day(-1), priority: 10 });
    l = (await evalFor(d, [{ productId: p.id, quantity: 10, unitPrice: 100 }])).lines[0];
    expect(l.applied).toBeNull();
    expect(l.conflict).toBe(true);
    expect(l.conflictSchemes.map((x) => x.schemeCode).sort()).toEqual(["SCH-B", "SCH-C"]);
  });

  test("category scheme, distributor-specific and retailer-specific applicability", async () => {
    const d1 = await seedDistributor(); const d2 = await seedDistributor();
    const p1 = await seedProduct(d1.id, { category: "Antibiotic" }); const p2 = await seedProduct(d2.id, { category: "Antibiotic" });
    const r1 = await seedCustomer(d1.id); const r1b = await seedCustomer(d1.id);
    await create({ name: "Cat", scheme_code: "CAT", scheme_type: "PERCENT_DISCOUNT", discount_percent: 5, product_scope: "CATEGORY", category: "Antibiotic", valid_from: day(-1) });
    expect((await evalFor(d1, [{ productId: p1.id, quantity: 1, unitPrice: 10 }])).lines[0].applied.schemeCode).toBe("CAT");
    expect((await evalFor(d2, [{ productId: p2.id, quantity: 1, unitPrice: 10 }])).lines[0].applied.schemeCode).toBe("CAT");
    await db.Scheme.destroy({ where: {} });
    await create(buy10(p1, { distributor_scope: "SPECIFIC", distributor_ids: [d1.id], retailer_scope: "SPECIFIC", retailer_ids: [r1.id] }));
    expect((await evalFor(d1, [{ productId: p1.id, quantity: 10 }], { customerId: r1.id })).lines[0].applied).toBeTruthy();
    expect((await evalFor(d1, [{ productId: p1.id, quantity: 10 }], { customerId: r1b.id })).lines[0].applied).toBeNull();
    expect((await evalFor(d1, [{ productId: p1.id, quantity: 10 }])).lines[0].applied).toBeNull(); // no retailer → not applicable
  });

  test("invalid product / other distributor's product / retailer / quantity", async () => {
    const d1 = await seedDistributor(); const d2 = await seedDistributor();
    const p1 = await seedProduct(d1.id); const p2 = await seedProduct(d2.id); const r2 = await seedCustomer(d2.id);
    await create(buy10(p1));
    const r = await evalFor(d1, [{ productId: 99999, quantity: 10 }, { productId: p2.id, quantity: 10 }, { productId: p1.id, quantity: 0 }, { productId: p1.id, quantity: 1.5 }]);
    expect(r.lines[0].errors[0].code).toBe("PRODUCT_NOT_FOUND");
    expect(r.lines[1].errors[0].code).toBe("PRODUCT_NOT_FOUND");
    expect(r.lines[2].errors[0].code).toBe("INVALID_QUANTITY");
    expect(r.lines[3].errors[0].code).toBe("INVALID_QUANTITY");
    expect((await callDist(distCtrl.evaluate, d1, { body: { customerId: r2.id, lines: [{ productId: p1.id, quantity: 10 }] } })).statusCode).toBe(400);
    expect((await callDist(distCtrl.evaluate, d1, { body: { lines: [] } })).statusCode).toBe(400);
    expect((await callDist(distCtrl.evaluate, d1, { body: { asOf: "nope", lines: [{ productId: p1.id, quantity: 1 }] } })).statusCode).toBe(400);
  });

  test("Admin evaluate needs an explicit valid distributor", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    await create(buy10(p));
    expect((await callAdmin(adminCtrl.evaluate, { body: { lines: [{ productId: p.id, quantity: 10 }] } })).statusCode).toBe(400);
    expect((await callAdmin(adminCtrl.evaluate, { body: { distributorId: d.id, lines: [{ productId: p.id, quantity: 10 }] } })).jsonBody.lines[0].applied.freeQuantity).toBe(1);
  });
});

describe("Distributor access & isolation", () => {
  test("sees only schemes that apply to its own products / itself; body distributor id ignored", async () => {
    const d1 = await seedDistributor(); const d2 = await seedDistributor();
    const p1 = await seedProduct(d1.id); const p2 = await seedProduct(d2.id);
    await create(buy10(p1, { scheme_code: "MINE" }));
    await create(buy10(p2, { scheme_code: "THEIRS" }));
    await create(buy10(p1, { scheme_code: "OTHERDIST", distributor_scope: "SPECIFIC", distributor_ids: [d1.id] }));
    await create(buy10(p2, { scheme_code: "ONLY2", distributor_scope: "SPECIFIC", distributor_ids: [d2.id] }));
    const codes = async (d, o) => (await callDist(distCtrl.applicable, d, o)).jsonBody.schemes.map((s) => s.code).sort();
    expect(await codes(d1)).toEqual(["MINE", "OTHERDIST"]);
    expect(await codes(d2)).toEqual(["ONLY2", "THEIRS"]);
    expect(await codes(d1, { query: { distributorId: d2.id }, body: { distributor_id: d2.id } })).toEqual(["MINE", "OTHERDIST"]);
    const r = await callDist(distCtrl.evaluate, d1, { body: { distributorId: d2.id, distributor_id: d2.id, lines: [{ productId: p2.id, quantity: 10 }] } });
    expect(r.jsonBody.distributorId).toBe(d1.id);
    expect(r.jsonBody.lines[0].errors[0].code).toBe("PRODUCT_NOT_FOUND");
    const view = (await callDist(distCtrl.applicable, d1)).jsonBody.schemes[0];
    expect(view.createdBy).toBeUndefined();
  });

  test("distributor controller exposes no write handlers; admin routes are guarded; distributor token rejected", async () => {
    expect(Object.keys(distCtrl).sort()).toEqual(["applicable", "evaluate"]);
    const layers = adminRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/schemes"));
    expect(layers.length).toBe(7);
    for (const l of layers) expect(l.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    const dist = allRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/schemes"));
    expect(dist.map((l) => Object.keys(l.route.methods)[0] + l.route.path).sort()).toEqual(["get/schemes/applicable", "post/schemes/evaluate"]);
    const res = mockRes();
    const next = jest.fn();
    await requireAdmin({ cookies: { distributor_token: "x" }, headers: { authorization: "Bearer x" } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect([401, 503]).toContain(res.statusCode);
  });

  test("no Retailer login / auth / portal introduced", async () => {
    const fs = require("fs"); const path = require("path");
    const routeSrc = fs.readFileSync(path.join(__dirname, "../routes/allRoutes.js"), "utf8") + fs.readFileSync(path.join(__dirname, "../routes/adminRoutes.js"), "utf8");
    expect(/retailer[^\n]*(login|auth\/|jwt)/i.test(routeSrc.replace(/authMiddleware/g, ""))).toBe(false);
    expect(db.Customer.rawAttributes.password).toBeUndefined();
  });
});

describe("Existing system intact", () => {
  test("Admin order preview still prices/taxes the same and only ADDS informational scheme data", async () => {
    const svc = require("../services/adminSalesOrder.service");
    const d = await seedDistributor(); const p = await seedProduct(d.id, { gst: 12, cgst: 6, sgst: 6 });
    const c = await seedCustomer(d.id);
    await db.PricingMaster.create({ productId: p.id, customer_group_id: c.customer_group_id, base_price: 100, discount_percent: 0, valid_from: new Date(Date.now() - 86400000), distributor_id: d.id });
    const input = { distributorId: d.id, customerId: c.id, paymentTerms: "Net 30", lines: [{ productId: p.id, quantity: 10 }] };
    const before = await svc.previewOrder(input);
    await create(buy10(p));
    const after = await svc.previewOrder(input);
    expect(after.totals).toEqual(before.totals);
    expect(after.lines[0].net).toBe(before.lines[0].net);
    expect(after.lines[0].scheme.applied.freeQuantity).toBe(1);
    expect(after.lines[0].scheme.applied.totalQuantity).toBe(11);
    expect(after.lines[0].quantity).toBe(10); // paid quantity untouched
  });

  test("scheme rows survive edits without touching other tables", async () => {
    const d = await seedDistributor(); const p = await seedProduct(d.id);
    const id = (await create(buy10(p))).jsonBody.id;
    const before = await db.Product.findByPk(p.id, { raw: true });
    await callAdmin(adminCtrl.update, { params: { id }, body: { free_quantity: 3 } });
    expect(await db.Product.findByPk(p.id, { raw: true })).toEqual(before);
    expect(await db.SchemeProduct.count({ where: { scheme_id: id } })).toBe(1);
  });
});
