// Phase 19 — mapping preflight, reconciliation missing-record handling, document-store failure behaviour, decision register, invoice/return blocked-state guarantees.
// Same convention as Phases 14–18: in-memory sqlite, direct service calls, MOCK transports only. A mocked 200 proves OUR handling, never real ERP connectivity.
const fs = require("fs");
const path = require("path");
const { db, resetDb, seedDistributor, seedProduct, seedBatch, seedCustomer, seedGLAccounts } = require("./helpers");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const recon = require("../services/erpReconciliation.service");
const business = require("../services/erpBusiness.service");
const docs = require("../services/erpDocumentStore.service");
const outbound = require("../services/erpOutbound.service");
const audit = require("../services/erpAudit.service");
const preflightLib = require("../services/erp/sync/mappingPreflight");
const targets = require("../services/erp/sync/targets");

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
const expectApiError = async (p, status, code) => { try { await p; } catch (e) { expect(e).toMatchObject({ statusCode: status, code }); return e; } throw new Error("expected an ErpApiError"); };
// inserts a mapping set WITHOUT saveMappings' own validation (simulates an old / hand-edited configuration)
const rawMap = (c, capability, rows) => db.ErpEntityMapping.bulkCreate(rows.map((r) => ({ connection_id: c.id, capability, dms_entity: "X", source_entity: "", source_field: r.source, dms_field: r.dms, is_key: Boolean(r.key), transform: null })));

