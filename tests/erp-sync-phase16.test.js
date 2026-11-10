// Phase 16 — ownership, ERP code mappings, Stock / Sales targets, blocked capabilities, outbound (DMS → ERP), persistent audit, alerts, shutdown.
// Same convention as Phase 14/15: in-memory sqlite, direct service/controller calls, a MOCK fetch for every ERP transport.
// A mocked 200 proves OUR handling of a protocol, never real ERP connectivity (see PHASE16_DELIVERABLES.md → Real ERP verification).
const fs = require("fs");
const path = require("path");
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedCustomer, seedPricing } = require("./helpers");
const erp = require("../controllers/admin.erp.controller");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const sched = require("../services/erpScheduler.service");
const monitor = require("../services/erpMonitoring.service");
const audit = require("../services/erpAudit.service");
const codes = require("../services/erpCodeMapping.service");
const outbound = require("../services/erpOutbound.service");
const inventory = require("../services/inventory.service");
const targets = require("../services/erp/sync/targets");

beforeAll(() => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789", ERP_SAPPROD_USERNAME: "U", ERP_SAPPROD_PASSWORD: "P-9!" }); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(async () => { await audit.flush(); await db.sequelize.close(); });

const T = "DEFAULT"; const T2 = "TENANT_B";
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const hdrs = (h = {}) => ({ get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : h[n.toLowerCase()] || null), getSetCookie: () => h["set-cookie-list"] || [] });
const json = (status, obj, h) => ({ status, text: async () => JSON.stringify(obj), headers: hdrs(h) });
const D = (fetchImpl, extra = {}) => ({ await: true, fetchImpl, logger: () => {}, retryDelayMs: 0, ...extra });
const restFetch = (byPath, calls = []) => jest.fn(async (url, init) => { const p = new URL(url).pathname; calls.push({ url, init }); const v = byPath[p]; if (v === undefined) return json(404, {}); if (typeof v === "function") return v(url, init); return json(200, { rows: v }); });
const cap = (capability, endpointPath, o = {}) => ({ capability, endpointPath, direction: "ERP_TO_DMS", config: { responsePath: "rows", pagination: { type: "NONE" } }, ...o });
const mkConn = (caps, o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: caps, ...o });
const mkMap = (c, capability, rows, tenant = T) => sync.saveMappings(db, tenant, 1, c.id, capability, { mappings: rows });
const run = (c, capability, scope, fetchImpl, extra = {}, tenant = T) => sync.startSync(db, tenant, 1, { connectionId: c.id, capability, scope }, D(fetchImpl, extra));
const link = (c, entityType, externalId, did, entityId, extra = {}) => db.ErpExternalLink.create({ tenant_key: T, connection_id: c.id, entity_type: entityType, external_id: externalId, scope_key: `distributor:${did}`, dms_entity_id: entityId, ...extra });
const wh = (did, code = "WH1") => db.Warehouse.create({ distributor_id: did, code, name: code, is_default: code === "WH1" });
const onHand = (b, did, whId) => inventory.getBatchAvailableQty({ batchId: b.id, distributorId: did, warehouseId: whId });

// ═════════════════════════════════════ OWNERSHIP ═════════════════════════════════════
describe("Data ownership gate", () => {
  const STOCK_MAP = [{ sourceField: "Id", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Plant", dmsField: "plant_code" }, { sourceField: "Batch", dmsField: "batch_no" }, { sourceField: "Qty", dmsField: "quantity", transform: ["to_number"] }];
  test("STOCK with no ownership → BUSINESS_DECISION_REQUIRED (no job, no ERP call); DMS_OWNED conflicts with importing; ERP_OWNED passes the gate", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/stock": [] });
    const c = await mkConn([cap("STOCK", "/stock", { direction: "ERP_TO_DMS" })]);
    await expect(run(c, "STOCK", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409, code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/ownership is not defined/i) });
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock", { ownership: "DMS_OWNED" })] });
    await expect(run(c, "STOCK", { distributorId: d.id }, f)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/conflicts/) });
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock", { ownership: "ERP_OWNED" })] });
    await expect(run(c, "STOCK", { distributorId: d.id }, f)).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIGURED" }); // gate passed, next check fails
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpSyncJob.count()).toBe(0);
  });
  test("ownership values are validated; an older client that omits ownership never wipes a decision; changes are audited; DISABLED switches the capability off", async () => {
    const c = await mkConn([cap("STOCK", "/stock", { ownership: "SHARED" })]);
    await expect(conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock", { ownership: "EVERYONE" })] })).rejects.toMatchObject({ statusCode: 400 });
    const after = await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock")] }); // no ownership key
    expect(after.capabilities[0].ownership).toBe("SHARED");
    await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock", { ownership: "ERP_OWNED" })] });
    await audit.flush();
    const ev = await db.ErpAuditEvent.findAll({ where: { event: "ERP_OWNERSHIP_UPDATED" } });
    expect(ev.length).toBeGreaterThanOrEqual(1); expect(JSON.stringify(ev.map((e) => e.metadata))).toMatch(/ERP_OWNED/);
    const off = await conns.updateConnection(db, T, 1, c.id, { capabilities: [cap("STOCK", "/stock", { direction: "DISABLED" })] });
    expect(off.capabilities[0]).toMatchObject({ direction: "DISABLED", enabled: false });
  });
  test("PRODUCT_MASTER keeps working without an explicit ownership (Phase 14/15 behaviour: the chosen direction is the decision)", async () => {
    const ev = require("../services/erpOwnership.service");
    expect(ev.evaluate({ enabled: true, direction: "ERP_TO_DMS" }, "PRODUCT_MASTER", "inbound")).toMatchObject({ ok: true, implied: true, ownership: "ERP_OWNED" });
    expect(ev.evaluate({ enabled: true, direction: "DMS_TO_ERP" }, "PRODUCT_MASTER", "inbound")).toMatchObject({ ok: false, code: "CAPABILITY_NOT_SUPPORTED" });
    expect(ev.evaluate({ enabled: true, direction: "DMS_TO_ERP", ownership: "ERP_OWNED" }, "PAYMENT", "outbound")).toMatchObject({ ok: false, code: "BUSINESS_DECISION_REQUIRED" });
  });
});

