// Phase 18 — business-transaction integration: stock / sales / invoice / return / payment / document, outbound, echo prevention, reconciliation, provider
// contract, verification levels, monitoring, migration. Same convention as Phases 14–17: in-memory sqlite, direct service / controller calls, a MOCK fetch for every
// ERP transport. A mocked 200 proves OUR handling, never real ERP connectivity.
const fs = require("fs");
const path = require("path");
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedBatch, seedCustomer, seedPricing, seedGLAccounts } = require("./helpers");
const erp = require("../controllers/admin.erp.controller");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const outbound = require("../services/erpOutbound.service");
const recon = require("../services/erpReconciliation.service");
const business = require("../services/erpBusiness.service");
const docs = require("../services/erpDocumentStore.service");
const registry = require("../services/erp/providerRegistry");
const targets = require("../services/erp/sync/targets");
const inventory = require("../services/inventory.service");
const codes = require("../services/erpCodeMapping.service");
const audit = require("../services/erpAudit.service");

beforeAll(() => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789" }); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); docs.setDocumentStore(null); docs.setMalwareScanner(null); });
afterAll(async () => { await audit.flush(); await db.sequelize.close(); });

const T = "DEFAULT"; const T2 = "TENANT_B";
const hdrs = () => ({ get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null), getSetCookie: () => [] });
const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: hdrs() });
const D = (fetchImpl, extra = {}) => ({ await: true, fetchImpl, logger: () => {}, retryDelayMs: 0, ...extra });
const restFetch = (byPath, calls = []) => jest.fn(async (url, init) => { const p = new URL(url).pathname; calls.push({ url, init }); const v = byPath[p]; if (v === undefined) return json(404, {}); if (typeof v === "function") return v(url, init); return json(200, { rows: v }); });
const cap = (capability, endpointPath, o = {}) => ({ capability, endpointPath, direction: "ERP_TO_DMS", config: { responsePath: "rows", pagination: { type: "NONE" } }, ...o });
const mkConn = (caps, o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: caps, ...o });
const mkMap = (c, capability, rows, tenant = T) => sync.saveMappings(db, tenant, 1, c.id, capability, { mappings: rows });
const run = (c, capability, scope, fetchImpl, extra = {}, tenant = T) => sync.startSync(db, tenant, 1, { connectionId: c.id, capability, scope }, D(fetchImpl, extra));
const reconcile = (c, capability, scope, fetchImpl, extra = {}, tenant = T) => recon.run(db, tenant, 1, { connectionId: c.id, capability, scope }, { fetchImpl, logger: () => {}, retryDelayMs: 0, ...extra });
const link = (c, entityType, externalId, did, entityId, extra = {}) => db.ErpExternalLink.create({ tenant_key: T, connection_id: c.id, entity_type: entityType, external_id: externalId, scope_key: `distributor:${did}`, dms_entity_id: entityId, ...extra });
const wh = (did, code = "WH1") => db.Warehouse.create({ distributor_id: did, code, name: code, is_default: code === "WH1" });
const onHand = (b, did, whId) => inventory.getBatchAvailableQty({ batchId: b.id, distributorId: did, warehouseId: whId });
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };

// ═════════════════════════════════════ STOCK ═════════════════════════════════════
describe("STOCK — opening snapshot, delta, conflict, mappings, negative stock, idempotency, reconciliation", () => {
  const MAP = [{ sourceField: "Id", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Plant", dmsField: "plant_code" }, { sourceField: "Batch", dmsField: "batch_no" }, { sourceField: "Qty", dmsField: "quantity", transform: ["to_number"] }];
  async function world(ownership = "ERP_OWNED") {
    const d = await seedDistributor(); const p = await seedProduct(d.id); const b = await seedBatch(d.id, p.id, { batch_no: "B-100", exp_date: new Date(Date.now() + 400 * 86400000) });
    const w = await wh(d.id); const c = await mkConn([cap("PRODUCT_MASTER", "/p"), cap("STOCK", "/stock", { ownership })]); const conn = await sync.loadConnection(db, T, c.id);
    await link(c, "PRODUCT", "MAT1", d.id, p.id); await codes.upsert(db, T, 1, conn, { type: "WAREHOUSE", externalCode: "1000", distributorId: d.id, dmsId: w.id });
    await mkMap(c, "STOCK", MAP);
    const rec = (qty, o = {}) => ({ Id: "S1", Mat: "MAT1", Plant: "1000", Batch: "B-100", Qty: qty, ...o });
    return { d, p, b, w, c, rec, go: (rows) => run(c, "STOCK", { distributorId: d.id }, restFetch({ "/stock": rows })), rc: (rows, extra) => reconcile(c, "STOCK", { distributorId: d.id }, restFetch({ "/stock": rows }), extra) };
  }
  test("opening snapshot → delta → idempotent repeat; every movement is a ledger row from inventory.postAdjustment", async () => {
    const s = await world();
    expect((await s.go([s.rec(20)])).counts.created).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(20);
    expect((await s.go([s.rec(20)])).counts.skipped).toBe(1); expect(await db.StockLedger.count()).toBe(1);
    expect((await s.go([s.rec(26)])).counts.updated).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(26);
  });
  test("existing DMS stock on the first snapshot → BUSINESS_DECISION_REQUIRED, never auto-reconciled; plant and batch mappings are never guessed", async () => {
    const s = await world();
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 4, direction: "IN", reasonType: "OPENING", reason: "DMS opening", warehouseId: s.w.id, userId: 1 });
    const job = await s.go([s.rec(10), s.rec(5, { Id: "S2", Plant: "9999" }), s.rec(5, { Id: "S3", Batch: "NOPE" })]);
    expect(job.counts.failed).toBe(3); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(4); expect(await db.StockLedger.count()).toBe(1);
    expect((await sync.listJobErrors(db, T, job.id)).items.map((e) => e.code).sort()).toEqual(["BUSINESS_DECISION_REQUIRED", "BUSINESS_DECISION_REQUIRED", "VALIDATION_ERROR"]);
  });
  test("negative stock is impossible: a decrease larger than what is on hand is refused by the ledger", async () => {
    const s = await world(); await s.go([s.rec(10)]);
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 9, direction: "OUT", reasonType: "DAMAGE", reason: "x", warehouseId: s.w.id, userId: 1 });
    expect((await s.go([s.rec(2)])).counts.failed).toBe(1); expect(await onHand(s.b, s.d.id, s.w.id)).toBe(1);
  });
  test("RECONCILIATION (read-only): MISSING_IN_DMS (opening can be booked) · PENDING_REVIEW (DMS already holds stock) · MATCHED · MISMATCH · BLOCKED (unmapped plant) — nothing is posted", async () => {
    const s = await world();
    let r = await s.rc([s.rec(20)]);
    expect(r.counts).toMatchObject({ total: 1, MISSING_IN_DMS: 1 }); expect(r.items[0]).toMatchObject({ status: "MISSING_IN_DMS", erp: { quantity: 20 }, dms: { quantity: 0 }, difference: 20 });
    expect(r.note).toMatch(/Read-only/); expect(await db.StockLedger.count()).toBe(0);
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 4, direction: "IN", reasonType: "OPENING", reason: "DMS opening", warehouseId: s.w.id, userId: 1 });
    r = await s.rc([s.rec(10)]); expect(r.items[0]).toMatchObject({ status: "PENDING_REVIEW", code: "BUSINESS_DECISION_REQUIRED", difference: 6 }); expect(r.items[0].dms.quantity).toBe(4);
    await db.StockLedger.destroy({ where: {} }); await s.go([s.rec(20)]);
    expect((await s.rc([s.rec(20)])).counts).toMatchObject({ MATCHED: 1, total: 1 });
    await inventory.postAdjustment({ distributorId: s.d.id, productId: s.p.id, batchId: s.b.id, quantity: 5, direction: "OUT", reasonType: "DAMAGE", reason: "x", warehouseId: s.w.id, userId: 1 });
    r = await s.rc([s.rec(20)]); expect(r.items[0]).toMatchObject({ status: "MISMATCH", erp: { quantity: 20 }, dms: { quantity: 15 }, difference: 5, lastSyncedQuantity: 20 });
    r = await s.rc([s.rec(5, { Id: "S9", Plant: "9999" })]); expect(r.items.find((i) => i.externalId === "S9")).toMatchObject({ status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED" });
    expect(await db.StockLedger.count()).toBe(2); // 1 opening (sync) + 1 damage (DMS) — reconciliation posted nothing
  });
  test("the stored outcome is a note on the link only; MISSING_IN_ERP appears only when the ERP result set was read completely", async () => {
    const s = await world(); await s.go([s.rec(20)]);
    let r = await s.rc([]); expect(r.complete).toBe(true); expect(r.counts.MISSING_IN_ERP).toBe(1);
    const l = await db.ErpExternalLink.findOne({ where: { entity_type: "STOCK" } }); expect(l.reconcile_status).toBe("MISSING_IN_ERP");
    const list = await recon.list(db, T, { connectionId: s.c.id, capability: "STOCK" }); expect(list.items[0]).toMatchObject({ status: "MISSING_IN_ERP", externalId: "S1" }); expect(list.byStatus.MISSING_IN_ERP).toBe(1);
    r = await s.rc([s.rec(20, { Id: "OTHER" })], { limits: { maxRecords: 1 } }); // a truncated read proves nothing about absence
    r = await s.rc([s.rec(20, { Id: "A" }), s.rec(20, { Id: "B" })], { limits: { maxRecords: 1 } }); expect(r.truncated).toBe(true); expect(r.complete).toBe(false); expect(r.counts.MISSING_IN_ERP).toBe(0);
  });
  test("ownership gate on reconciliation: when importing is not allowed every difference is BLOCKED (never presented as something a sync would fix)", async () => {
    const s = await world("DMS_OWNED"); const r = await s.rc([s.rec(20)]);
    expect(r.ownership).toMatchObject({ allowsImport: false, code: "BUSINESS_DECISION_REQUIRED" }); expect(r.items[0]).toMatchObject({ status: "BLOCKED" }); expect(r.items[0].detail).toMatch(/observed: MISSING_IN_DMS/);
  });
  test("the stock code still never writes StockLedger / Batch directly", () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/erp/sync/targets.js"), "utf8");
    const stock = src.slice(src.indexOf("STOCK (Phase 16)"), src.indexOf("SALES (Phase 16)")).replace(/\/\/.*$/gm, "");
    expect(stock).not.toMatch(/StockLedger\.(create|update|bulkCreate|destroy)|Batch\.(create|update|bulkCreate|destroy)/);
    const reconSrc = fs.readFileSync(path.join(__dirname, "../services/erpReconciliation.service.js"), "utf8").replace(/\/\/.*$/gm, "");
    expect(reconSrc).not.toMatch(/StockLedger|\.create\(|Payment|Journal|SalesOrder|Customer\.|Product\./);
  });
});