// ═════════════════════════════ MAPPING PREFLIGHT ═════════════════════════════
describe("MAPPING PREFLIGHT — capability-specific, field-level, no invented defaults", () => {
  const row = (dms, source = "S", key = false) => ({ dms_field: dms, source_field: source, is_key: key });

  test("pure evaluator: key, source paths, writable fields and required fields each produce a field-level blocker with a stable rule id", () => {
    const t = targets.getTarget("PRICING");
    expect(preflightLib.evaluate({ capability: "PRICING", target: t, mappings: [] }).blockers.map((b) => b.rule)).toEqual(["KEY_MISSING", "REQUIRED_FIELD_UNMAPPED", "REQUIRED_FIELD_UNMAPPED", "REQUIRED_FIELD_UNMAPPED"]);
    const r = preflightLib.evaluate({ capability: "PRICING", target: t, mappings: [row("external_id", "", true), row("product_external_id"), row("base_price", ""), row("bogus_field")] });
    expect(r.ok).toBe(false);
    expect(r.blockers.map((b) => `${b.rule}:${b.field}`).sort()).toEqual(["FIELD_NOT_WRITABLE:bogus_field", "KEY_SOURCE_EMPTY:external_id", "REQUIRED_FIELD_UNMAPPED:base_price", "REQUIRED_FIELD_UNMAPPED:valid_from", "SOURCE_EMPTY:base_price"].sort());
    expect(r.blockers.every((b) => b.code === "MAPPING_NOT_CONFIGURED" && b.message.length > 10)).toBe(true);
    const ok = preflightLib.evaluate({ capability: "PRICING", target: t, mappings: [row("external_id", "K", true), row("product_external_id"), row("base_price"), row("valid_from")] });
    expect(ok).toMatchObject({ ok: true, blockers: [] });
  });

  test("every registered target: a mapping of exactly its required fields (+ key) passes the static rules (compatibility with what saveMappings has always required)", () => {
    for (const [cap, t] of Object.entries(targets.TARGETS)) {
      const maps = [row("external_id", "K", true), ...t.requiredFields.map((f) => row(f))];
      const staticOnly = preflightLib.evaluate({ capability: cap, target: t, mappings: maps, scopeKnown: false });
      expect({ cap, ok: staticOnly.ok, blockers: staticOnly.blockers }).toEqual({ cap, ok: true, blockers: [] });
    }
  });

  test("a stale hand-edited mapping (required field missing) is refused BEFORE a job exists and before any ERP call; the error carries the field-level blockers", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("PRICING", "/price")]);
    const grp = await db.CustomerGroup.create({ name: "G", code: "G1", distributor_id: d.id });
    await rawMap(c, "PRICING", [{ source: "Id", dms: "external_id", key: true }, { source: "Mat", dms: "product_external_id" }, { source: "Price", dms: "base_price" }]); // valid_from missing
    const f = restFetch({ "/price": [] });
    const e = await expectApiError(run(c, "PRICING", { distributorId: d.id, customerGroupId: grp.id }, f), 409, "MAPPING_NOT_CONFIGURED");
    expect(e.details.blockers).toEqual([expect.objectContaining({ rule: "REQUIRED_FIELD_UNMAPPED", field: "valid_from" })]);
    expect(e.message).toMatch(/valid_from/);
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpSyncJob.count()).toBe(0);
  });

  test("the Phase 14 error for 'no key mapping' keeps its code and wording and still takes precedence over a scope error", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("PRODUCT_MASTER", "/p")]);
    const e = await expectApiError(run(c, "PRODUCT_MASTER", {}, restFetch({})), 409, "MAPPING_NOT_CONFIGURED");
    expect(e.message).toBe("No field mapping (with a key field) is configured for this ERP and capability."); expect(d.id).toBeTruthy();
  });

  test("PAYMENT without any payment-mode source (no mapped field, no default) is refused up front; a default mode or a mapped field lifts it", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("PAYMENT", "/pay", { ownership: "ERP_OWNED" })]);
    await mkMap(c, "PAYMENT", [{ sourceField: "Id", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "payment_date" }, { sourceField: "Amt", dmsField: "amount", transform: ["to_number"] }]);
    const f = restFetch({ "/pay": [] });
    const e = await expectApiError(run(c, "PAYMENT", { distributorId: d.id }, f), 409, "MAPPING_NOT_CONFIGURED");
    expect(e.details.blockers).toEqual([expect.objectContaining({ rule: "PAYMENT_MODE_UNDEFINED", field: "mode" })]); expect(f).not.toHaveBeenCalled();
    expect((await run(c, "PAYMENT", { distributorId: d.id, defaultMode: "BANK_TRANSFER" }, f)).status).toBe("SUCCESS");
    await mkMap(c, "PAYMENT", [{ sourceField: "Id", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "payment_date" }, { sourceField: "Amt", dmsField: "amount", transform: ["to_number"] }, { sourceField: "Mode", dmsField: "mode" }]);
    expect((await run(c, "PAYMENT", { distributorId: d.id }, f)).status).toBe("SUCCESS");
  });

  test("SALES without a payment-terms source is refused up front; default terms lift it", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("SALES", "/so", { ownership: "ERP_OWNED" })]);
    await mkMap(c, "SALES", [{ sourceField: "Id", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "order_date" }, { sourceField: "Items[].Mat", dmsField: "lines.product_external_id" }, { sourceField: "Items[].Qty", dmsField: "lines.quantity" }]);
    const f = restFetch({ "/so": [] });
    const e = await expectApiError(run(c, "SALES", { distributorId: d.id }, f), 409, "MAPPING_NOT_CONFIGURED");
    expect(e.details.blockers.map((b) => b.rule)).toEqual(["PAYMENT_TERMS_UNDEFINED"]); expect(f).not.toHaveBeenCalled();
    expect((await run(c, "SALES", { distributorId: d.id, defaultPaymentTerms: "CREDIT" }, f)).status).toBe("SUCCESS");
  });

  test("data-dependent prerequisites are WARNINGS, never blockers: STOCK with no warehouse mapping and no batches still starts (Phase 16 behaviour preserved)", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("STOCK", "/st", { ownership: "ERP_OWNED" })]);
    await mkMap(c, "STOCK", [{ sourceField: "Id", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Plant", dmsField: "plant_code" }, { sourceField: "Batch", dmsField: "batch_no" }, { sourceField: "Qty", dmsField: "quantity", transform: ["to_number"] }]);
    const conn = await sync.loadConnection(db, T, c.id);
    const pf = await sync.preflight(db, conn, "STOCK", { distributorId: d.id });
    expect(pf.warnings.map((w) => w.rule).sort()).toEqual(["NO_DMS_BATCHES", "PRODUCT_NOT_SYNCED", "WAREHOUSE_MAPPING_MISSING"]);
    expect((await run(c, "STOCK", { distributorId: d.id }, restFetch({ "/st": [] }))).status).toBe("SUCCESS");
  });

  test("the dashboard overview reports the SAME field-level blockers (shared evaluator), and no invented default appears anywhere", async () => {
    const d = await seedDistributor(); const c = await mkConn([cap("PRICING", "/price")]); expect(d.id).toBeTruthy();
    await rawMap(c, "PRICING", [{ source: "Id", dms: "external_id", key: true }, { source: "Mat", dms: "product_external_id" }]);
    const ov = await business.overview(db, T); const p = ov.connections[0].capabilities.find((x) => x.capability === "PRICING");
    expect(p.state).toBe("BLOCKED");
    const msgs = p.blockers.filter((b) => b.code === "MAPPING_NOT_CONFIGURED").map((b) => b.message);
    expect(msgs.some((m) => /base_price/.test(m))).toBe(true); expect(msgs.some((m) => /valid_from/.test(m))).toBe(true);
  });
});