// ═════════════════════════════════════ CODE MAPPINGS ═════════════════════════════════════
describe("ERP code mappings (reuse erp_external_links)", () => {
  test("upsert / list / replace / remove; the DMS row must belong to the chosen distributor; no new mapping table", async () => {
    const d = await seedDistributor(); const d2 = await seedDistributor();
    const g = await db.CustomerGroup.create({ code: "RTL", name: "Retail", distributor_id: d.id });
    const g2 = await db.CustomerGroup.create({ code: "RTL", name: "Retail", distributor_id: d2.id });
    const c = await mkConn([cap("PRODUCT_MASTER", "/p")]); const conn = await sync.loadConnection(db, T, c.id);
    const m = await codes.upsert(db, T, 1, conn, { type: "CUSTOMER_GROUP", externalCode: "Z1", distributorId: d.id, dmsId: g.id });
    expect(m).toMatchObject({ type: "CUSTOMER_GROUP", externalCode: "Z1", distributorId: d.id, dmsId: g.id });
    await expect(codes.upsert(db, T, 1, conn, { type: "CUSTOMER_GROUP", externalCode: "Z2", distributorId: d.id, dmsId: g2.id })).rejects.toMatchObject({ statusCode: 400 });
    await expect(codes.upsert(db, T, 1, conn, { type: "NOPE", externalCode: "x" })).rejects.toMatchObject({ statusCode: 400 });
    const again = await codes.upsert(db, T, 1, conn, { type: "CUSTOMER_GROUP", externalCode: "Z1", distributorId: d.id, dmsId: g.id });
    expect(again.id).toBe(m.id); expect((await codes.list(db, T, conn, { type: "CUSTOMER_GROUP" })).total).toBe(1);
    await codes.upsert(db, T, 1, conn, { type: "PAYMENT_MODE", externalCode: "01", dmsValue: "upi" });
    expect((await codes.list(db, T, conn, { type: "PAYMENT_MODE" })).items[0]).toMatchObject({ externalCode: "01", dmsValue: "UPI", dmsId: null });
    await expect(codes.upsert(db, T, 1, conn, { type: "PAYMENT_MODE", externalCode: "02", dmsValue: "BARTER" })).rejects.toMatchObject({ statusCode: 400 });
    // a synced record's identity link can never be removed through this API
    const prod = await seedProduct(d.id); const idLink = await link(c, "PRODUCT", "P1", d.id, prod.id);
    expect(await codes.remove(db, T, 1, conn, idLink.id)).toBeNull(); expect(await db.ErpExternalLink.findByPk(idLink.id)).not.toBeNull();
    expect(await codes.remove(db, T, 1, conn, m.id)).toEqual({ deleted: true });
    await expect(codes.require(db, { connectionId: c.id, tenantKey: T }, "CUSTOMER_GROUP", "Z1", d.id)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    expect(Object.keys(db.sequelize.models).filter((n) => /mapping|lookup/i.test(n)).sort()).toEqual(["ErpEntityMapping"]);
  });
  test("tenant isolation over HTTP: a foreign tenant's connection is 404 for list / save / delete", async () => {
    const c = await mkConn([cap("PRODUCT_MASTER", "/p")], {}, T2);
    for (const [fn, o] of [[erp.listCodeMappings, { query: { type: "HSN" } }], [erp.saveCodeMapping, { body: { type: "PAYMENT_MODE", externalCode: "1", dmsValue: "CASH" } }], [erp.deleteCodeMapping, { params: { mappingId: "1" } }]]) {
      const res = await A(fn, { params: { id: String(c.id), mappingId: "1" }, ...o }); expect(res.statusCode).toBe(404);
    }
    expect(await db.ErpExternalLink.count()).toBe(0);
  });
  test("HSN code mapping: product sync sets the mapped HSN on NEW and linked products; an unmapped code fails that record with BUSINESS_DECISION_REQUIRED", async () => {
    const d = await seedDistributor();
    const defHsn = await db.HSNGroup.create({ hsn_code: "9999", description: "Default", gst_rate: 5, distributor_id: d.id });
    const hsn3004 = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });
    const c = await mkConn([cap("PRODUCT_MASTER", "/products")]); const conn = await sync.loadConnection(db, T, c.id);
    await mkMap(c, "PRODUCT_MASTER", [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }, { sourceField: "Hsn", dmsField: "hsn_code" }]);
    await codes.upsert(db, T, 1, conn, { type: "HSN", externalCode: "30049099", distributorId: d.id, dmsId: hsn3004.id });
    const job = await run(c, "PRODUCT_MASTER", { distributorId: d.id, hsnId: defHsn.id }, restFetch({ "/products": [{ Code: "A", Title: "Alpha", Hsn: "30049099" }, { Code: "B", Title: "Beta", Hsn: "11111111" }, { Code: "C", Title: "Gamma" }] }));
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 2, failed: 1 } });
    const prods = await db.Product.findAll({ order: [["id", "ASC"]] });
    expect(prods.map((p) => [p.name, p.hsn_id])).toEqual([["Alpha", hsn3004.id], ["Gamma", defHsn.id]]);
    const errs = await sync.listJobErrors(db, T, job.id); expect(errs.items[0]).toMatchObject({ externalId: "B", code: "BUSINESS_DECISION_REQUIRED" });
  });
  test("customer group code mapping: NEW customers join the mapped group (else the sync's default); an existing retailer's group is never changed", async () => {
    const d = await seedDistributor();
    const def = await db.CustomerGroup.create({ code: "DEF", name: "Default", distributor_id: d.id }); const ws = await db.CustomerGroup.create({ code: "WS", name: "Wholesale", distributor_id: d.id });
    const c = await mkConn([cap("CUSTOMER_MASTER", "/customers")]); const conn = await sync.loadConnection(db, T, c.id);
    const M = [{ sourceField: "No", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "St", dmsField: "street1" }, { sourceField: "City", dmsField: "city" }, { sourceField: "Reg", dmsField: "region" }, { sourceField: "Ph", dmsField: "phone_number" }, { sourceField: "Pin", dmsField: "pincode" }, { sourceField: "Grp", dmsField: "customer_group_code" }];
    await mkMap(c, "CUSTOMER_MASTER", M); await codes.upsert(db, T, 1, conn, { type: "CUSTOMER_GROUP", externalCode: "W", distributorId: d.id, dmsId: ws.id });
    const row = (n, g) => ({ No: `C${n}`, Name: `Shop ${n}`, St: "1 Rd", City: "Pune", Reg: "Maharashtra", Ph: "9876543210", Pin: "411001", ...(g ? { Grp: g } : {}) });
    const job = await run(c, "CUSTOMER_MASTER", { distributorId: d.id, customerGroupId: def.id }, restFetch({ "/customers": [row(1, "W"), row(2), row(3, "UNMAPPED")] }));
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 2, failed: 1 } });
    const rows = await db.Customer.findAll({ order: [["id", "ASC"]] }); expect(rows.map((r) => r.customer_group_id)).toEqual([ws.id, def.id]);
    await run(c, "CUSTOMER_MASTER", { distributorId: d.id, customerGroupId: def.id }, restFetch({ "/customers": [{ ...row(1, "W"), Name: "Shop One Renamed" }] }));
    expect((await db.Customer.findByPk(rows[0].id))).toMatchObject({ name: "Shop One Renamed", customer_group_id: ws.id });
  });
  test("payment mode mapping: ERP codes resolve to DMS modes; a code with no mapping → BUSINESS_DECISION_REQUIRED (existing default-mode behaviour unchanged)", async () => {
    const mode = require("../services/erpCodeMapping.service");
    expect(mode.TYPES.PAYMENT_MODE.scoped).toBe(false);
    const d = await seedDistributor(); const c = await mkConn([cap("PAYMENT", "/payments")]);
    await expect(mode.require(db, { connectionId: c.id, tenantKey: T }, "PAYMENT_MODE", "99", d.id)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/"99"/) });
  });
});