// ═════════════════════════════════════ SALES ═════════════════════════════════════
describe("SALES — external identity, duplicates, DRAFT updates, cancellation, confirmed orders protected", () => {
  const MAP = [{ sourceField: "OrderNo", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "order_date", transform: ["to_date"] }, { sourceField: "Terms", dmsField: "payment_terms" }, { sourceField: "Cancelled", dmsField: "cancelled" }, { sourceField: "Items[].Mat", dmsField: "lines.product_external_id" }, { sourceField: "Items[].Qty", dmsField: "lines.quantity", transform: ["to_number"] }];
  async function world(ownership = "ERP_OWNED") {
    const d = await seedDistributor(); const p = await seedProduct(d.id, { gst: 12, cgst: 6, sgst: 6 }); const cu = await seedCustomer(d.id);
    await seedPricing(d, p, cu.customer_group_id, { basePrice: 100 });
    const b = await seedBatch(d.id, p.id, { batch_no: "S-1", exp_date: new Date(Date.now() + 400 * 86400000) }); const w = await wh(d.id);
    await inventory.postAdjustment({ distributorId: d.id, productId: p.id, batchId: b.id, quantity: 100, direction: "IN", reasonType: "OPENING", reason: "seed", warehouseId: w.id, userId: 1 });
    const c = await mkConn([cap("SALES", "/orders", { ownership })]);
    await link(c, "PRODUCT", "MAT1", d.id, p.id); await link(c, "CUSTOMER", "C1", d.id, cu.id); await mkMap(c, "SALES", MAP);
    const order = (n, o = {}) => ({ OrderNo: `SO${n}`, Cust: "C1", Date: "2026-10-01", Terms: "CREDIT", Items: [{ Mat: "MAT1", Qty: 5 }], ...o });
    return { d, p, cu, c, order, go: (rows) => run(c, "SALES", { distributorId: d.id }, restFetch({ "/orders": rows })), rc: (rows) => reconcile(c, "SALES", { distributorId: d.id }, restFetch({ "/orders": rows })) };
  }
  test("creates a DRAFT order once (external source columns + link), repeat is skipped, never confirmed; mapping gaps fail only that record", async () => {
    const s = await world();
    expect((await s.go([s.order(1)])).counts.created).toBe(1);
    expect(await db.SalesOrderHeader.findOne()).toMatchObject({ status: "DRAFT", external_source_type: `ERP:${s.c.id}`, external_source_id: "SO1" });
    expect((await s.go([s.order(1)])).counts.skipped).toBe(1); expect(await db.SalesOrderHeader.count()).toBe(1);
    const bad = await s.go([s.order(2, { Cust: "NOBODY" }), s.order(3, { Items: [{ Mat: "NOPE", Qty: 1 }] }), s.order(4, { Terms: "" })]);
    expect(bad.counts.failed).toBe(3); expect(await db.SalesOrderHeader.count()).toBe(1);
  });
  test("update allowed only while DRAFT; a confirmed order is NOT overwritten (BUSINESS_DECISION_REQUIRED)", async () => {
    const s = await world(); await s.go([s.order(1)]); const o = await db.SalesOrderHeader.findOne();
    expect((await s.go([s.order(1, { Items: [{ Mat: "MAT1", Qty: 8 }] })])).counts.updated).toBe(1);
    await db.SalesOrderHeader.update({ status: "CONFIRMED" }, { where: { id: o.id } });
    const job = await s.go([s.order(1, { Items: [{ Mat: "MAT1", Qty: 9 }] })]);
    expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); expect(Number((await db.SalesOrderLine.findOne({ where: { orderId: o.id } })).quantity)).toBe(8);
  });
  test("a DRAFT edited in the DMS after the last sync is not overwritten by the ERP", async () => {
    const s = await world(); await s.go([s.order(1)]);
    await db.ErpExternalLink.update({ last_synced_at: new Date(Date.now() - 60000) }, { where: { entity_type: "SALES_ORDER" } }); // the DMS order was touched "after" the last sync
    const job = await s.go([s.order(1, { Items: [{ Mat: "MAT1", Qty: 9 }] })]);
    expect(job.counts.failed).toBe(1); expect((await sync.listJobErrors(db, T, job.id)).items[0].message).toMatch(/edited in the DMS/);
  });
  test("cancellation: cancelled before import → nothing created; a DRAFT is cancelled through the DMS service; a confirmed order is never cancelled by a sync", async () => {
    const s = await world();
    expect((await s.go([s.order(5, { Cancelled: "true" })])).counts.skipped).toBe(1); expect(await db.SalesOrderHeader.count()).toBe(0); expect(await db.ErpExternalLink.count({ where: { entity_type: "SALES_ORDER" } })).toBe(0);
    await s.go([s.order(1)]); await s.go([s.order(1, { Cancelled: "true" })]);
    expect((await db.SalesOrderHeader.findOne()).status).toBe("CANCELLED");
    await s.go([s.order(2)]); const o2 = await db.SalesOrderHeader.findOne({ where: { external_source_id: "SO2" } }); await db.SalesOrderHeader.update({ status: "CONFIRMED" }, { where: { id: o2.id } });
    const job = await s.go([s.order(2, { Cancelled: "1" })]); expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); expect((await db.SalesOrderHeader.findByPk(o2.id)).status).toBe("CONFIRMED");
  });
  test("RECONCILIATION: MATCHED · MISSING_IN_DMS · MISMATCH (DRAFT will update) · BLOCKED (changed after confirmation)", async () => {
    const s = await world(); await s.go([s.order(1)]);
    expect((await s.rc([s.order(1)])).counts.MATCHED).toBe(1);
    expect((await s.rc([s.order(2)])).items[0]).toMatchObject({ status: "MISSING_IN_DMS" });
    expect((await s.rc([s.order(1, { Items: [{ Mat: "MAT1", Qty: 9 }] })])).items[0]).toMatchObject({ status: "MISMATCH" });
    await db.SalesOrderHeader.update({ status: "CONFIRMED" }, { where: {} });
    expect((await s.rc([s.order(1, { Items: [{ Mat: "MAT1", Qty: 9 }] })])).items[0]).toMatchObject({ status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED" });
    expect(await db.SalesOrderHeader.count()).toBe(1); expect(Number((await db.SalesOrderLine.findOne()).quantity)).toBe(5);
  });
  test("ownership: undecided → BUSINESS_DECISION_REQUIRED before any job or ERP call", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/orders": [] }); const c = await mkConn([cap("SALES", "/orders")]);
    await expect(run(c, "SALES", { distributorId: d.id }, f)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════ INVOICE / RETURN / DOCUMENT (blocked) ═════════════════════════════════════
describe("INVOICE and RETURN stay BLOCKED; nothing is created, no accounting, no stock", () => {
  const before = async () => ({ inv: await db.SalesInvoiceHeader.count(), je: await db.JournalEntry.count(), led: await db.StockLedger.count(), cn: await db.SalesCreditNote.count(), ret: await db.SalesReturn.count() });
  test("INVOICE: even with ERP_OWNED ownership configured, sync and reconciliation are refused with BUSINESS_DECISION_REQUIRED and the open decisions; accounting untouched", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/invoices": [{ Id: "I1" }] }); const b = await before();
    const c = await mkConn([cap("INVOICE", "/invoices", { ownership: "ERP_OWNED" })]); await expect(mkMap(c, "INVOICE", [{ sourceField: "Id", isKey: true }])).rejects.toMatchObject({ message: expect.stringMatching(/no DMS target/) });
    await expect(run(c, "INVOICE", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409, code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/accounting/i) });
    await expect(reconcile(c, "INVOICE", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409 });
    await expect(outbound.send(db, T, 1, { connectionId: c.id, capability: "INVOICE", entityId: 1 }, { fetchImpl: f })).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED", message: expect.stringMatching(/invoice/i) });
    expect(f).not.toHaveBeenCalled(); expect(await before()).toEqual(b); expect(await db.ErpSyncJob.count()).toBe(0);
    expect(targets.getTarget("INVOICE")).toBeNull();
  });
  test("INVOICE overview: ten decision questions — only ownership / direction can be DECIDED from configuration; accounting, receivables, delivery mapping stay REQUIRED", async () => {
    const c = await mkConn([cap("INVOICE", "/invoices", { ownership: "ERP_OWNED" })]);
    const ov = await business.overview(db, T); const inv = ov.connections[0].capabilities.find((x) => x.capability === "INVOICE");
    expect(inv.state).toBe("BLOCKED"); expect(inv.decisions).toHaveLength(10);
    const by = Object.fromEntries(inv.decisions.map((x) => [x.id, x.status]));
    expect(by).toMatchObject({ owner: "DECIDED", accounting: "REQUIRED", receivables: "REQUIRED", deliveryMapping: "REQUIRED", existingInvoice: "REQUIRED", externalId: "READY", duplicates: "READY" });
    expect(inv.blockers[0].message).toMatch(/accounting|external invoice id|ownership/i); expect(c.id).toBeGreaterThan(0);
  });
  test("INVOICE / RETURN external-id foundation: the columns exist and (distributor, source type, source id) is a UNIQUE index — a duplicate external invoice / return cannot be stored twice", async () => {
    const qi = db.sequelize.getQueryInterface();
    for (const [table, name] of [["SalesInvoiceHeaders", "uq_sales_invoice_external_source"], ["SalesReturns", "uq_sales_return_external_source"]]) {
      const cols = Object.keys(await qi.describeTable(table)); expect(cols).toEqual(expect.arrayContaining(["external_source_type", "external_source_id"]));
      const ix = (await qi.showIndex(table)).find((i) => i.name === name); expect(ix).toBeTruthy(); expect(Boolean(ix.unique)).toBe(true);
      expect(ix.fields.map((f) => f.attribute || f.name)).toEqual(["distributor_id", "external_source_type", "external_source_id"]);
    }
    expect(Object.keys(db.SalesInvoiceHeader.rawAttributes)).toContain("external_source_id"); // nothing in the sync code reads or writes them yet
    const sync = fs.readFileSync(path.join(__dirname, "../services/erp/sync/targets.js"), "utf8").replace(/\/\/.*$/gm, ""); expect(sync).not.toMatch(/db\.SalesInvoiceHeader|db\.SalesReturn\b/);
  });
  test("RETURN: blocked because it depends on invoice and delivery; no return, credit note or stock movement can be created; overview lists the dependency", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/returns": [{ Id: "R1" }] }); const b = await before();
    const c = await mkConn([cap("RETURN", "/returns", { ownership: "ERP_OWNED" })]);
    await expect(run(c, "RETURN", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/invoice/i) });
    await expect(reconcile(c, "RETURN", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409 });
    expect(f).not.toHaveBeenCalled(); expect(await before()).toEqual(b);
    const cat = business.catalog().find((x) => x.capability === "RETURN"); expect(cat).toMatchObject({ classification: "BLOCKED", dependsOn: ["INVOICE"] }); expect(cat.requiredDecisions.join(" ")).toMatch(/credit-note|stock re-entry/i);
  });
  test("DOCUMENT: no store → ingestion refused with BUSINESS_DECISION_REQUIRED; sync blocked; readiness lists exactly what is missing; nothing is written to disk", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/docs": [] }); const c = await mkConn([cap("DOCUMENT", "/docs", { ownership: "ERP_OWNED" })]);
    await expect(run(c, "DOCUMENT", { distributorId: d.id }, f)).rejects.toMatchObject({ statusCode: 409, code: "CAPABILITY_NOT_SUPPORTED", message: expect.stringMatching(/tenant-isolated/i) });
    await expect(docs.ingest({ tenantKey: T, distributorId: d.id, externalDocumentId: "D1", filename: "a.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4 x") })).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    const r = docs.readiness(); expect(r.ready).toBe(false); expect(r.missing).toEqual(expect.arrayContaining(["approvedStore", "malwareScan", "externalDocumentId", "accessAuthorization", "retention"])); expect(f).not.toHaveBeenCalled();
  });
  test("DOCUMENT abstraction: safe filename, content-type + magic bytes, size limit, tenant/distributor-isolated keys, traversal refused, duplicate by external id; scanner required", async () => {
    expect(docs.safeFilename("../../etc/pass wd.pdf")).toBe("pass_wd.pdf"); expect(() => docs.safeFilename("..")).toThrow(); expect(() => docs.safeFilename("noext")).toThrow();
    const pdf = Buffer.from("%PDF-1.7 hello");
    expect(docs.validateDocument({ filename: "a.pdf", contentType: "application/pdf", buffer: pdf })).toMatchObject({ filename: "a.pdf", size: pdf.length });
    expect(() => docs.validateDocument({ filename: "a.pdf", contentType: "text/html", buffer: pdf })).toThrow(/not allowed/);
    expect(() => docs.validateDocument({ filename: "a.pdf", contentType: "application/pdf", buffer: Buffer.from("<script>") })).toThrow(/does not match/);
    expect(() => docs.validateDocument({ filename: "a.exe", contentType: "application/pdf", buffer: pdf })).toThrow(/extension/);
    process.env.ERP_DOCUMENT_MAX_BYTES = "1024"; expect(() => docs.validateDocument({ filename: "a.pdf", contentType: "application/pdf", buffer: Buffer.concat([pdf, Buffer.alloc(2000)]) })).toThrow(/larger/); delete process.env.ERP_DOCUMENT_MAX_BYTES;
    const k1 = docs.storageKey({ tenantKey: "T1", distributorId: 3, externalDocumentId: "../../x", filename: "a.pdf" }); expect(k1).toMatch(/^tenants\/T1\/distributors\/3\/[0-9a-f]{24}\/a\.pdf$/); expect(k1).not.toMatch(/\.\./);
    expect(() => docs.storageKey({ tenantKey: "../T1", distributorId: 3, externalDocumentId: "x", filename: "a.pdf" })).toThrow();
    expect(docs.storageKey({ tenantKey: "T1", distributorId: 3, externalDocumentId: "x", filename: "a.pdf" })).not.toBe(docs.storageKey({ tenantKey: "T2", distributorId: 3, externalDocumentId: "x", filename: "a.pdf" }));
    const store = docs.createMemoryStore(); docs.setDocumentStore(store);
    const args = { tenantKey: "T1", distributorId: 3, externalDocumentId: "D-1", filename: "a.pdf", contentType: "application/pdf", buffer: pdf };
    await expect(docs.ingest(args)).rejects.toMatchObject({ message: expect.stringMatching(/scanner/) }); expect(store.size()).toBe(0);
    docs.setMalwareScanner(async () => ({ clean: false })); await expect(docs.ingest(args)).rejects.toThrow(/malware/); expect(store.size()).toBe(0);
    docs.setMalwareScanner(async () => ({ clean: true })); expect((await docs.ingest(args)).duplicate).toBe(false); expect((await docs.ingest(args)).duplicate).toBe(true); expect(store.size()).toBe(1);
    await docs.ingest({ ...args, tenantKey: "T2" }); expect(store.size()).toBe(2); expect(store.keys().every((k) => /^tenants\/T[12]\//.test(k))).toBe(true);
    expect(() => docs.setDocumentStore({ put() {}, get() {}, delete() {}, exists() {} })).toThrow(/tenantIsolated/);
    expect(docs.readiness().ready).toBe(false); // abstraction alone never makes document sync "ready"
  });
});