// ═════════════════════════════ RECONCILIATION — missing-record handling ═════════════════════════════
describe("RECONCILIATION — a record the ERP still returns is never reported as MISSING_IN_ERP", () => {
  const MAP = [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }, { sourceField: "Price", dmsField: "mrp", transform: ["to_number"] }];
  async function world() {
    const d = await seedDistributor(); const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "M", gst_rate: 12, distributor_id: d.id });
    const c = await mkConn([cap("PRODUCT_MASTER", "/products", { ownership: "ERP_OWNED" })]); await mkMap(c, "PRODUCT_MASTER", MAP);
    const scope = { distributorId: d.id, hsnId: hsn.id };
    return { d, c, scope, go: (rows) => run(c, "PRODUCT_MASTER", scope, restFetch({ "/products": rows })), rc: (rows, extra) => reconcile(c, "PRODUCT_MASTER", scope, restFetch({ "/products": rows }), extra) };
  }
  test("a linked record whose mapping fails this time (bad number) is BLOCKED with its external id — not 'no longer returned by the ERP'", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha", Price: 10 }, { Code: "B", Title: "Beta", Price: 20 }]);
    const r = await w.rc([{ Code: "A", Title: "Alpha", Price: "abc" }]); // B is genuinely gone, A is present but unmappable
    expect(r.complete).toBe(true);
    expect(r.counts).toMatchObject({ total: 2, BLOCKED: 1, MISSING_IN_ERP: 1 });
    expect(r.items.find((i) => i.externalId === "A")).toMatchObject({ status: "BLOCKED", code: "MAPPING_ERROR" });
    expect(r.items.find((i) => i.externalId === "B")).toMatchObject({ status: "MISSING_IN_ERP" });
    const la = await db.ErpExternalLink.findOne({ where: { external_id: "A" } }); expect(la.reconcile_status).not.toBe("MISSING_IN_ERP");
  });
  test("nothing is written to business data by any of these runs", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha", Price: 10 }]);
    const before = JSON.stringify(await db.Product.findAll({ raw: true, order: [["id", "ASC"]] }));
    await w.rc([{ Code: "A", Title: "Alpha", Price: "abc" }]); await w.rc([]); await w.rc([{ Code: "A", Title: "Changed", Price: 99 }]);
    expect(JSON.stringify(await db.Product.findAll({ raw: true, order: [["id", "ASC"]] }))).toBe(before);
  });
  test("bounded: more records than maxRecords ⇒ truncated, complete=false, no MISSING_IN_ERP; correlation id is carried into the result and the audit event", async () => {
    const w = await world(); await w.go([{ Code: "A", Title: "Alpha", Price: 1 }, { Code: "B", Title: "Beta", Price: 2 }]);
    const r = await w.rc([{ Code: "A", Title: "Alpha", Price: 1 }, { Code: "Z", Title: "Zed", Price: 3 }], { limits: { maxRecords: 1 }, correlationId: "cid-19-recon" });
    expect(r).toMatchObject({ truncated: true, complete: false, correlationId: "cid-19-recon" }); expect(r.counts.MISSING_IN_ERP).toBe(0);
    await audit.flush(); const ev = await db.ErpAuditEvent.findOne({ where: { event: "ERP_RECONCILIATION_RUN" }, order: [["id", "DESC"]] }); expect(JSON.stringify(ev.get({ plain: true }))).toMatch(/cid-19-recon/);
  });
  test("tenant isolation: another tenant cannot reconcile this connection (null → 404) and the ERP is not called", async () => {
    const w = await world(); const f = restFetch({ "/products": [] });
    expect(await recon.run(db, T2, 1, { connectionId: w.c.id, capability: "PRODUCT_MASTER", scope: w.scope }, { fetchImpl: f })).toBeNull(); expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════ DOCUMENT STORE — failure behaviour ═════════════════════════════
describe("DOCUMENT STORE — fails closed, reports BUSINESS_DECISION_REQUIRED, never touches ./uploads", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("x".repeat(64))]);
  const doc = (o = {}) => ({ tenantKey: T, distributorId: 7, externalDocumentId: "DOC-1", filename: "invoice.pdf", contentType: "application/pdf", buffer: pdf, ...o });
  const approved = () => { const store = docs.createMemoryStore(); docs.setDocumentStore(store); docs.setMalwareScanner(async () => ({ clean: true })); return store; };

  test("no store / no scanner ⇒ BUSINESS_DECISION_REQUIRED, nothing stored; readiness never says ready", async () => {
    await expect(docs.ingest(doc())).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" });
    const none = docs.readiness(); expect(none.ready).toBe(false); expect(none.status).toBe("BUSINESS_DECISION_REQUIRED");
    expect(none.requiredDecisions.map((d) => d.id).sort()).toEqual(["malwareScanner", "retention", "storageProvider"]);
    expect(none.requiredDecisions.every((d) => d.status === "REQUIRED")).toBe(true);
    const store = docs.createMemoryStore(); docs.setDocumentStore(store);
    await expect(docs.ingest(doc())).rejects.toMatchObject({ code: "BUSINESS_DECISION_REQUIRED" }); expect(store.size()).toBe(0);
    // registering an adapter in code is NOT a business approval: the decision is reported as technically registered, retention stays REQUIRED
    const some = docs.readiness(); expect(some.status).toBe("BUSINESS_DECISION_REQUIRED");
    expect(some.requiredDecisions.find((d) => d.id === "storageProvider").status).toBe("TECHNICALLY_REGISTERED");
    expect(some.requiredDecisions.find((d) => d.id === "retention").status).toBe("REQUIRED");
  });
  test("even with an adapter and scanner registered, readiness stays BLOCKED: no document record, access authorisation, audit or retention exist", () => {
    approved(); const r = docs.readiness();
    expect(r.ready).toBe(false); expect(r.missing).toEqual(expect.arrayContaining(["externalDocumentId", "accessAuthorization", "audit", "retention"]));
  });
  test("a scanner that throws fails CLOSED with a typed error and nothing is stored; a scanner verdict that is not exactly clean:true is a rejection", async () => {
    const store = docs.createMemoryStore(); docs.setDocumentStore(store);
    docs.setMalwareScanner(async () => { throw new Error("scanner down: secret-token-123"); });
    const e = await docs.ingest(doc()).catch((x) => x); expect(e).toMatchObject({ code: "CONNECTION_ERROR", stage: "SCAN" }); expect(String(e.message)).not.toMatch(/secret-token/); expect(store.size()).toBe(0);
    for (const v of [undefined, null, {}, { clean: "true" }, { clean: false }]) { docs.setMalwareScanner(async () => v); await expect(docs.ingest(doc())).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); }
    expect(store.size()).toBe(0);
  });
  test("a store that throws on put/exists fails with a typed error that does not leak the adapter's message", async () => {
    docs.setMalwareScanner(async () => ({ clean: true }));
    docs.setDocumentStore({ tenantIsolated: true, exists: async () => false, get: async () => null, delete: async () => {}, put: async () => { throw new Error("disk /var/secret/path full"); } });
    const e = await docs.ingest(doc()).catch((x) => x); expect(e).toMatchObject({ code: "CONNECTION_ERROR", stage: "STORE" }); expect(String(e.message)).not.toMatch(/secret\/path/);
    docs.setDocumentStore({ tenantIsolated: true, exists: async () => { throw new Error("db password=hunter2"); }, get: async () => null, delete: async () => {}, put: async () => {} });
    const e2 = await docs.ingest(doc()).catch((x) => x); expect(e2).toMatchObject({ code: "CONNECTION_ERROR", stage: "STORE" }); expect(String(e2.message)).not.toMatch(/hunter2/);
  });
  test("validation: executable / HTML / SVG / mismatching magic bytes / oversize / traversal names are refused; storage keys are tenant + distributor scoped; duplicates are stored once", async () => {
    const store = approved();
    for (const bad of [{ contentType: "text/html", filename: "a.html", buffer: Buffer.from("<script>") }, { contentType: "image/svg+xml", filename: "a.svg", buffer: Buffer.from("<svg>") }, { contentType: "application/pdf", filename: "a.pdf", buffer: Buffer.from("MZ not a pdf") }, { contentType: "application/pdf", filename: "a.exe", buffer: pdf }]) {
      await expect(docs.ingest(doc(bad))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const ok = await docs.ingest(doc({ filename: "../../etc/passwd.pdf" })); expect(ok.key).toBe(`tenants/${T}/distributors/7/${ok.key.split("/")[4]}/passwd.pdf`); expect(ok.key).not.toMatch(/\.\./);
    const again = await docs.ingest(doc({ filename: "../../etc/passwd.pdf" })); expect(again.duplicate).toBe(true); expect(store.size()).toBe(1);
    await expect(docs.ingest(doc({ tenantKey: "../other" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(docs.storageKey({ tenantKey: T, distributorId: 7, externalDocumentId: "X", filename: "a.pdf" })).not.toBe(docs.storageKey({ tenantKey: T2, distributorId: 7, externalDocumentId: "X", filename: "a.pdf" }));
  });
  test("the module never reads or writes the local uploads directory and DOCUMENT stays a blocked capability", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/erpDocumentStore.service.js"), "utf8");
    expect(src).not.toMatch(/require\(["']fs["']\)|require\(["']\.\.\/middleware\/upload|uploads\//);
    expect(targets.getTarget("DOCUMENT")).toBeNull(); expect(targets.getUnsupported("DOCUMENT")).toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
  });
});

// ═════════════════════════════ DECISION REGISTER · INVOICE / RETURN (still BLOCKED) ═════════════════════════════
describe("DECISION REGISTER — nothing is decided on the business's behalf", () => {
  const register = require("../services/erpDecisionRegister.service");
  test("covers every question of the Phase 19 brief, grouped by area", () => {
    const ids = register.REGISTER.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["stock.owner", "stock.openingSnapshot", "stock.batchCreation", "stock.warehouseMappingOwner", "sales.owner", "sales.autoConfirm", "sales.dmsOrderRepresentation",
      "invoice.owner", "invoice.erpAuthoritative", "invoice.deliveryMapping", "invoice.accountingReceivables", "invoice.existingInvoice", "invoice.duplicatePrevention",
      "return.owner", "return.invoiceDeliveryReference", "return.creditNote", "return.stockPosting", "return.originalMissing", "payment.autoAllocate", "pricing.manualOwner",
      "document.storageProvider", "document.malwareScanner", "document.accessRetention"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...new Set(register.REGISTER.map((r) => r.area))].sort()).toEqual(["Documents", "Invoice", "Payment", "Pricing", "Return", "Sales", "Stock"]);
    expect(register.REGISTER.every((r) => r.interim && r.blocks.length)).toBe(true);
  });
  test("with nothing configured every question is REQUIRED and no approval is recorded", () => {
    const items = register.build({}); expect(items.every((i) => i.status === "REQUIRED" && i.answer === null && i.approval === "NOT_RECORDED")).toBe(true);
    expect(register.summary(items).CONFIGURED).toBe(0);
  });
  test("only ownership questions can ever be CONFIGURED (never approved); every other question stays REQUIRED even if an ownership is set", async () => {
    await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" }), cap("STOCK", "/st", { ownership: "SHARED" }), cap("DOCUMENT", "/doc", { ownership: "ERP_OWNED" })]);
    const ov = await business.overview(db, T); const reg = ov.decisionRegister;
    const st = Object.fromEntries(reg.items.map((i) => [i.id, i.status]));
    expect(st["invoice.owner"]).toBe("CONFIGURED"); expect(st["stock.owner"]).toBe("CONFIGURED"); expect(st["return.owner"]).toBe("REQUIRED"); expect(st["sales.owner"]).toBe("REQUIRED");
    for (const id of Object.keys(st)) if (!register.REGISTER.find((r) => r.id === id && r.mechanism === "CONFIG")) expect({ id, s: st[id] }).toEqual({ id, s: "REQUIRED" });
    expect(reg.items.find((i) => i.id === "invoice.owner")).toMatchObject({ answer: ["ERP_OWNED / ERP_TO_DMS"], approval: "NOT_RECORDED" });
    expect(reg.items.find((i) => i.id === "invoice.owner").persistence).toMatch(/cannot confirm that the business approved/);
    expect(reg.summary.CONFIGURED).toBe(2);
  });
  test("the register is tenant scoped: another tenant's configuration never shows up", async () => {
    await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" })], {}, T2);
    expect((await business.overview(db, T)).decisionRegister.summary.CONFIGURED).toBe(0);
    expect((await business.overview(db, T2)).decisionRegister.summary.CONFIGURED).toBe(1);
  });
});

describe("INVOICE / RETURN remain BLOCKED with the exact missing dependencies; no bypass of accounting or inventory exists in the ERP code", () => {
  const counts = async () => ({ inv: await db.SalesInvoiceHeader.count(), ln: await db.SalesInvoiceLine.count(), je: await db.JournalEntry.count(), led: await db.StockLedger.count(), cn: await db.SalesCreditNote.count(), ret: await db.SalesReturn.count(), dl: await db.SalesDeliveryHeader.count() });
  test("INVOICE preflight names the real blockers (ownership, number/date/price/tax cannot be stored, stock-OUT delivery, accounting rule, existing invoice) and never contacts the ERP or posts anything", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/inv": [{ Id: "I1" }] }); const b = await counts();
    const c = await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" })]);
    const e = await expectApiError(run(c, "INVOICE", { distributorId: d.id }, f), 409, "BUSINESS_DECISION_REQUIRED");
    for (const re of [/ownership/i, /number, date, prices, taxes and totals/i, /stock OUT/i, /accounting rule/i, /already exists/i, /external invoice id/i]) expect(e.message).toMatch(re);
    expect(f).not.toHaveBeenCalled(); expect(await counts()).toEqual(b); expect(await db.ErpSyncJob.count()).toBe(0);
  });
  test("RETURN preflight explains the dependency on a POSTED invoice, invoice line and batch, the credit note / stock-IN transaction, and never creates an orphan return", async () => {
    const d = await seedDistributor(); const f = restFetch({ "/ret": [{ Id: "R1" }] }); const b = await counts();
    const c = await mkConn([cap("RETURN", "/ret", { ownership: "ERP_OWNED" })]);
    const e = await expectApiError(run(c, "RETURN", { distributorId: d.id }, f), 409, "CAPABILITY_NOT_SUPPORTED");
    for (const re of [/delivered DMS invoice that is POSTED/i, /invoice-line id and a batch id/i, /credit note/i, /orphan return/i, /counted twice/i]) expect(e.message).toMatch(re);
    expect(f).not.toHaveBeenCalled(); expect(await counts()).toEqual(b);
  });
  test("an ERP connection with ERP_OWNED invoices AND returns AND a matching mapping set cannot be saved or synchronised: there is no target to map to", async () => {
    const c = await mkConn([cap("INVOICE", "/inv", { ownership: "ERP_OWNED" }), cap("RETURN", "/ret", { ownership: "ERP_OWNED" })]);
    await expect(mkMap(c, "INVOICE", [{ sourceField: "Id", isKey: true }])).rejects.toMatchObject({ statusCode: 409 });
    await expect(mkMap(c, "RETURN", [{ sourceField: "Id", isKey: true }])).rejects.toMatchObject({ statusCode: 409 });
    const ov = await business.overview(db, T); for (const k of ["INVOICE", "RETURN"]) expect(ov.connections[0].capabilities.find((x) => x.capability === k)).toMatchObject({ classification: "BLOCKED", state: "BLOCKED" });
    expect(ov.catalog.filter((x) => x.classification === "BLOCKED").map((x) => x.capability).sort()).toEqual(["DOCUMENT", "INVOICE", "RETURN"]);
  });
  test("source guarantee: the ERP integration code never writes StockLedger / Batch / JournalEntry / invoices / returns / credit notes directly", () => {
    const files = ["services/erp/sync/targets.js", "services/erp/sync/syncEngine.js", "services/erp/sync/mappingPreflight.js", "services/erpOutbound.service.js", "services/erpReconciliation.service.js", "services/erpDocumentStore.service.js", "services/erpBusiness.service.js", "services/erpDecisionRegister.service.js"];
    const forbidden = /\b(StockLedger|JournalEntry|SalesInvoiceHeader|SalesInvoiceLine|SalesReturn|SalesReturnLine|SalesCreditNote|SalesDeliveryHeader)\.(create|bulkCreate|update|destroy|upsert|increment|decrement)\b|\bBatch\.(create|bulkCreate|destroy|upsert)\b/;
    for (const f of files) { const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); expect({ f, hit: forbidden.exec(src) && forbidden.exec(src)[0] }).toEqual({ f, hit: null }); }
  });
  test("the existing DMS invoice / return paths are unchanged by Phase 19 (still controller-owned, accounting posted only in salesinvoice.post / salesreturn.post)", () => {
    const inv = fs.readFileSync(path.join(__dirname, "../controllers/salesinvoice.controller.js"), "utf8"); const ret = fs.readFileSync(path.join(__dirname, "../controllers/salesreturn.controller.js"), "utf8");
    expect(inv).not.toMatch(/external_source/); expect(ret).not.toMatch(/external_source/);
    expect(inv.match(/JournalEntry\.create/g)).toHaveLength(1); expect(ret).toMatch(/postCreditNoteAccounting/); expect(ret).toMatch(/inventory\.postMovement/);
  });
});