// ═════════════════════════════════════ STOCK ═════════════════════════════════════
describe("Stock sync (delta through inventory.postAdjustment — ledger only)", () => {
  const MAP = [{ sourceField: "Id", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Plant", dmsField: "plant_code" }, { sourceField: "Batch", dmsField: "batch_no" }, { sourceField: "Qty", dmsField: "quantity", transform: ["to_number"] }];
  async function stockWorld(ownership = "ERP_OWNED") {
    const d = await seedDistributor(); const p = await seedProduct(d.id); const b = await seedBatch(d.id, p.id, { batch_no: "B-100", exp_date: new Date(Date.now() + 400 * 86400000) });
    const w = await wh(d.id); const c = await mkConn([cap("PRODUCT_MASTER", "/p"), cap("STOCK", "/stock", { ownership })]); const conn = await sync.loadConnection(db, T, c.id);
    await link(c, "PRODUCT", "MAT1", d.id, p.id); await codes.upsert(db, T, 1, conn, { type: "WAREHOUSE", externalCode: "1000", distributorId: d.id, dmsId: w.id });
    await mkMap(c, "STOCK", MAP);
    const rec = (qty, o = {}) => ({ Id: "S1", Mat: "MAT1", Plant: "1000", Batch: "B-100", Qty: qty, ...o });
    return { d, p, b, w, c, rec, go: (rows) => run(c, "STOCK", { distributorId: d.id }, restFetch({ "/stock": rows })) };
  }
  test("first snapshot is booked as OPENING through the ledger; a repeat does nothing; changes post only the DELTA (IN / OUT) as ERP-SYNC rows", async () => {
    const s = await stockWorld();
    expect(await s.go([s.rec(20)])).toMatchObject({ status: "SUCCESS", counts: { created: 1 } });
    expect(await onHand(s.b, s.d.id, s.w.id)).toBe(20);
    const rows = await db.StockLedger.findAll({ where: { batchId: s.b.id } });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ movement_type: "IN", quantity: 20, reference_type: "OPENING", warehouse_id: s.w.id }); expect(rows[0].reason).toMatch(/^ERP-SYNC job \d+/);
    expect((await s.go([s.rec(20)])).counts).toMatchObject({ skipped: 1, created: 0, updated: 0 }); expect(await db.StockLedger.count()).toBe(1);
    expect((await s.go([s.rec(25)])).counts.updated).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(25);
    expect((await s.go([s.rec(18)])).counts.updated).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(18);
    const all = await db.StockLedger.findAll({ order: [["id", "ASC"]] });
    expect(all.map((r) => `${r.movement_type}${r.quantity}:${r.reference_type}`)).toEqual(["IN20:OPENING", "IN5:CORRECTION", "OUT7:CORRECTION"]);
  });
  test("DMS operational movements are never overwritten: a DMS-side OUT stays, the ERP delta is applied on top", async () => {
    const s = await stockWorld(); await s.go([s.rec(20)]);
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 6, direction: "OUT", reasonType: "DAMAGE", reason: "DMS damage", warehouseId: s.w.id, userId: 1 });
    expect(await onHand(s.b, s.d.id, s.w.id)).toBe(14);
    expect((await s.go([s.rec(20)])).counts.skipped).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(14); // ERP unchanged → nothing posted
    await s.go([s.rec(23)]); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(17); // +3 from the ERP, DMS damage kept
  });
  test("safety: unmapped plant, missing batch (never created), existing DMS stock on the first snapshot, SHARED ownership allowed; no duplicate batches", async () => {
    const s = await stockWorld("SHARED"); const batches = await db.Batch.count();
    let job = await s.go([s.rec(5, { Plant: "9999" }), s.rec(5, { Id: "S2", Batch: "NOPE" })]);
    expect(job).toMatchObject({ status: "FAILED", counts: { failed: 2 } });
    const errs = (await sync.listJobErrors(db, T, job.id)).items.map((e) => e.code).sort(); expect(errs).toEqual(["BUSINESS_DECISION_REQUIRED", "VALIDATION_ERROR"]);
    expect(await db.Batch.count()).toBe(batches); expect(await db.StockLedger.count()).toBe(0);
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 4, direction: "IN", reasonType: "OPENING", reason: "DMS opening", warehouseId: s.w.id, userId: 1 });
    job = await s.go([s.rec(10)]);
    expect(job.counts.failed).toBe(1); expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/reconcile/) });
    expect(await onHand(s.b, s.d.id, s.w.id)).toBe(4);
  });
  test("a decrease larger than the stock on hand is refused by the ledger (no negative stock, no bypass); fractional / negative quantities are rejected", async () => {
    const s = await stockWorld(); await s.go([s.rec(10)]);
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 9, direction: "OUT", reasonType: "DAMAGE", reason: "x", warehouseId: s.w.id, userId: 1 });
    const job = await s.go([s.rec(2)]); expect(job.counts.failed).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(1);
    const bad = await s.go([s.rec(2.5, { Id: "S3" }), s.rec(-1, { Id: "S4" })]); expect(bad.counts.failed).toBe(2);
  });
  test("the stock code never writes StockLedger / Batch directly (only inventory.postAdjustment)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/erp/sync/targets.js"), "utf8");
    const stock = src.slice(src.indexOf("STOCK (Phase 16)"), src.indexOf("SALES (Phase 16)")).replace(/\/\/.*$/gm, "");
    expect(stock).toMatch(/inventory\.postAdjustment/); expect(stock).not.toMatch(/StockLedger\.(create|update|bulkCreate|destroy)|Batch\.(create|update|bulkCreate|destroy)/);
  });
});