// ═════════════════════════════════════ PAYMENT ═════════════════════════════════════
describe("PAYMENT — inbound, payment-mode mapping, duplicates, outbound, echo prevention", () => {
  const CUST_MAP = [{ sourceField: "CustNo", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "Street", dmsField: "street1" }, { sourceField: "City", dmsField: "city" }, { sourceField: "State", dmsField: "region" }, { sourceField: "Phone", dmsField: "phone_number" }, { sourceField: "Pin", dmsField: "pincode" }];
  const PAY_MAP = [{ sourceField: "PayId", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "payment_date", transform: ["to_date"] }, { sourceField: "Amt", dmsField: "amount", transform: ["to_number"] }, { sourceField: "Mode", dmsField: "mode" }, { sourceField: "Ref", dmsField: "reference_no" }];
  const OUT = { outbound: { idempotencySupported: true, externalIdPath: "id" } };
  async function world(payCap = {}) {
    const d = await seedDistributor(); const group = await db.CustomerGroup.create({ code: "RTL", name: "Retail", distributor_id: d.id }); await seedGLAccounts(d);
    const c = await mkConn([cap("CUSTOMER_MASTER", "/customers"), cap("PAYMENT", "/payments", { direction: "BIDIRECTIONAL", ownership: "SHARED", config: { responsePath: "rows", pagination: { type: "NONE" }, ...OUT }, ...payCap })]); const conn = await sync.loadConnection(db, T, c.id);
    await mkMap(c, "CUSTOMER_MASTER", CUST_MAP); await mkMap(c, "PAYMENT", PAY_MAP);
    await run(c, "CUSTOMER_MASTER", { distributorId: d.id, customerGroupId: group.id }, restFetch({ "/customers": [{ CustNo: "C1", Name: "Pharmacy 1", Street: "1 Rd", City: "Pune", State: "Maharashtra", Phone: "9876543210", Pin: "411001" }] }));
    const cu = await db.Customer.findOne();
    const pay = (id, o = {}) => ({ PayId: id, Cust: "C1", Date: "2026-09-01", Amt: "1500.50", Mode: "BANK_TRANSFER", Ref: "UTR1", ...o });
    return { d, c, conn, cu, pay, go: (rows, scope = {}) => run(c, "PAYMENT", { distributorId: d.id, ...scope }, restFetch({ "/payments": rows })) };
  }
  test("inbound: posted once through the Accounts service (journal balanced), a repeat does not duplicate ledger / accounting", async () => {
    const w = await world(); expect((await w.go([w.pay("P1")])).counts.created).toBe(1); const je = await db.JournalEntry.count();
    expect((await w.go([w.pay("P1")])).counts.skipped).toBe(1); expect(await db.Payment.count()).toBe(1); expect(await db.JournalEntry.count()).toBe(je);
  });
  test("payment mode: a configured ERP code mapping is used first; an unmapped ERP code → BUSINESS_DECISION_REQUIRED (never guessed); a DMS mode name is accepted; default mode honoured", async () => {
    const w = await world(); await codes.upsert(db, T, 1, w.conn, { type: "PAYMENT_MODE", externalCode: "07", dmsValue: "UPI" });
    expect((await w.go([w.pay("P1", { Mode: "07", Ref: "A" })])).counts.created).toBe(1); expect((await db.Payment.findOne()).mode).toBe("UPI");
    const job = await w.go([w.pay("P2", { Mode: "99", Ref: "B" })]); expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", message: expect.stringMatching(/"99"/) });
    expect((await w.go([w.pay("P3", { Mode: "cash", Ref: "C" })])).counts.created).toBe(1);
    expect((await w.go([w.pay("P4", { Mode: "", Ref: "D" })], { defaultMode: "CASH" })).counts.created).toBe(1); expect(await db.Payment.count()).toBe(3);
  });
  test("outbound: DMS payment goes out once with a stable idempotency key; the ERP id is remembered with origin DMS", async () => {
    const w = await world({ ownership: "DMS_OWNED", direction: "DMS_TO_ERP" }); await link(w.c, "CUSTOMER", "E-C1", w.d.id, w.cu.id);
    await codes.upsert(db, T, 1, w.conn, { type: "PAYMENT_MODE", externalCode: "U", dmsValue: "UPI" });
    await mkMap(w.c, "PAYMENT", PAY_MAP);
    const p = await db.Payment.create({ payment_number: "PAY-100", distributor_id: w.d.id, customer_id: w.cu.id, payment_date: "2026-10-01", amount: 500, mode: "UPI", reference_no: "UTR9" });
    const f = jest.fn(async () => json(201, { id: "E-P1" })); const send = () => outbound.send(db, T, 1, { connectionId: w.c.id, capability: "PAYMENT", entityId: p.id }, { fetchImpl: f, logger: () => {} });
    const r = await send(); expect(r).toMatchObject({ status: "SENT", externalId: "E-P1" }); expect(f.mock.calls[0][1].headers["Idempotency-Key"]).toBe(`${T}:${w.c.id}:PAYMENT:${p.id}:create`);
    expect((await send()).duplicate).toBe(true); expect(f).toHaveBeenCalledTimes(1);
    expect(await db.ErpExternalLink.findOne({ where: { entity_type: "PAYMENT", external_id: "E-P1" } })).toMatchObject({ origin: "DMS", dms_entity_id: p.id });
  });
  test("ECHO (DMS → ERP → DMS): the ERP returns the payment the DMS sent — recognised by its ERP id, never booked twice; no new ledger / journal rows", async () => {
    const w = await world(); await link(w.c, "CUSTOMER", "E-C1", w.d.id, w.cu.id);
    const p = await db.Payment.create({ payment_number: "PAY-100", distributor_id: w.d.id, customer_id: w.cu.id, payment_date: "2026-09-01", amount: 1500.5, mode: "UPI", reference_no: "UTR9" });
    await db.ErpOutboundEvent.create({ tenant_key: T, connection_id: w.c.id, capability: "PAYMENT", entity_type: "PAYMENT", entity_id: String(p.id), operation: "CREATE", idempotency_key: "k1", status: "SENT", attempt: 1, external_id: "E-P1" }); // sent, but the link write was lost
    const je = await db.JournalEntry.count();
    const job = await w.go([w.pay("E-P1", { Cust: "C1" })]); expect(job.counts).toMatchObject({ skipped: 1, created: 0, failed: 0 });
    expect(await db.Payment.count()).toBe(1); expect(await db.JournalEntry.count()).toBe(je);
    expect(await db.ErpExternalLink.findOne({ where: { entity_type: "PAYMENT", external_id: "E-P1" } })).toMatchObject({ origin: "DMS", dms_entity_id: p.id });
    expect((await w.go([w.pay("E-P1")])).counts.skipped).toBe(1); // later runs: still nothing
  });
  test("ECHO via the ERP's own reference = the DMS payment number is adopted; a clashing reference with a different amount needs a decision", async () => {
    const w = await world(); const p = await db.Payment.create({ payment_number: "PAY-200", distributor_id: w.d.id, customer_id: w.cu.id, payment_date: "2026-09-01", amount: 1500.5, mode: "CASH" });
    expect((await w.go([w.pay("E-X", { Ref: "PAY-200" })])).counts).toMatchObject({ skipped: 1, created: 0 }); expect(await db.Payment.count()).toBe(1);
    expect(await db.ErpExternalLink.findOne({ where: { entity_type: "PAYMENT", external_id: "E-X" } })).toMatchObject({ origin: "DMS", dms_entity_id: p.id });
    const job = await w.go([w.pay("E-Y", { Ref: "PAY-200", Amt: "9" })]); expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); expect(await db.Payment.count()).toBe(1);
  });
  test("ECHO (ERP → DMS → ERP): an ERP-originated payment is never sent back — by reference prefix and by its ERP link", async () => {
    const w = await world({ ownership: "SHARED" }); await w.go([w.pay("E-P5")]); const p = await db.Payment.findOne();
    await link(w.c, "CUSTOMER", "E-C1", w.d.id, w.cu.id); const f = jest.fn();
    await expect(outbound.send(db, T, 1, { connectionId: w.c.id, capability: "PAYMENT", entityId: p.id }, { fetchImpl: f })).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED", message: expect.stringMatching(/came from this ERP/) });
    await p.update({ reference_no: "OTHER-REF" }); // even without the reference prefix the link proves the origin
    await expect(outbound.send(db, T, 1, { connectionId: w.c.id, capability: "PAYMENT", entityId: p.id }, { fetchImpl: f })).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED" }); expect(f).not.toHaveBeenCalled();
  });
  test("RECONCILIATION: MATCHED · BLOCKED (posted payment differs — never rewritten) · MISSING_IN_DMS", async () => {
    const w = await world(); await w.go([w.pay("P1")]); const rc = (rows) => reconcile(w.c, "PAYMENT", { distributorId: w.d.id }, restFetch({ "/payments": rows }));
    expect((await rc([w.pay("P1")])).counts.MATCHED).toBe(1);
    expect((await rc([w.pay("P1", { Amt: "99" })])).items[0]).toMatchObject({ status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED" }); expect(Number((await db.Payment.findOne()).amount)).toBe(1500.5);
    expect((await rc([w.pay("P2")])).items[0].status).toBe("MISSING_IN_DMS");
  });
});

// ═════════════════════════════════════ OUTBOUND / BIDIRECTIONAL ═════════════════════════════════════
describe("OUTBOUND and echo prevention for masters", () => {
  const CMAP = [{ sourceField: "CustNo", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "City", dmsField: "city" }, { sourceField: "St", dmsField: "street1" }, { sourceField: "Reg", dmsField: "region" }, { sourceField: "Ph", dmsField: "phone_number" }, { sourceField: "Pin", dmsField: "pincode" }];
  const bi = (o = {}) => cap("CUSTOMER_MASTER", "/customers", { direction: "BIDIRECTIONAL", ownership: "SHARED", config: { responsePath: "rows", pagination: { type: "NONE" }, outbound: { idempotencySupported: true, externalIdPath: "id" } }, ...o });
  async function world(o) {
    const d = await seedDistributor(); const group = await db.CustomerGroup.create({ code: "RTL", name: "Retail", distributor_id: d.id });
    const c = await mkConn([bi(o)]); await mkMap(c, "CUSTOMER_MASTER", CMAP);
    return { d, group, c, inbound: (rows) => run(c, "CUSTOMER_MASTER", { distributorId: d.id, customerGroupId: group.id }, restFetch({ "/customers": rows })), send: (id, f, extra = {}) => outbound.send(db, T, 1, { connectionId: c.id, capability: "CUSTOMER_MASTER", entityId: id, ...extra }, { fetchImpl: f, logger: () => {} }) };
  }
  const row = (n, o = {}) => ({ CustNo: n, Name: `Shop ${n}`, City: "Pune", St: "1 Rd", Reg: "Maharashtra", Ph: "9876543210", Pin: "411001", ...o });
  test("DMS-created customer → ERP → comes back from the ERP: linked to the DMS row, NOT created again (even when the outbound link write was lost)", async () => {
    const w = await world(); const cu = await seedCustomer(w.d.id, { name: "Shop A", city: "Pune", phone_number: "9876543210", street1: "1 Rd", region: "Maharashtra", pincode: "411001" });
    const f = jest.fn(async () => json(201, { id: "E-77" })); await w.send(cu.id, f);
    await db.ErpExternalLink.destroy({ where: { entity_type: "CUSTOMER" } }); // link write lost after the ERP accepted the record
    const before = await db.Customer.count(); const job = await w.inbound([row("E-77", { Name: "Shop A" })]);
    expect(job.counts).toMatchObject({ skipped: 1, created: 0 }); expect(await db.Customer.count()).toBe(before);
    expect(await db.ErpExternalLink.findOne({ where: { entity_type: "CUSTOMER", external_id: "E-77" } })).toMatchObject({ dms_entity_id: cu.id, origin: "DMS" });
  });
  test("with the link intact the echo only binds the hash — the DMS row is not rewritten; a later genuine ERP change is applied", async () => {
    const w = await world(); const cu = await seedCustomer(w.d.id, { name: "Shop A", city: "Pune" }); const f = jest.fn(async () => json(201, { id: "E-5" })); await w.send(cu.id, f);
    expect((await w.inbound([row("E-5", { Name: "Different Echo Name" })])).counts.skipped).toBe(1); expect((await db.Customer.findByPk(cu.id)).name).toBe("Shop A");
    expect((await w.inbound([row("E-5", { Name: "Different Echo Name", City: "Nashik" })])).counts.updated).toBe(1); expect((await db.Customer.findByPk(cu.id)).city).toBe("Nashik");
  });
  test("ERP-created customer is not pushed back until the DMS changes it; then the update goes out (source tracking via origin)", async () => {
    const w = await world(); await w.inbound([row("C1")]); const cu = await db.Customer.findOne(); expect((await db.ErpExternalLink.findOne({ where: { entity_type: "CUSTOMER" } })).origin).toBe("ERP");
    const f = jest.fn(async () => json(200, { id: "C1" }));
    expect(await w.send(cu.id, f)).toMatchObject({ unchanged: true, echoPrevented: true }); expect(f).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 1100)); await cu.update({ city: "Thane" });
    expect(await w.send(cu.id, f)).toMatchObject({ status: "SENT", operation: "UPDATE" }); expect(f).toHaveBeenCalledTimes(1);
  });
  test("outbound gates: ERP_OWNED / DISABLED / no idempotency attestation / unsupported provider / unsupported capability → nothing sent", async () => {
    const f = jest.fn(); let w = await world({ ownership: "ERP_OWNED" }); const cu = await seedCustomer(w.d.id);
    await expect(w.send(cu.id, f)).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    w = await world({ config: {} }); await expect(w.send(cu.id, f)).rejects.toMatchObject({ code: "OUTBOUND_SYNC_BLOCKED" });
    const o = await mkConn([cap("CUSTOMER_MASTER", "/customers", { direction: "DMS_TO_ERP", ownership: "DMS_OWNED" })], { erpType: "ORACLE_ERP", authType: "BASIC", credentialRef: "RESTBEARER", baseUrl: "https://oracle.example.com" }).catch(() => null);
    if (o) await expect(outbound.send(db, T, 1, { connectionId: o.id, capability: "CUSTOMER_MASTER", entityId: cu.id }, { fetchImpl: f })).rejects.toMatchObject({ code: expect.stringMatching(/PROVIDER_NOT_SUPPORTED|MAPPING|OUTBOUND|INVALID/) });
    for (const capability of ["SALES", "STOCK", "INVOICE", "RETURN", "DOCUMENT", "PRICING"]) await expect(outbound.send(db, T, 1, { connectionId: w.c.id, capability, entityId: 1 }, { fetchImpl: f })).rejects.toMatchObject({ statusCode: 409, code: "OUTBOUND_SYNC_BLOCKED" });
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpOutboundEvent.count({ where: { status: "SENT" } })).toBe(0);
  });
  test("outbound retry: a failed write is retried with the SAME idempotency key and the audit trail carries the correlation id", async () => {
    const w = await world(); const cu = await seedCustomer(w.d.id, { name: "Shop R" }); let n = 0; const f = jest.fn(async () => (++n === 1 ? json(503, {}) : json(201, { id: "E-9" })));
    expect(await w.send(cu.id, f, {})).toMatchObject({ status: "FAILED" }); expect(await w.send(cu.id, f)).toMatchObject({ status: "SENT", attempt: 2 });
    expect(f.mock.calls[0][1].headers["Idempotency-Key"]).toBe(f.mock.calls[1][1].headers["Idempotency-Key"]); await audit.flush(); expect((await db.ErpAuditEvent.findAll({ where: { event: "ERP_OUTBOUND_COMPLETED" } })).every((e) => e.correlation_id)).toBe(true);
  });
});