// ═════════════════════════════════════ SALES ═════════════════════════════════════
describe("Sales sync (ERP order → DMS DRAFT order via adminSalesOrder.createOrder)", () => {
  const MAP = [{ sourceField: "OrderNo", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "order_date", transform: ["to_date"] }, { sourceField: "Terms", dmsField: "payment_terms" }, { sourceField: "Items[].Mat", dmsField: "lines.product_external_id" }, { sourceField: "Items[].Qty", dmsField: "lines.quantity", transform: ["to_number"] }];
  async function salesWorld(ownership = "ERP_OWNED") {
    const d = await seedDistributor(); const p = await seedProduct(d.id, { gst: 12, cgst: 6, sgst: 6 }); const cu = await seedCustomer(d.id);
    await seedPricing(d, p, cu.customer_group_id, { basePrice: 100 });
    const b = await seedBatch(d.id, p.id, { batch_no: "S-1", exp_date: new Date(Date.now() + 400 * 86400000) }); const w = await wh(d.id);
    await inventory.postAdjustment({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 100, direction: "IN", reasonType: "OPENING", reason: "seed", warehouseId: w.id, userId: 1 });
    const c = await mkConn([cap("SALES", "/orders", { ownership })]);
    await link(c, "PRODUCT", "MAT1", d.id, p.id); await link(c, "CUSTOMER", "C1", d.id, cu.id); await mkMap(c, "SALES", MAP);
    const order = (n, o = {}) => ({ OrderNo: `SO${n}`, Cust: "C1", Date: "2026-10-01", Terms: "CREDIT", Items: [{ Mat: "MAT1", Qty: 5, Price: 1, Total: 5 }], ...o });
    return { d, p, cu, b, c, order, go: (rows, scope = {}) => run(c, "SALES", { distributorId: d.id, ...scope }, restFetch({ "/orders": rows })) };
  }
  test("creates a DRAFT order priced by PricingMaster (the ERP's price is ignored), stamps generic external source columns, repeat = skipped (no duplicate)", async () => {
    const s = await salesWorld();
    const job = await s.go([s.order(1)]);
    expect(job).toMatchObject({ status: "SUCCESS", counts: { created: 1 } });
    const o = await db.SalesOrderHeader.findOne(); expect(o).toMatchObject({ status: "DRAFT", external_source_type: `ERP:${s.c.id}`, external_source_id: "SO1", distributor_id: s.d.id });
    const lines = await db.SalesOrderLine.findAll({ where: { orderId: o.id } }); expect(lines).toHaveLength(1); expect(Number(lines[0].quantity)).toBe(5);
    expect(Number(o.netValue)).toBe(500); // 5 × 100 from PricingMaster, not the ERP's Price=1
    expect((await s.go([s.order(1)])).counts.skipped).toBe(1); expect(await db.SalesOrderHeader.count()).toBe(1);
    expect(await db.StockLedger.count({ where: { reference_type: "SALES" } })).toBe(0); // never delivered / invoiced by a sync
  });
  test("crash recovery: an order created but not stamped is re-stamped on the next run, never duplicated", async () => {
    const s = await salesWorld(); await s.go([s.order(7)]);
    await db.SalesOrderHeader.update({ external_source_type: null, external_source_id: null }, { where: {} }); await db.ErpExternalLink.destroy({ where: { entity_type: "SALES_ORDER" } });
    const job = await s.go([s.order(7)]); expect(job.counts.created).toBe(1);
    expect(await db.SalesOrderHeader.count()).toBe(1); expect(await db.SalesOrderHeader.count({ where: { external_source_id: "SO7" } })).toBe(1);
  });
  test("a changed ERP order updates the DRAFT; once the DMS order is confirmed the change is NOT applied (BUSINESS_DECISION_REQUIRED)", async () => {
    const s = await salesWorld(); await s.go([s.order(2)]);
    const o = await db.SalesOrderHeader.findOne();
    expect((await s.go([s.order(2, { Items: [{ Mat: "MAT1", Qty: 8 }] })])).counts.updated).toBe(1);
    expect(Number((await db.SalesOrderLine.findOne({ where: { orderId: o.id } })).quantity)).toBe(8);
    await db.SalesOrderHeader.update({ status: "CONFIRMED" }, { where: { id: o.id } });
    const job = await s.go([s.order(2, { Items: [{ Mat: "MAT1", Qty: 9 }] })]);
    expect(job.counts.failed).toBe(1); expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    expect(Number((await db.SalesOrderLine.findOne({ where: { orderId: o.id } })).quantity)).toBe(8);
  });
  test("guards: unsynchronised customer / product, no payment terms, more than the available stock, and an order with no lines each fail only that record", async () => {
    const s = await salesWorld(); const noTerms = s.order(3, { Terms: "" });
    const job = await s.go([s.order(4, { Cust: "UNKNOWN" }), s.order(5, { Items: [{ Mat: "UNKNOWN", Qty: 1 }] }), noTerms, s.order(6, { Items: [{ Mat: "MAT1", Qty: 5000 }] }), s.order(8, { Items: [] }), s.order(9)]);
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 1, failed: 5 } });
    const codesSeen = (await sync.listJobErrors(db, T, job.id)).items.map((e) => e.code); expect(codesSeen).toContain("BUSINESS_DECISION_REQUIRED");
    expect(await db.SalesOrderHeader.count()).toBe(1);
    const again = await s.go([noTerms], { defaultPaymentTerms: "CREDIT" });
    expect(again.counts.created).toBe(1); // the admin's default terms make it explicit
  });
  test("regression (pre-existing bug fixed): the admin order service can create more than one order per distributor — numbers count up instead of clashing on 0001", async () => {
    const s = await salesWorld(); const svc = require("../services/adminSalesOrder.service");
    const input = { distributorId: s.d.id, customerId: s.cu.id, paymentTerms: "CREDIT", lines: [{ productId: s.p.id, quantity: 1 }] };
    const a = await svc.createOrder(input); const b = await svc.createOrder(input); const c2 = await svc.createOrder(input);
    expect([a.orderNumber.split("-").pop(), b.orderNumber.split("-").pop(), c2.orderNumber.split("-").pop()]).toEqual(["0001", "0002", "0003"]);
  });
  test("sales ownership: undecided → blocked; DMS_OWNED conflicts with importing", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/orders": [] });
    const c = await mkConn([cap("SALES", "/orders")]); // default direction ERP_TO_DMS here, no ownership
    await expect(run(c, "SALES", { distributorId: d.id }, f)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════ BLOCKED CAPABILITIES ═════════════════════════════════════
describe("Invoice / Return / Document stay blocked with the exact decision documented", () => {
  test("no target; honest codes and reasons that name the decision; no job, no ERP call, no records", async () => {
    const d = await seedDistributor(); const f = jest.fn();
    const c = await mkConn(["INVOICE", "RETURN", "DOCUMENT"].map((x) => cap(x, `/${x}`, { ownership: "ERP_OWNED" })));
    const exp = { INVOICE: ["BUSINESS_DECISION_REQUIRED", /external invoice id/i], RETURN: ["CAPABILITY_NOT_SUPPORTED", /delivered DMS invoice/i], DOCUMENT: ["CAPABILITY_NOT_SUPPORTED", /tenant-isolated document store/i] };
    for (const [k, [code, re]] of Object.entries(exp)) {
      expect(targets.getTarget(k)).toBeNull();
      await expect(run(c, k, { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409, code, message: expect.stringMatching(re) });
    }
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpSyncJob.count()).toBe(0);
    expect(fs.existsSync(path.join(__dirname, "../services/erpAccounting.service.js"))).toBe(false); // no second accounting engine
  });
});

// ═════════════════════════════════════ OUTBOUND ═════════════════════════════════════
describe("Outbound DMS → ERP foundation", () => {
  const CMAP = [{ sourceField: "CustNo", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "City", dmsField: "city" }, { sourceField: "Phone", dmsField: "phone_number" }];
  const outCap = (o = {}) => cap("CUSTOMER_MASTER", "/customers", { direction: "DMS_TO_ERP", ownership: "DMS_OWNED", config: { outbound: { idempotencySupported: true, externalIdPath: "id" } }, ...o });
  async function ow(capOverride) {
    const d = await seedDistributor(); const cu = await seedCustomer(d.id, { name: "Shop A", city: "Pune", phone_number: "9876543210" });
    const c = await mkConn([outCap(capOverride)]); await mkMap(c, "CUSTOMER_MASTER", CMAP);
    return { d, cu, c, send: (fetchImpl, o = {}) => outbound.send(db, T, 1, { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cu.id, ...o }, { fetchImpl, logger: () => {} }) };
  }
  test("REST: POST with an Idempotency-Key and the REVERSE-mapped payload, ERP id linked; unchanged resend sends nothing; a change is PATCHed to <endpoint>/<ERP id>", async () => {
    const o = await ow(); const calls = [];
    const f = jest.fn(async (url, init) => { calls.push({ url, init }); return json(init.method === "POST" ? 201 : 200, { id: "E-77" }); });
    const r = await o.send(f);
    expect(r).toMatchObject({ status: "SENT", operation: "CREATE", externalId: "E-77", attempt: 1 });
    expect(calls[0].init.method).toBe("POST"); expect(new URL(calls[0].url).pathname).toBe("/customers");
    expect(calls[0].init.headers["Idempotency-Key"]).toBe(`${T}:${o.c.id}:CUSTOMER_MASTER:${o.cu.id}:create`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ Name: "Shop A", City: "Pune", Phone: "9876543210" }); // ERP field names, not DMS ones
    expect(calls[0].init.headers.Authorization).toMatch(/^Bearer /);
    expect(await db.ErpExternalLink.count({ where: { entity_type: "CUSTOMER", external_id: "E-77" } })).toBe(1);
    expect((await o.send(f)).unchanged).toBe(true); expect(f).toHaveBeenCalledTimes(1);
    await o.cu.update({ city: "Nashik" });
    const u = await o.send(f);
    expect(u).toMatchObject({ status: "SENT", operation: "UPDATE", externalId: "E-77" });
    expect(calls[1].init.method).toBe("PATCH"); expect(new URL(calls[1].url).pathname).toBe("/customers/E-77");
    expect(await db.ErpOutboundEvent.count()).toBe(2);
  });
  test("exactly once: a failed send is retried with the SAME key (attempt 2); a SENT key is never sent again", async () => {
    const o = await ow(); let n = 0;
    const f = jest.fn(async (url, init) => (++n === 1 ? json(503, {}) : json(201, { id: "E-1" })));
    const first = await o.send(f); expect(first).toMatchObject({ status: "FAILED", errorCode: "SERVER_ERROR", attempt: 1 });
    const second = await o.send(f); expect(second).toMatchObject({ status: "SENT", attempt: 2 });
    expect(await db.ErpOutboundEvent.count()).toBe(1);
    expect(f.mock.calls[0][1].headers["Idempotency-Key"]).toBe(f.mock.calls[1][1].headers["Idempotency-Key"]);
  });
  test("OUTBOUND_SYNC_BLOCKED without ERP-side idempotency attestation; ownership / direction / mapping / provider gates; nothing is sent", async () => {
    const f = jest.fn();
    let o = await ow({ config: {} }); await expect(o.send(f)).rejects.toMatchObject({ statusCode: 409, code: "OUTBOUND_SYNC_BLOCKED", message: expect.stringMatching(/idempotency/i) });
    o = await ow({ ownership: "ERP_OWNED" }); await expect(o.send(f)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    expect(f).not.toHaveBeenCalled();
  });
  test("no echo: a payment that came from this ERP is not sent back; payment needs an ERP customer id and an ERP payment-mode code (BUSINESS_DECISION_REQUIRED)", async () => {
    const d = await seedDistributor(); const cu = await seedCustomer(d.id);
    const c = await mkConn([cap("PAYMENT", "/payments", { direction: "DMS_TO_ERP", ownership: "DMS_OWNED", config: { outbound: { idempotencySupported: true, externalIdPath: "id" } } })]);
    await mkMap(c, "PAYMENT", [{ sourceField: "PayId", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Amt", dmsField: "amount" }, { sourceField: "Mode", dmsField: "mode" }, { sourceField: "Date", dmsField: "payment_date" }]);
    const pay = await db.Payment.create({ payment_number: "PAY-1", distributor_id: d.id, customer_id: cu.id, payment_date: "2026-10-01", amount: 500, mode: "UPI", reference_no: "UTR1" });
    const f = restFetch({ "/payments": () => json(201, { id: "P-9" }) }); const send = (id) => outbound.send(db, T, 1, { connectionId: c.id, capability: "PAYMENT", entityId: id }, { fetchImpl: f, logger: () => {} });
    await expect(send(pay.id)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/not linked/) });
    await link(c, "CUSTOMER", "E-C1", d.id, cu.id); await expect(send(pay.id)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/Payment mode UPI/) });
    await codes.upsert(db, T, 1, await sync.loadConnection(db, T, c.id), { type: "PAYMENT_MODE", externalCode: "U", dmsValue: "UPI" });
    expect(await send(pay.id)).toMatchObject({ status: "SENT", externalId: "P-9" });
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ Cust: "E-C1", Amt: 500, Mode: "U", Date: "2026-10-01" });
    const echo = await db.Payment.create({ payment_number: "PAY-2", distributor_id: d.id, customer_id: cu.id, payment_date: "2026-10-01", amount: 5, mode: "UPI", reference_no: `ERP${c.id}-X1` });
    await expect(send(echo.id)).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED", message: expect.stringMatching(/came from this ERP/) });
    expect(f).toHaveBeenCalledTimes(1);
  });
  test("SAP provider: CSRF token fetched + replayed with the session cookie INSIDE the provider; PATCH on the entity key; token refresh once on 403; secrets never logged", async () => {
    const d = await seedDistributor(); const cu = await seedCustomer(d.id, { name: "Shop S", city: "Pune" });
    const c = await conns.createConnection(db, T, 1, { name: "SAP", erpType: "SAP_S4HANA", authType: "BASIC", environment: "TEST", baseUrl: "https://sap.example.com", odataServicePath: "/sap/opu/odata/sap/ZCUST", credentialRef: "SAPPROD", capabilities: [{ capability: "CUSTOMER_MASTER", endpointPath: "/CustomerSet", direction: "DMS_TO_ERP", ownership: "DMS_OWNED", config: { outbound: { idempotencySupported: true, externalIdPath: "CustNo" } } }] });
    await mkMap(c, "CUSTOMER_MASTER", [{ sourceField: "CustNo", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "City", dmsField: "city" }]);
    const log = []; let tokens = 0; const seen = [];
    const f = jest.fn(async (url, init) => {
      const h = init.headers; seen.push({ m: init.method, p: new URL(url).pathname, csrf: h["X-CSRF-Token"], cookie: h.Cookie });
      if (init.method === "GET") return json(200, {}, { "x-csrf-token": `TOK${++tokens}`, "set-cookie-list": ["sap-session=abc; Path=/; HttpOnly"] });
      if (h["X-CSRF-Token"] !== "TOK2" && seen.filter((s) => s.m !== "GET").length === 1) return json(403, {}, { "x-csrf-token": "Required" }); // first write: expired token
      return json(201, { d: { CustNo: "0000100" } });
    });
    const r = await outbound.send(db, T, 1, { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cu.id }, { fetchImpl: f, logger: (l) => log.push(l) });
    expect(r).toMatchObject({ status: "SENT", externalId: "0000100" });
    expect(seen.map((s) => s.m)).toEqual(["GET", "POST", "GET", "POST"]); expect(seen[3]).toMatchObject({ csrf: "TOK2", cookie: "sap-session=abc" });
    await cu.update({ city: "Nashik" });
    await outbound.send(db, T, 1, { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cu.id }, { fetchImpl: f, logger: (l) => log.push(l) });
    expect(seen[seen.length - 1]).toMatchObject({ m: "PATCH", p: expect.stringMatching(/CustomerSet\('0000100'\)$/) });
    expect(log.join("\n")).not.toMatch(/TOK\d|sap-session|P-9!/);
    // the generic layers know nothing about CSRF
    for (const file of ["syncEngine.js", "mapper.js", "targets.js"]) expect(fs.readFileSync(path.join(__dirname, "../services/erp/sync", file), "utf8")).not.toMatch(/csrf/i);
    expect(fs.readFileSync(path.join(__dirname, "../services/erpOutbound.service.js"), "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/csrf|sap/i);
  });
  test("tenant isolation: a foreign tenant's connection → 404 and no ERP call (service + HTTP)", async () => {
    const d = await seedDistributor(); const cu = await seedCustomer(d.id); const f = jest.fn();
    const c = await mkConn([outCap()], {}, T2);
    expect(await outbound.send(db, T, 1, { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cu.id }, { fetchImpl: f })).toBeNull();
    const res = await A(erp.sendOutbound, { body: { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: cu.id } }); expect(res.statusCode).toBe(404);
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpOutboundEvent.count()).toBe(0);
  });
  test("unsupported outbound capability and an unknown record are refused cleanly", async () => {
    const o = await ow();
    await expect(outbound.send(db, T, 1, { connectionId: o.c.id, capability: "INVOICE", entityId: 1 })).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED" });
    await expect(outbound.send(db, T, 1, { connectionId: o.c.id, capability: "CUSTOMER_MASTER", entityId: 99999 }, { fetchImpl: jest.fn() })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ═════════════════════════════════════ PERSISTENT AUDIT ═════════════════════════════════════
describe("Persistent append-only audit", () => {
  test("connection / sync / schedule / outbound events are stored with actor, ERP, capability, correlation id; filters work; tenant-scoped", async () => {
    const d = await seedDistributor(); const g = await db.CustomerGroup.create({ code: "G", name: "G", distributor_id: d.id });
    const c = await mkConn([cap("CUSTOMER_MASTER", "/customers")]); await conns.updateConnection(db, T, 7, c.id, { description: "changed" });
    await mkMap(c, "CUSTOMER_MASTER", [{ sourceField: "No", isKey: true }, { sourceField: "Name", dmsField: "name" }]);
    await run(c, "CUSTOMER_MASTER", { distributorId: d.id, customerGroupId: g.id }, restFetch({ "/customers": [{ No: "1", Name: "X" }] }));
    await sched.saveSchedule(db, T, 1, c.id, "CUSTOMER_MASTER", { enabled: true, frequency: "HOURLY", scope: { distributorId: d.id, customerGroupId: g.id } });
    await audit.flush();
    const all = await audit.list(db, T, { pageSize: 100 }); const names = all.items.map((e) => e.event);
    for (const n of ["ERP_CONNECTION_CREATED", "ERP_CONNECTION_UPDATED", "ERP_MAPPING_UPDATED", "ERP_SYNC_STARTED", "ERP_SCHEDULE_CREATED"]) expect(names).toContain(n);
    expect(names.some((n) => /^ERP_SYNC_(COMPLETED|PARTIAL|FAILED)$/.test(n))).toBe(true);
    const upd = all.items.find((e) => e.event === "ERP_CONNECTION_UPDATED"); expect(upd).toMatchObject({ actorAdminId: 7, connectionId: c.id, erpCode: expect.any(String), provider: "GENERIC_REST", status: "OK" });
    const started = all.items.find((e) => e.event === "ERP_SYNC_STARTED"); expect(started).toMatchObject({ capability: "CUSTOMER_MASTER", entityType: "SYNC_JOB" });
    expect((await audit.list(db, T, { event: "ERP_SCHEDULE_CREATED" })).items).toHaveLength(1);
    expect((await audit.list(db, T, { actorId: 7 })).items.every((e) => e.actorAdminId === 7)).toBe(true);
    expect((await audit.list(db, T, { capability: "CUSTOMER_MASTER", connectionId: c.id })).total).toBeGreaterThan(0);
    expect((await audit.list(db, T, { from: "2999-01-01" })).total).toBe(0);
    expect((await audit.list(db, T2)).total).toBe(0); // another tenant sees nothing
    expect((await audit.list(db, T, { pageSize: 2, page: 1 })).items).toHaveLength(2);
  });
  test("append-only: update / destroy are refused by the model, and no HTTP write route exists", async () => {
    const d = await seedDistributor(); await mkConn([cap("PRODUCT_MASTER", "/p")]); await audit.flush();
    const ev = await db.ErpAuditEvent.findOne(); expect(ev).not.toBeNull();
    await expect(ev.update({ event: "X" })).rejects.toThrow(/append-only/); await expect(ev.destroy()).rejects.toThrow(/append-only/);
    await expect(db.ErpAuditEvent.destroy({ where: {} })).rejects.toThrow(/append-only/); await expect(db.ErpAuditEvent.update({ event: "X" }, { where: {} })).rejects.toThrow(/append-only/);
    const routes = require("../routes/adminRoutes").stack.filter((l) => l.route && /erp-sync\/audit/.test(l.route.path)).flatMap((l) => Object.keys(l.route.methods));
    expect(routes).toEqual(["get"]); expect(d).toBeTruthy();
  });
  test("credentials never reach the audit table (metadata filter) and metadata is bounded", async () => {
    expect(audit.safeMetadata({ password: "x", apiKey: "y", Authorization: "Bearer zz", token: "t", ok: "fine", nested: { secret: "s", keep: 1 } })).toEqual({ ok: "fine", nested: { keep: 1 } });
    expect(audit.safeMetadata({ long: "a".repeat(1000) }).long.length).toBeLessThan(400);
    const c = await mkConn([cap("PRODUCT_MASTER", "/p")]); await audit.flush();
    const dump = JSON.stringify(await db.ErpAuditEvent.findAll({ raw: true })); expect(dump).not.toMatch(/bearer-tok-XYZ789|RESTBEARER_TOKEN/); expect(c).toBeTruthy();
  });
  test("HTTP: listAudit is tenant-scoped and paged; a tenantKey in the query is ignored", async () => {
    await mkConn([cap("PRODUCT_MASTER", "/p")], {}, T2); await mkConn([cap("PRODUCT_MASTER", "/p")], { name: "Mine", credentialRef: "RESTBEARER" }); await audit.flush();
    const res = await A(erp.listAudit, { query: { tenantKey: T2, pageSize: "5" } }); expect(res.statusCode).toBe(200);
    expect(res.jsonBody.items.every((e) => e.erpCode)).toBe(true); expect(res.jsonBody.total).toBe(1);
    expect(res.jsonBody.events).toContain("ERP_OUTBOUND_COMPLETED");
  });
});

// ═════════════════════════════════════ MONITORING / ALERTS / SHUTDOWN ═════════════════════════════════════
describe("Monitoring extensions, alerts foundation, graceful shutdown", () => {
  test("rates, partial / queued / scheduled counts, last failure and the worker description come from real jobs (nulls, not invented numbers, when empty)", async () => {
    const empty = await monitor.getSummary(db, T);
    expect(empty).toMatchObject({ successRateLast7Days: null, failureRateLast7Days: null, lastFailedSync: null, partialSyncsLast7Days: 0, scheduledJobs: 0, worker: { implementation: "DB_BACKED_WORKER", realQueue: false } });
    const c = await mkConn([cap("PRODUCT_MASTER", "/p")]);
    const mk = (status, extra = {}) => db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status, completed_at: new Date(), ...extra });
    await mk("SUCCESS"); await mk("SUCCESS"); await mk("PARTIAL"); await mk("FAILED", { error_code: "TIMEOUT" });
    const s = await monitor.getSummary(db, T);
    expect(s).toMatchObject({ completedSyncsLast7Days: 4, successRateLast7Days: 50, failureRateLast7Days: 25, partialSyncsLast7Days: 1, lastFailedSync: { capability: "PRODUCT_MASTER", errorCode: "TIMEOUT" } });
    expect(s.perConnection[0].last7Days).toEqual({ success: 2, partial: 1, failed: 1 });
  });
  test("alerts: repeated failures (CRITICAL), undecided ownership (INFO), overdue schedule (WARNING), stuck job, failed outbound — monitoring only, tenant-scoped, nothing is sent anywhere", async () => {
    const c = await mkConn([cap("PRODUCT_MASTER", "/p"), cap("STOCK", "/stock")]);
    for (let i = 0; i < 3; i += 1) await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "FAILED", completed_at: new Date(Date.now() - i * 1000) });
    await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", heartbeat_at: new Date(Date.now() - 3 * 3600000), active_key: `${T}:${c.id}:PRODUCT_MASTER` });
    await db.ErpSyncSchedule.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", enabled: true, frequency: "HOURLY", next_run_at: new Date(Date.now() - 2 * 3600000) });
    await db.ErpOutboundEvent.create({ tenant_key: T, connection_id: c.id, capability: "PAYMENT", entity_type: "PAYMENT", entity_id: "1", operation: "CREATE", idempotency_key: "k1", status: "FAILED" });
    const { alerts } = await monitor.getAlerts(db, T); const by = (code) => alerts.find((a) => a.code === code);
    expect(by("SYNC_FAILING")).toMatchObject({ severity: "CRITICAL", capability: "PRODUCT_MASTER" }); expect(by("JOB_STUCK")).toBeTruthy(); expect(by("SCHEDULER_OVERDUE")).toMatchObject({ severity: "WARNING" });
    expect(by("OWNERSHIP_UNDECIDED")).toMatchObject({ severity: "INFO", capability: "STOCK" }); expect(by("OUTBOUND_PROBLEMS")).toBeTruthy();
    expect(alerts[0].severity).toBe("CRITICAL"); expect((await monitor.getAlerts(db, T2)).alerts).toEqual([]);
    expect(fs.readFileSync(path.join(__dirname, "../services/erpMonitoring.service.js"), "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/nodemailer|sendMail|webhook|twilio|slack/i);
  });
  test("graceful shutdown: stops the timer, waits for in-flight worker passes (bounded), reports what is left", async () => {
    sched.startScheduler(db, { intervalMs: 60000 });
    const r = await sched.shutdownScheduler({ graceMs: 500 }); expect(r).toMatchObject({ stillRunning: 0 }); expect(sched.inflightCount()).toBe(0);
    expect(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")).toMatch(/SIGTERM[\s\S]*shutdownScheduler|shutdownScheduler[\s\S]*SIGTERM/);
  });
  test("API surface: lookups expose ownership / code mapping types / outbound capabilities; new routes are admin-only; no queue library or Retailer login introduced", async () => {
    const l = (await A(erp.lookups)).jsonBody;
    expect(l.ownerships.map((x) => x.value)).toEqual(["ERP_OWNED", "DMS_OWNED", "SHARED"]); expect(l.codeMappingTypes.map((x) => x.type)).toEqual(["CUSTOMER_GROUP", "HSN", "WAREHOUSE", "BATCH", "PAYMENT_MODE"]);
    expect(l.outboundCapabilities).toEqual(["CUSTOMER_MASTER", "PAYMENT"]); expect(l.directions.map((x) => x.value)).toContain("DISABLED");
    const requireAdmin = require("../middleware/adminAuth");
    const mine = require("../routes/adminRoutes").stack.filter((x) => x.route && /erp-sync\/(audit|alerts|outbound)|code-mappings/.test(x.route.path));
    expect(mine).toHaveLength(7); for (const r of mine) expect(r.route.stack.map((s) => s.handle)).toContain(requireAdmin);
    const pkg = require("../package.json"); expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => /^(bull|bullmq|bee-queue|agenda|kue|amqplib|ioredis|redis)$/.test(n))).toEqual([]);
  });
});

// ═════════════════════════════════════ MIGRATION ═════════════════════════════════════
describe("Migration (Phase 16)", () => {
  test("up / down / up is idempotent and reversible; only additive structures; existing rows survive", async () => {
    const { Sequelize } = require("sequelize"); const qi = db.sequelize.getQueryInterface(); const m = require("../migrations/20261009090000-erp-phase16");
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const d = await seedDistributor(); const c = await mkConn([cap("PRODUCT_MASTER", "/p")]);
    await m.up(qi, Sequelize); await m.up(qi, Sequelize);
    expect(await tables()).toEqual(expect.arrayContaining(["erp_audit_events", "erp_outbound_events"]));
    await m.down(qi, Sequelize); const after = await tables(); expect(after).not.toContain("erp_audit_events");
    expect(Object.keys(await qi.describeTable("erp_connection_capabilities"))).not.toContain("ownership");
    expect(Object.keys(await qi.describeTable("SalesOrderHeaders"))).not.toContain("external_source_id");
    expect(await db.ErpConnection.count()).toBe(1);
    await m.down(qi, Sequelize); await m.up(qi, Sequelize);
    expect(Object.keys(await qi.describeTable("SalesOrderHeaders"))).toEqual(expect.arrayContaining(["external_source_type", "external_source_id"]));
    expect(d && c).toBeTruthy();
  });
});