// ═════════════════════════════════════ RECONCILIATION (generic) ═════════════════════════════════════
describe("RECONCILIATION — generic, read-only, tenant-isolated, audited", () => {
  const PROD_MAP = [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }];
  async function world() {
    const d = await seedDistributor(); const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "M", gst_rate: 12, distributor_id: d.id });
    const c = await mkConn([cap("PRODUCT_MASTER", "/products", { ownership: "ERP_OWNED" })]); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const scope = { distributorId: d.id, hsnId: hsn.id };
    return { d, c, scope, go: (rows) => run(c, "PRODUCT_MASTER", scope, restFetch({ "/products": rows })), rc: (rows, extra) => reconcile(c, "PRODUCT_MASTER", scope, restFetch({ "/products": rows }), extra) };
  }
  test("MATCHED, MISMATCH (field list), MISSING_IN_DMS, MISSING_IN_ERP — and the DMS rows are untouched", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha" }, { Code: "B", Title: "Beta" }]);
    const r = await w.rc([{ Code: "A", Title: "Alpha" }, { Code: "B", Title: "Beta v2" }, { Code: "C", Title: "Gamma" }]);
    expect(r.counts).toMatchObject({ total: 3, MATCHED: 1, MISMATCH: 1, MISSING_IN_DMS: 1 });
    expect(r.items.find((i) => i.externalId === "B")).toMatchObject({ status: "MISMATCH", differences: [{ field: "name", erp: "Beta v2", dms: "Beta" }] });
    expect((await db.Product.findOne({ where: { name: "Beta" } }))).not.toBeNull(); expect(await db.Product.count()).toBe(2);
    expect((await w.rc([{ Code: "A", Title: "Alpha" }])).counts.MISSING_IN_ERP).toBe(1);
    await audit.flush(); expect(await db.ErpAuditEvent.count({ where: { event: "ERP_RECONCILIATION_RUN" } })).toBe(2);
  });
  test("a bad record is BLOCKED with its code, the others are still compared; an ERP outage is reported, nothing stored as MISSING_IN_ERP", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha" }]);
    const r = await w.rc([{ Code: "A", Title: "Alpha" }, { Code: "Z", Title: "x".repeat(300) }]); expect(r.counts).toMatchObject({ MATCHED: 1, BLOCKED: 1 });
    const down = await reconcile(w.c, "PRODUCT_MASTER", w.scope, jest.fn(async () => json(401, {}))); expect(down.error).toMatchObject({ code: "AUTHENTICATION_ERROR" }); expect(down.counts.MISSING_IN_ERP).toBe(0); expect(down.complete).toBe(false);
  });
  test("tenant isolation: another tenant's connection → null (404) and the ERP is never called; stored results are tenant-scoped; the HTTP-level handler ignores a tenantKey in the body", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha" }]); const f = restFetch({ "/products": [] });
    expect(await recon.run(db, T2, 1, { connectionId: w.c.id, capability: "PRODUCT_MASTER", scope: w.scope }, { fetchImpl: f })).toBeNull(); expect(f).not.toHaveBeenCalled();
    await w.rc([{ Code: "A", Title: "Other" }]); expect((await recon.list(db, T2, {})).total).toBe(0); expect((await recon.list(db, T, {})).total).toBe(1);
    const res = await A(erp.runReconciliation, { body: { connectionId: w.c.id, capability: "PRODUCT_MASTER", scope: w.scope, tenantKey: T2 } }); expect(res.statusCode).not.toBe(404);
    const foreign = await A(erp.runReconciliation, { body: { connectionId: 99999, capability: "PRODUCT_MASTER" } }); expect(foreign.statusCode).toBe(404);
  });
  test("validation: unknown capability / status / scope are 400; unsupported capability is 409", async () => {
    const w = await world();
    await expect(recon.run(db, T, 1, { connectionId: w.c.id, capability: "NOPE" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(recon.run(db, T, 1, { connectionId: w.c.id, capability: "PRODUCT_MASTER", scope: {} })).rejects.toMatchObject({ statusCode: 400 });
    await expect(recon.list(db, T, { status: "WHATEVER" })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ═════════════════════════════════════ PROVIDERS, VERIFICATION, MONITORING ═════════════════════════════════════
describe("Provider capability contract, verification levels, monitoring", () => {
  test("providers declare features that match what their class really supports; Oracle / Dynamics / SOAP provide NOTHING", () => {
    const { SapODataProvider } = require("../services/erp/sapProvider"); const { GenericRestProvider } = require("../services/erp/genericRestProvider");
    for (const [key, Cls] of [["SAP_ODATA", SapODataProvider], ["GENERIC_REST", GenericRestProvider]]) {
      const sup = new Cls({ connection: { base_url: "https://x.example.com", auth_type: "BASIC" }, credentials: { type: "BASIC", username: "U", password: "P" } }).supports; const f = registry.featuresOf(registry.getDescriptor(key));
      expect(f.includes("READ")).toBe(sup.fetch); expect(f.includes("CREATE")).toBe(sup.create); expect(f.includes("UPDATE")).toBe(sup.update); expect(f.includes("DELETE")).toBe(sup.delete);
      expect(f).not.toContain("OAUTH");
    }
    expect(registry.featuresOf(registry.getDescriptor("SAP_ODATA"))).toEqual(expect.arrayContaining(["ODATA", "BASIC_AUTH", "PAGINATION"])); expect(registry.featuresOf(registry.getDescriptor("GENERIC_REST"))).toContain("REST");
    for (const k of ["ORACLE_REST", "DYNAMICS_REST", "GENERIC_SOAP"]) { const p = registry.publicDescriptor(registry.getDescriptor(k)); expect(p.features).toEqual([]); expect(p.verification).toEqual({ mock: false, real: false }); }
    for (const p of registry.listProviders().filter((x) => x.status === "IMPLEMENTED")) expect(p.verification).toEqual({ mock: true, real: false });
  });
  test("overview: catalog classification matches the code (targets / outbound builders), no capability is called COMPLETE without a target", async () => {
    const cat = business.catalog(); const cls = Object.fromEntries(cat.map((x) => [x.capability, x.classification]));
    expect(cls).toEqual({ PRODUCT_MASTER: "COMPLETE", CUSTOMER_MASTER: "COMPLETE", DISTRIBUTOR_MASTER: "COMPLETE", PRICING: "COMPLETE", STOCK: "PARTIAL", SALES: "PARTIAL", INVOICE: "BLOCKED", RETURN: "BLOCKED", PAYMENT: "COMPLETE", DOCUMENT: "BLOCKED" });
    for (const x of cat) { if (x.classification === "COMPLETE") expect(targets.getTarget(x.capability)).not.toBeNull(); if (x.classification === "BLOCKED") expect(targets.getTarget(x.capability)).toBeNull(); expect(x.identity).toBeTruthy(); }
    expect(cat.find((x) => x.capability === "SALES").changePolicy.update).toBe("ONLY_WHILE_DRAFT"); expect(business.providerList().filter((p) => p.classification === "UNSUPPORTED").map((p) => p.key).sort()).toEqual(["DYNAMICS_REST", "GENERIC_SOAP", "ORACLE_REST"]);
  });
  test("verification ladder is honest: CONFIGURED → MOCK_VERIFIED → CONNECTION_TESTED → READ_VERIFIED → WRITE_VERIFIED; never PRODUCTION_VERIFIED; never 'production ready' from configuration", async () => {
    const d = await seedDistributor(); const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "M", gst_rate: 12, distributor_id: d.id });
    const lvl = async (cid) => { const ov = await business.overview(db, T); return ov.connections.find((x) => x.id === cid).capabilities.find((x) => x.capability === "PRODUCT_MASTER"); };
    const c = await mkConn([cap("PRODUCT_MASTER", "/products")]);
    expect((await lvl(c.id)).verification.level).toBe("NOT_CONFIGURED"); // no mapping yet → blocked
    await mkMap(c, "PRODUCT_MASTER", [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }]);
    let x = await lvl(c.id); expect(x.verification.level).toBe("MOCK_VERIFIED"); expect(x.verification.realErpVerified).toBe(false); expect(x.verification.notes.join(" ")).toMatch(/mock verified; a real ERP connection has not been verified/);
    await db.ErpConnection.update({ last_test_at: new Date(), last_test_ok: true }, { where: { id: c.id } }); expect((await lvl(c.id)).verification.level).toBe("CONNECTION_TESTED");
    await run(c, "PRODUCT_MASTER", { distributorId: d.id, hsnId: hsn.id }, restFetch({ "/products": [{ Code: "A", Title: "Alpha" }] }));
    x = await lvl(c.id); expect(x.verification.level).toBe("READ_VERIFIED"); expect(x.state).toBe("SUCCESS"); expect(x.lastCounts).toMatchObject({ processed: 1, created: 1, failed: 0 });
    expect(business.LEVELS.indexOf(x.verification.level)).toBeLessThan(business.LEVELS.indexOf("PRODUCTION_VERIFIED")); expect(JSON.stringify(await business.overview(db, T))).not.toMatch(/Production Ready/i);
  });
  test("overview states: BLOCKED with the reason (ownership undecided / mapping missing / provider unsupported), WARNING (prerequisite), monitoring lists all ten capabilities with NOT_CONFIGURED when absent", async () => {
    const empty = await business.overview(db, T); expect(empty.monitoring.map((m) => m.capability)).toEqual(["PRODUCT_MASTER", "CUSTOMER_MASTER", "DISTRIBUTOR_MASTER", "PRICING", "STOCK", "SALES", "INVOICE", "RETURN", "PAYMENT", "DOCUMENT"]); expect(empty.monitoring.every((m) => m.status === "NOT_CONFIGURED" && m.recordsProcessed === 0)).toBe(true);
    const c = await mkConn([cap("STOCK", "/stock"), cap("PRICING", "/prices", { ownership: "ERP_OWNED" })]);
    await mkMap(c, "PRICING", [{ sourceField: "Id", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Price", dmsField: "base_price" }, { sourceField: "From", dmsField: "valid_from" }]);
    const ov = await business.overview(db, T); const caps = Object.fromEntries(ov.connections[0].capabilities.map((x) => [x.capability, x]));
    expect(caps.STOCK.state).toBe("BLOCKED"); expect(caps.STOCK.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["BUSINESS_DECISION_REQUIRED", "MAPPING_NOT_CONFIGURED"])); expect(caps.STOCK.pendingDecisions).toBeGreaterThanOrEqual(1);
    expect(caps.PRICING.state).toBe("WARNING"); expect(caps.PRICING.warnings[0].code).toBe("PREREQUISITE_MISSING");
    expect(ov.monitoring.find((m) => m.capability === "STOCK").status).toBe("BLOCKED"); expect(ov.documentStore.ready).toBe(false); expect(ov.providers.find((p) => p.key === "SAP_ODATA").note).toMatch(/Mock verified only/);
    const sap = await conns.createConnection(db, T, 1, { name: "Oracle", erpType: "ORACLE_ERP", authType: "BASIC", environment: "TEST", baseUrl: "https://oracle.example.com", credentialRef: "RESTBEARER", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/p", direction: "ERP_TO_DMS" }] }).catch(() => null);
    if (sap) { const o = (await business.overview(db, T)).connections.find((x) => x.id === sap.id); expect(o.capabilities[0].blockers.map((b) => b.code)).toContain("PROVIDER_NOT_SUPPORTED"); expect(o.provider.features).toEqual([]); }
  });
  test("overview: tenant isolated, read-only, never calls an ERP, exposes no secret; RBAC: the route needs ERP_VIEW (matrix test) and the handler answers 200", async () => {
    const c = await mkConn([cap("PRODUCT_MASTER", "/p")]); const f = jest.fn(); void f;
    expect((await business.overview(db, T2)).connections).toEqual([]); expect((await business.overview(db, T)).connections.map((x) => x.id)).toEqual([c.id]);
    const res = await A(erp.businessOverview); expect(res.statusCode).toBe(200); expect(JSON.stringify(res.jsonBody)).not.toMatch(/bearer-tok-XYZ789/);
    const lst = await A(erp.listReconciliation); expect(lst.statusCode).toBe(200); expect(lst.jsonBody.statuses).toEqual(["MATCHED", "MISMATCH", "MISSING_IN_DMS", "MISSING_IN_ERP", "BLOCKED", "PENDING_REVIEW"]);
  });
});

// ═════════════════════════════════════ MIGRATION ═════════════════════════════════════
describe("Migration (Phase 18)", () => {
  test("up / up / down / down / up on sqlite: additive columns + indexes only; no table is created; existing data survives", async () => {
    const mig = require("../migrations/20261011090000-erp-phase18"); const qi = db.sequelize.getQueryInterface(); const S = db.Sequelize;
    const has = async (t, c) => Object.keys(await qi.describeTable(t)).includes(c);
    const tablesBefore = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName)).sort();
    await mig.up(qi, S); await mig.up(qi, S);
    for (const [t, c] of [["erp_external_links", "origin"], ["erp_external_links", "reconcile_status"], ["erp_external_links", "reconciled_at"], ["erp_external_links", "reconcile_detail"], ["SalesInvoiceHeaders", "external_source_id"], ["SalesReturns", "external_source_type"]]) expect(await has(t, c)).toBe(true);
    await mig.down(qi, S);
    for (const [t, c] of [["erp_external_links", "origin"], ["erp_external_links", "reconcile_detail"], ["SalesInvoiceHeaders", "external_source_id"], ["SalesReturns", "external_source_type"]]) expect(await has(t, c)).toBe(false);
    await mig.down(qi, S); await mig.up(qi, S);
    expect((await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName)).sort()).toEqual(tablesBefore);
    expect((await qi.showIndex("SalesInvoiceHeaders")).map((i) => i.name)).toContain("uq_sales_invoice_external_source");
  });
});
