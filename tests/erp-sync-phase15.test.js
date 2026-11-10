// Phase 15 — ERP sync expansion (Customer / Distributor / Pricing / Payment), scheduler + worker, monitoring, error monitor.
// Same convention as Phase 14: in-memory sqlite, direct service/controller calls, and a MOCK fetch for every ERP transport.
// A mocked 200 proves OUR handling of a protocol, never real ERP connectivity (see PHASE15_DELIVERABLES.md → Real ERP verification).
const fs = require("fs");
const path = require("path");
const { db, resetDb, mockRes, seedDistributor, seedGLAccounts } = require("./helpers");
const erp = require("../controllers/admin.erp.controller");
const conns = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const sched = require("../services/erpScheduler.service");
const monitor = require("../services/erpMonitoring.service");
const targets = require("../services/erp/sync/targets");
const pricing = require("../services/pricing.service");
const adminRoutes = require("../routes/adminRoutes");
const requireAdmin = require("../middleware/adminAuth");

beforeAll(() => { Object.assign(process.env, { ERP_RESTBEARER_TOKEN: "bearer-tok-XYZ789", ERP_OTHERTOK_TOKEN: "other-tok-QQQ111", ERP_SAPPROD_USERNAME: "U", ERP_SAPPROD_PASSWORD: "P-9!" }); });
beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(async () => { await db.sequelize.close(); });

const T = "DEFAULT"; const T2 = "TENANT_B";
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) } });
const D = (fetchImpl, extra = {}) => ({ await: true, fetchImpl, logger: () => {}, retryDelayMs: 0, ...extra });
// REST mock: { "/customers": [rows…], … } → { rows }. A function value may throw / return a custom response.
const restFetch = (byPath, calls = []) => jest.fn(async (url, init) => {
  const p = new URL(url).pathname; calls.push({ url, init });
  const v = byPath[p]; if (v === undefined) return json(404, {});
  if (typeof v === "function") return v(url, init);
  return json(200, { rows: v });
});
const cap = (capability, endpointPath, direction = "ERP_TO_DMS") => ({ capability, endpointPath, direction, config: { responsePath: "rows", pagination: { type: "NONE" } } });
const ALL_CAPS = [cap("PRODUCT_MASTER", "/products"), cap("CUSTOMER_MASTER", "/customers"), cap("DISTRIBUTOR_MASTER", "/distributors"), cap("PRICING", "/prices"), cap("PAYMENT", "/payments")];
const mkConn = (o = {}, tenant = T) => conns.createConnection(db, tenant, 1, { name: "Custom ERP", erpType: "CUSTOM_ERP", authType: "BEARER_TOKEN", environment: "TEST", baseUrl: "https://custom.example.com", credentialRef: "RESTBEARER", capabilities: ALL_CAPS, ...o });
const mkMap = (c, capability, rows, tenant = T) => sync.saveMappings(db, tenant, 1, c.id, capability, { mappings: rows });
const run = (c, capability, scope, fetchImpl, extra = {}, tenant = T) => sync.startSync(db, tenant, 1, { connectionId: c.id, capability, scope }, D(fetchImpl, extra));
const lastJob = async (c, capability) => db.ErpSyncJob.findOne({ where: { connection_id: c.id, capability }, order: [["id", "DESC"]] });

async function world() {
  const d = await seedDistributor();
  const hsn = await db.HSNGroup.create({ hsn_code: "3004", description: "Medicaments", gst_rate: 12, distributor_id: d.id });
  const group = await db.CustomerGroup.create({ code: "RTL", name: "Retail", distributor_id: d.id });
  return { d, hsn, group, pScope: { distributorId: d.id, hsnId: hsn.id }, cScope: { distributorId: d.id, customerGroupId: group.id } };
}
const CUST_MAP = [{ sourceField: "CustNo", isKey: true }, { sourceField: "Name", dmsField: "name", transform: ["trim"] }, { sourceField: "Street", dmsField: "street1" }, { sourceField: "City", dmsField: "city" }, { sourceField: "State", dmsField: "region" }, { sourceField: "Phone", dmsField: "phone_number" }, { sourceField: "Pin", dmsField: "pincode" }, { sourceField: "Gstin", dmsField: "taxNumber", transform: ["uppercase"] }, { sourceField: "Active", dmsField: "status", transform: ["lowercase"] }];
const cust = (n, o = {}) => ({ CustNo: `C${n}`, Name: `Pharmacy ${n}`, Street: "1 Main Rd", City: "Pune", State: "Maharashtra", Phone: "9876543210", Pin: "411001", Gstin: "", Active: "active", ...o });
const DIST_MAP = [{ sourceField: "DistNo", isKey: true }, { sourceField: "Name", dmsField: "name" }, { sourceField: "Email", dmsField: "email", transform: ["lowercase"] }, { sourceField: "Phone", dmsField: "phone_number" }, { sourceField: "Street", dmsField: "street1" }, { sourceField: "City", dmsField: "city" }, { sourceField: "State", dmsField: "region" }, { sourceField: "Pin", dmsField: "postal_code" }, { sourceField: "Gst", dmsField: "tax_no", transform: ["uppercase"] }];
const dist = (n, o = {}) => ({ DistNo: `D${n}`, Name: `Dist ${n}`, Email: `Dist${n}@Example.com`, Phone: "9876543210", Street: "5 Park St", City: "Mumbai", State: "Maharashtra", Pin: "400001", Gst: "", ...o });
const PROD_MAP = [{ sourceField: "Code", isKey: true }, { sourceField: "Title", dmsField: "name" }];
const PRICE_MAP = [{ sourceField: "PriceId", isKey: true }, { sourceField: "Mat", dmsField: "product_external_id" }, { sourceField: "Price", dmsField: "base_price", transform: ["to_number"] }, { sourceField: "Disc", dmsField: "discount_percent", transform: ["to_number"] }, { sourceField: "From", dmsField: "valid_from", transform: ["to_date"] }, { sourceField: "To", dmsField: "valid_to", transform: ["to_date"] }];
const PAY_MAP = [{ sourceField: "PayId", isKey: true }, { sourceField: "Cust", dmsField: "customer_external_id" }, { sourceField: "Date", dmsField: "payment_date", transform: ["to_date"] }, { sourceField: "Amt", dmsField: "amount", transform: ["to_number"] }, { sourceField: "Mode", dmsField: "mode", transform: ["uppercase"] }, { sourceField: "Ref", dmsField: "reference_no" }];

// ═════════════════════════════════════ CUSTOMER_MASTER ═════════════════════════════════════
describe("Customer master → existing Customer (retailer) model", () => {
  test("no mapping → MAPPING_NOT_CONFIGURED and the ERP is never contacted; the admin must choose distributor + group (no guessing)", async () => {
    const w = await world(); const c = await mkConn(); const f = restFetch({ "/customers": [cust(1)] });
    await expect(run(c, "CUSTOMER_MASTER", w.cScope, f)).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIGURED" });
    await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await expect(run(c, "CUSTOMER_MASTER", {}, f)).rejects.toMatchObject({ statusCode: 400 });
    const other = await seedDistributor(); const og = await db.CustomerGroup.create({ code: "X", name: "X", distributor_id: other.id });
    await expect(run(c, "CUSTOMER_MASTER", { distributorId: w.d.id, customerGroupId: og.id }, f)).rejects.toMatchObject({ statusCode: 400 }); // group of another distributor
    expect(f).not.toHaveBeenCalled();
  });
  test("a required mapping is enforced per target (customer needs a name mapping)", async () => {
    const c = await mkConn();
    await expect(mkMap(c, "CUSTOMER_MASTER", [{ sourceField: "CustNo", isKey: true }, { sourceField: "City", dmsField: "city" }])).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Business name/) });
  });
  test("create → code generated by the DMS, owner + group from the scope, status active; DMS-only fields cannot be mapped", async () => {
    const w = await world(); const c = await mkConn();
    await expect(mkMap(c, "CUSTOMER_MASTER", [...CUST_MAP, { sourceField: "Limit", dmsField: "credit_limit" }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(mkMap(c, "CUSTOMER_MASTER", [...CUST_MAP, { sourceField: "Grp", dmsField: "customer_group_id" }])).rejects.toMatchObject({ statusCode: 400 });
    await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    const job = await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Gstin: "27abcde1234f1z5" }), cust(2)] }));
    expect(job).toMatchObject({ status: "SUCCESS", counts: { created: 2, failed: 0 } });
    const rows = await db.Customer.findAll({ order: [["id", "ASC"]] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Pharmacy 1", distributor_id: w.d.id, customer_group_id: w.group.id, status: "active", taxNumber: "27ABCDE1234F1Z5", pincode: "411001" });
    expect(rows[0].customer_code).toMatch(/^CTR/);
    expect(await db.ErpExternalLink.count({ where: { entity_type: "CUSTOMER", connection_id: c.id } })).toBe(2);
  });
  test("update changes ERP-owned fields only; unchanged records are SKIPPED; DMS-only fields (credit limit, group, code, shipping) are preserved", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1)] }));
    const row = await db.Customer.findOne(); const g2 = await db.CustomerGroup.create({ code: "WS", name: "Wholesale", distributor_id: w.d.id });
    await row.update({ credit_limit: 50000, customer_group_id: g2.id, territory: "North" });
    await db.Address.create({ customer_id: row.id, type: "ship_to_party", street1: "Dock 9", city: "Pune", region: "MH", pincode: "411002", postalCode: "411002", country: "India" });
    const same = await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1)] }));
    expect(same.counts).toMatchObject({ skipped: 1, created: 0, updated: 0 });
    const upd = await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Name: "Pharmacy One Ltd", City: "Nashik" })] }));
    expect(upd.counts).toMatchObject({ updated: 1, created: 0 });
    const after = await db.Customer.findByPk(row.id);
    expect(after).toMatchObject({ name: "Pharmacy One Ltd", city: "Nashik", customer_code: row.customer_code, customer_group_id: g2.id, territory: "North" });
    expect(Number(after.credit_limit)).toBe(50000);
    expect(await db.Address.count({ where: { customer_id: row.id, type: "ship_to_party" } })).toBe(1);
    expect(await db.Customer.count()).toBe(1);
  });
  test("ERP status inactive/active is applied, but a PENDING (awaiting admin approval) retailer is never touched; an empty ERP value never blanks a field", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1), cust(2)] }));
    const [r1, r2] = await db.Customer.findAll({ order: [["id", "ASC"]] });
    await r2.update({ status: "pending" });
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Active: "inactive" }), cust(2, { Active: "inactive" })] }));
    expect((await db.Customer.findByPk(r1.id)).status).toBe("inactive"); expect((await db.Customer.findByPk(r2.id)).status).toBe("pending");
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Active: "inactive", City: "" }), cust(2, { Active: "inactive" })] }));
    expect((await db.Customer.findByPk(r1.id)).city).toBe("Pune");
  });
  test("duplicate prevention: a GSTIN already used by a retailer of that distributor is a per-record error, never a second customer; repeats do not duplicate", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await db.Customer.create({ name: "Existing", distributor_id: w.d.id, customer_group_id: w.group.id, taxNumber: "27ABCDE1234F1Z5" });
    const f = restFetch({ "/customers": [cust(1, { Gstin: "27ABCDE1234F1Z5" }), cust(2)] });
    const job = await run(c, "CUSTOMER_MASTER", w.cScope, f);
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 1, failed: 1 } });
    expect(await db.Customer.count()).toBe(2);
    await run(c, "CUSTOMER_MASTER", w.cScope, f);
    expect(await db.Customer.count()).toBe(2);
    const errs = await sync.listJobErrors(db, T, job.id);
    expect(errs.items[0]).toMatchObject({ externalId: "C1", code: "VALIDATION_ERROR", retryable: false, scope: "RECORD" });
  });
  test("mapping / validation failures are per-record: bad PIN, missing required address, unknown key; others still succeed", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    const job = await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Pin: "12" }), cust(2, { Street: "" }), cust(3), { Name: "no key" }] }));
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 1, failed: 3 } });
    const codes = (await sync.listJobErrors(db, T, job.id)).items.map((e) => e.code).sort();
    expect(codes).toEqual(["MAPPING_ERROR", "VALIDATION_ERROR", "VALIDATION_ERROR"]);
  });
  test("a customer deleted in the DMS is re-created and re-linked (no orphan link)", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    const f = restFetch({ "/customers": [cust(1)] });
    await run(c, "CUSTOMER_MASTER", w.cScope, f); await db.Customer.destroy({ where: {} });
    const job = await run(c, "CUSTOMER_MASTER", w.cScope, f);
    expect(job.counts.created).toBe(1); expect(await db.Customer.count()).toBe(1); expect(await db.ErpExternalLink.count({ where: { entity_type: "CUSTOMER" } })).toBe(1);
  });
});

// ═════════════════════════════════════ DISTRIBUTOR_MASTER ═════════════════════════════════════
describe("Distributor master → existing Distributor model", () => {
  test("create → PENDING with no password/login, code generated; business-controlled fields cannot be mapped", async () => {
    const c = await mkConn();
    for (const f of ["credit_limit", "payment_terms", "status", "password"]) await expect(mkMap(c, "DISTRIBUTOR_MASTER", [...DIST_MAP, { sourceField: "X", dmsField: f }])).rejects.toMatchObject({ statusCode: 400 });
    await mkMap(c, "DISTRIBUTOR_MASTER", DIST_MAP);
    const job = await run(c, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1, { Gst: "27aaaaa0000a1z5" })] }));
    expect(job).toMatchObject({ status: "SUCCESS", counts: { created: 1 } });
    const d = await db.Distributor.findOne();
    expect(d).toMatchObject({ name: "Dist 1", email: "dist1@example.com", status: "pending", password: null, tax_no: "27AAAAA0000A1Z5", country: "India" });
    expect(d.distributor_code).toMatch(/^DTC/);
  });
  test("update keeps credit limit, payment terms, status, login e-mail and code; unchanged → skipped; one distributor, no duplicates", async () => {
    const c = await mkConn(); await mkMap(c, "DISTRIBUTOR_MASTER", DIST_MAP);
    await run(c, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1)] }));
    const d = await db.Distributor.findOne(); await d.update({ credit_limit: 900000, payment_terms: "NET45", status: "active" });
    expect((await run(c, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1)] }))).counts.skipped).toBe(1);
    const up = await run(c, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1, { Name: "Dist One Pvt", City: "Thane", Email: "changed@example.com" })] }));
    expect(up.counts.updated).toBe(1);
    const after = await db.Distributor.findByPk(d.id);
    expect(after).toMatchObject({ name: "Dist One Pvt", city: "Thane", email: "dist1@example.com", status: "active", payment_terms: "NET45", distributor_code: d.distributor_code });
    expect(Number(after.credit_limit)).toBe(900000); expect(await db.Distributor.count()).toBe(1);
  });
  test("an existing DMS distributor (same e-mail) is preserved untouched: the ERP record fails, nothing is overwritten or duplicated", async () => {
    const existing = await seedDistributor({ name: "Original", email: "dist1@example.com", credit_limit: 1000 });
    const c = await mkConn(); await mkMap(c, "DISTRIBUTOR_MASTER", DIST_MAP);
    const job = await run(c, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1, { Name: "ERP Name" })] }));
    expect(job.status).toBe("FAILED"); expect(await db.Distributor.count()).toBe(1);
    expect(await db.Distributor.findByPk(existing.id)).toMatchObject({ name: "Original" });
  });
  test("tenant isolation: two tenants' links never collide, and tenant B cannot see tenant A's jobs or schedules", async () => {
    const a = await mkConn(); const b = await mkConn({ name: "B ERP", credentialRef: "OTHERTOK" }, T2);
    await mkMap(a, "DISTRIBUTOR_MASTER", DIST_MAP); await mkMap(b, "DISTRIBUTOR_MASTER", DIST_MAP, T2);
    const ja = await run(a, "DISTRIBUTOR_MASTER", {}, restFetch({ "/distributors": [dist(1)] }));
    await expect(run(a, "DISTRIBUTOR_MASTER", {}, restFetch({}), {}, T2)).resolves.toBeNull(); // foreign connection → null (404), no ERP call
    expect(await sync.getJob(db, T2, ja.id)).toBeNull();
    expect((await sync.listJobs(db, T2)).total).toBe(0);
    expect(await db.ErpExternalLink.count({ where: { tenant_key: T } })).toBe(1); expect(await db.ErpExternalLink.count({ where: { tenant_key: T2 } })).toBe(0);
  });
});

// ═════════════════════════════════════ PRICING ═════════════════════════════════════
describe("Pricing → existing PricingMaster", () => {
  async function synced(w, c) {
    await mkMap(c, "PRODUCT_MASTER", PROD_MAP); await mkMap(c, "PRICING", PRICE_MAP);
    await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": [{ Code: "M1", Title: "Paracetamol" }, { Code: "M2", Title: "Amoxicillin" }] }));
  }
  const price = (id, mat, o = {}) => ({ PriceId: id, Mat: mat, Price: "20.50", Disc: "5", From: "2026-01-01", To: "2026-12-31", ...o });
  test("unsynchronised product → per-record error (no guess); synchronised → created with discount and validity window", async () => {
    const w = await world(); const c = await mkConn(); await synced(w, c);
    const job = await run(c, "PRICING", w.cScope, restFetch({ "/prices": [price("P1", "M1"), price("P9", "NOPE")] }));
    expect(job).toMatchObject({ status: "PARTIAL", counts: { created: 1, failed: 1 } });
    const row = await db.PricingMaster.findOne();
    expect(Number(row.base_price)).toBe(20.5); expect(Number(row.discount_percent)).toBe(5); expect(row.customer_group_id).toBe(w.group.id); expect(row.distributor_id).toBe(w.d.id);
    expect(new Date(row.valid_from).toISOString().slice(0, 10)).toBe("2026-01-01");
  });
  test("the existing pricing service resolves a synced price within its effective dates (and not outside them)", async () => {
    const w = await world(); const c = await mkConn(); await synced(w, c);
    await run(c, "PRICING", w.cScope, restFetch({ "/prices": [price("P1", "M1")] }));
    const prod = await db.Product.findOne({ where: { name: "Paracetamol" } });
    const q = (asOf) => pricing.getFinalPrice({ productId: prod.id, customer_group_id: w.group.id, distributor_id: w.d.id, asOf });
    expect(await q(new Date("2026-06-01"))).toMatchObject({ basePrice: 20.5, discountPercent: 5, unitPrice: 19.48 });
    await expect(q(new Date("2027-02-01"))).rejects.toThrow(/No pricing/);
    await expect(q(new Date("2025-06-01"))).rejects.toThrow(/No pricing/);
  });
  test("idempotent: same sync twice → one row, second run skipped; a changed ERP price updates the SAME row", async () => {
    const w = await world(); const c = await mkConn(); await synced(w, c);
    const f = restFetch({ "/prices": [price("P1", "M1"), price("P2", "M2")] });
    await run(c, "PRICING", w.cScope, f);
    expect((await run(c, "PRICING", w.cScope, f)).counts).toMatchObject({ skipped: 2, created: 0 });
    const up = await run(c, "PRICING", w.cScope, restFetch({ "/prices": [price("P1", "M1", { Price: "25" }), price("P2", "M2")] }));
    expect(up.counts).toMatchObject({ updated: 1, skipped: 1 });
    expect(await db.PricingMaster.count()).toBe(2);
    expect(Number((await db.PricingMaster.findOne({ order: [["id", "ASC"]] })).base_price)).toBe(25);
  });
  test("a manually configured price is NEVER overwritten: BUSINESS_DECISION_REQUIRED, manual row untouched", async () => {
    const w = await world(); const c = await mkConn(); await synced(w, c);
    const prod = await db.Product.findOne({ where: { name: "Paracetamol" } });
    const manual = await db.PricingMaster.create({ productId: prod.id, customer_group_id: w.group.id, distributor_id: w.d.id, base_price: 99, discount_percent: 0, valid_from: new Date("2020-01-01") });
    const job = await run(c, "PRICING", w.cScope, restFetch({ "/prices": [price("P1", "M1")] }));
    expect(job.status).toBe("FAILED");
    expect((await sync.listJobErrors(db, T, job.id)).items[0]).toMatchObject({ code: "BUSINESS_DECISION_REQUIRED", retryable: false });
    expect(Number((await db.PricingMaster.findByPk(manual.id)).base_price)).toBe(99); expect(await db.PricingMaster.count()).toBe(1);
  });
  test("invalid dates / amounts are per-record validation errors (valid-to before valid-from, zero price, discount > 100)", async () => {
    const w = await world(); const c = await mkConn(); await synced(w, c);
    const job = await run(c, "PRICING", w.cScope, restFetch({ "/prices": [price("P1", "M1", { From: "2026-05-01", To: "2026-01-01" }), price("P2", "M2", { Price: "0" }), price("P3", "M1", { Disc: "150" })] }));
    expect(job.status).toBe("FAILED"); expect(job.counts.failed).toBe(3); expect(await db.PricingMaster.count()).toBe(0);
  });
});

// ═════════════════════════════════════ PAYMENT ═════════════════════════════════════
describe("Payment → payments.service (Payment + journal + balances)", () => {
  async function ready(w, c, extra = {}) {
    await seedGLAccounts(w.d);
    await mkMap(c, "CUSTOMER_MASTER", CUST_MAP); await mkMap(c, "PAYMENT", PAY_MAP);
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1)] }));
    return extra;
  }
  const pay = (id, o = {}) => ({ PayId: id, Cust: "C1", Date: "2026-09-01", Amt: "1500.50", Mode: "bank_transfer", Ref: "UTR123", ...o });
  const pScope = (w, extra = {}) => ({ distributorId: w.d.id, ...extra });
  const journal = (n) => db.JournalEntry.findAll({ where: { reference_type: "CUSTOMER_PAYMENT" }, order: [["id", "ASC"]] });

  test("PAYMENT defaults to DMS → ERP, so a sync is refused until the admin deliberately declares the ERP as the owner (ERP → DMS)", async () => {
    const w = await world(); const c = await mkConn({ capabilities: [{ capability: "PAYMENT", endpointPath: "/payments", config: { responsePath: "rows", pagination: { type: "NONE" } } }] });
    await mkMap(c, "PAYMENT", PAY_MAP);
    await expect(run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [] }))).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", message: expect.stringMatching(/DMS → ERP/) });
  });
  test("creates the Payment through the Accounts service: balanced journal, receivable credited, unallocated, reference derived from the ERP id", async () => {
    const w = await world(); const c = await mkConn(); await ready(w, c);
    const job = await run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [pay("10001")] }));
    expect(job).toMatchObject({ status: "SUCCESS", counts: { created: 1 } });
    const p = await db.Payment.findOne();
    expect(p).toMatchObject({ distributor_id: w.d.id, mode: "BANK_TRANSFER", status: "POSTED", reference_no: `ERP${c.id}-10001` });
    expect(Number(p.amount)).toBe(1500.5); expect(p.remarks).toMatch(/ERP ref UTR123/);
    const rows = await journal(); expect(rows).toHaveLength(2);
    expect(rows.reduce((t, r) => t + Number(r.debit), 0)).toBeCloseTo(1500.5); expect(rows.reduce((t, r) => t + Number(r.credit), 0)).toBeCloseTo(1500.5);
    expect(await db.PaymentAllocation.count()).toBe(0);
  });
  test("IDEMPOTENT: repeating the sync never records the money twice (payments, journal rows)", async () => {
    const w = await world(); const c = await mkConn(); await ready(w, c);
    const f = restFetch({ "/payments": [pay("10001"), pay("10002", { Amt: "200", Ref: "UTR2" })] });
    await run(c, "PAYMENT", pScope(w), f);
    const again = await run(c, "PAYMENT", pScope(w), f);
    expect(again.counts).toMatchObject({ skipped: 2, created: 0 });
    expect(await db.Payment.count()).toBe(2); expect(await journal()).toHaveLength(4);
  });
  test("crash-safe: if the link row is lost after the payment committed, the retry re-links it instead of paying twice", async () => {
    const w = await world(); const c = await mkConn(); await ready(w, c);
    const f = restFetch({ "/payments": [pay("10001")] });
    await run(c, "PAYMENT", pScope(w), f); await db.ErpExternalLink.destroy({ where: { entity_type: "PAYMENT" } });
    const job = await run(c, "PAYMENT", pScope(w), f);
    expect(job.counts).toMatchObject({ created: 1, failed: 0 }); expect(await db.Payment.count()).toBe(1); expect(await journal()).toHaveLength(2);
    expect(await db.ErpExternalLink.count({ where: { entity_type: "PAYMENT" } })).toBe(1);
  });
  test("posted payments are immutable: a changed ERP record is reported, never rewritten", async () => {
    const w = await world(); const c = await mkConn(); await ready(w, c);
    await run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [pay("10001")] }));
    const job = await run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [pay("10001", { Amt: "9999" })] }));
    expect(job.status).toBe("FAILED"); expect(Number((await db.Payment.findOne()).amount)).toBe(1500.5); expect(await journal()).toHaveLength(2);
  });
  test("unknown customer, missing mode (no guess) and a bad mode are per-record errors; a default mode in the scope is honoured", async () => {
    const w = await world(); const c = await mkConn(); await ready(w, c);
    const job = await run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [pay("1", { Cust: "NOBODY" }), pay("2", { Mode: "" }), pay("3", { Mode: "bitcoin" })] }));
    expect(job.counts.failed).toBe(3); expect(await db.Payment.count()).toBe(0);
    const errs = (await sync.listJobErrors(db, T, job.id)).items; expect(errs.map((e) => e.code).sort()).toEqual(["BUSINESS_DECISION_REQUIRED", "BUSINESS_DECISION_REQUIRED", "VALIDATION_ERROR"]); // Phase 18: an unmapped ERP payment mode ("bitcoin") now needs a decision (payment-mode code mapping) instead of failing validation
    const ok = await run(c, "PAYMENT", pScope(w, { defaultMode: "cash" }), restFetch({ "/payments": [pay("2", { Mode: "", Ref: "" })] }));
    expect(ok.counts.created).toBe(1); expect((await db.Payment.findOne()).mode).toBe("CASH");
  });
  test("when a GL lookup fails the Accounts service refuses and nothing is half-written", async () => {
    const acc = require("../services/accounting.service"); // standard accounts are auto-created now, so simulate the lookup failing
    const spy = jest.spyOn(acc, "getGL").mockRejectedValue(new acc.AccountingError("GL not configured: Cash/Bank"));
    const w = await world(); const c = await mkConn();
    await mkMap(c, "CUSTOMER_MASTER", CUST_MAP); await mkMap(c, "PAYMENT", PAY_MAP);
    await run(c, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1)] }));
    const job = await run(c, "PAYMENT", pScope(w), restFetch({ "/payments": [pay("1")] }));
    spy.mockRestore();
    expect(job.status).toBe("FAILED"); expect(await db.Payment.count()).toBe(0); expect(await journal()).toHaveLength(0);
  });
});

// ═════════════════════════════════════ NOT SUPPORTED ═════════════════════════════════════
describe("Capabilities that are deliberately NOT synchronised", () => {
  test("INVOICE / RETURN / DOCUMENT (Phase 16: STOCK and SALES now have targets): no target, a documented reason, honest code — never a fake success", async () => {
    const w = await world(); const f = jest.fn();
    const c = await mkConn({ capabilities: ["INVOICE", "RETURN", "DOCUMENT"].map((x) => cap(x, `/${x}`)) });
    const expected = { INVOICE: "BUSINESS_DECISION_REQUIRED", RETURN: "CAPABILITY_NOT_SUPPORTED", DOCUMENT: "CAPABILITY_NOT_SUPPORTED" };
    for (const [k, code] of Object.entries(expected)) {
      expect(targets.getTarget(k)).toBeNull();
      await expect(run(c, k, w.cScope, f)).rejects.toMatchObject({ statusCode: 409, code, message: expect.stringMatching(/cannot be synchronised/) });
      await expect(mkMap(c, k, [{ sourceField: "A", isKey: true }])).rejects.toMatchObject({ statusCode: 409, code });
    }
    expect(f).not.toHaveBeenCalled(); expect(await db.ErpSyncJob.count()).toBe(0);
    expect(targets.describeUnsupported().map((u) => u.capability).sort()).toEqual(["DOCUMENT", "INVOICE", "RETURN"]);
    const l = (await A(erp.lookups)).jsonBody;
    expect(l.capabilities.find((x) => x.value === "DOCUMENT")).toMatchObject({ syncSupported: false, syncUnsupportedCode: "CAPABILITY_NOT_SUPPORTED" });
    expect(l.capabilities.find((x) => x.value === "PRICING")).toMatchObject({ syncSupported: true });
    expect(l.syncTargets.find((t) => t.capability === "PRICING").ownership.rule).toMatch(/never overwrites/);
    expect(l.scheduleFrequencies.map((x) => x.value)).toEqual(["EVERY_15_MIN", "EVERY_30_MIN", "HOURLY", "DAILY"]);
  });
  test("outbound DMS → ERP is not implemented: such a capability is refused, no request is made", async () => {
    const w = await world(); const f = jest.fn();
    const c = await mkConn({ capabilities: [cap("CUSTOMER_MASTER", "/customers", "DMS_TO_ERP")] }); await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await expect(run(c, "CUSTOMER_MASTER", w.cScope, f)).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", message: expect.stringMatching(/DMS → ERP/) });
    expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════ SCHEDULER ═════════════════════════════════════
describe("Scheduler + worker", () => {
  async function ready() {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    return { w, c, save: (body, capability = "PRODUCT_MASTER", tenant = T) => sched.saveSchedule(db, tenant, 1, c.id, capability, body) };
  }
  const later = (min) => new Date(Date.now() + min * 60000);
  const products = (n = 2) => restFetch({ "/products": Array.from({ length: n }, (_, i) => ({ Code: `M${i + 1}`, Title: `Prod ${i + 1}` })) });

  test("configuration: frequency allow-list (nothing below 15 minutes), enabled only when a sync could really run, scope validated", async () => {
    const { w, c, save } = await ready();
    await expect(save({ enabled: true, frequency: "EVERY_5_MIN", scope: w.pScope })).rejects.toMatchObject({ statusCode: 400 });
    await expect(save({ enabled: true, frequency: "HOURLY" })).rejects.toMatchObject({ statusCode: 400 });                 // scope missing
    await expect(save({ enabled: true, frequency: "HOURLY", scope: w.pScope }, "STOCK")).rejects.toMatchObject({ statusCode: 409 }); // not syncable
    await expect(save({ enabled: true, frequency: "HOURLY", scope: w.pScope }, "PRICING")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIGURED" }); // supported, but no mapping yet
    await expect(save({ enabled: "yes", frequency: "HOURLY" })).rejects.toMatchObject({ statusCode: 400 });
    const s = await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    expect(s).toMatchObject({ enabled: true, frequency: "EVERY_15_MIN", frequencyLabel: "Every 15 minutes", intervalMinutes: 15, scope: w.pScope, lastRunAt: null, retryCount: 0 });
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60000);
    expect(await sync.getJob(db, T, 1)).toBeNull();                                                                       // saving a schedule never runs a sync
    expect(await db.ErpSyncSchedule.count()).toBe(1);
    const again = await save({ frequency: "DAILY" }); expect(again).toMatchObject({ id: s.id, frequency: "DAILY", enabled: true }); expect(await db.ErpSyncSchedule.count()).toBe(1);
    const off = await save({ enabled: false }); expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    expect(c.id).toBeGreaterThan(0);
  });
  test("tick: nothing before the due time; at the due time ONE QUEUED SCHEDULED job is created — the scheduler itself runs no sync", async () => {
    const { w, save } = await ready(); const f = products();
    const s = await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    expect(await sched.schedulerTick(db, { now: later(5) })).toEqual([]);
    const r = await sched.schedulerTick(db, { now: later(16) });
    expect(r).toEqual([expect.objectContaining({ schedule: s.id, outcome: "QUEUED" })]);
    const job = await db.ErpSyncJob.findOne();
    expect(job).toMatchObject({ trigger_type: "SCHEDULED", status: "QUEUED", requested_by_admin_id: null, attempt: 1 });
    expect(await db.Product.count()).toBe(0); expect(f).not.toHaveBeenCalled();
    const after = await sched.getSchedule(db, T, s.id);
    expect(after).toMatchObject({ lastStatus: "QUEUED", lastJobId: job.id }); expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60000);
  });
  test("no duplicates: a second tick of the same slot, two simultaneous ticks, and a still-running job create exactly one job", async () => {
    const { w, save } = await ready();
    await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    const now = later(16);
    const [a, b] = await Promise.all([sched.schedulerTick(db, { now }), sched.schedulerTick(db, { now })]);
    expect([...a, ...b].filter((x) => x.outcome === "QUEUED")).toHaveLength(1);
    await db.ErpSyncJob.update({ heartbeat_at: now }, { where: {} }); // the test clock runs ahead of real time: the job is "alive" at 'now'
    expect(await sched.schedulerTick(db, { now })).toEqual([]);
    expect(await db.ErpSyncJob.count()).toBe(1);
    // next slot arrives while the previous job is still QUEUED/RUNNING → skipped, still one job
    await db.ErpSyncJob.update({ heartbeat_at: later(59) }, { where: {} }); // the simulated clock is 60 min ahead: keep the job "alive" there
    const r = await sched.schedulerTick(db, { now: later(60) });
    expect(r[0]).toMatchObject({ outcome: "SKIPPED", code: "SYNC_ALREADY_RUNNING" });
    expect(await db.ErpSyncJob.count()).toBe(1);
    expect((await db.ErpSyncSchedule.findOne()).last_status).toBe("SKIPPED");
  });
  test("a disabled schedule never fires; disabling stops a previously enabled one", async () => {
    const { w, save } = await ready();
    await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope }); await save({ enabled: false });
    expect(await sched.schedulerTick(db, { now: later(600) })).toEqual([]); expect(await db.ErpSyncJob.count()).toBe(0);
    await save({ enabled: false, frequency: "HOURLY" }).then(async () => expect(await sched.schedulerTick(db, { now: later(600) })).toEqual([]));
  });
  test("worker: QUEUED → RUNNING → SUCCESS through the generic engine; the schedule records the outcome; the dashboard is updated", async () => {
    const { w, c, save } = await ready(); const f = products(3);
    const s = await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    await sched.schedulerTick(db, { now: later(16) });
    const done = await sched.workerTick(db, { fetchImpl: f, logger: () => {}, retryDelayMs: 0 });
    expect(done).toHaveLength(1); expect(done[0]).toMatchObject({ status: "SUCCESS", created_count: 3, trigger_type: "SCHEDULED" });
    expect(await db.Product.count()).toBe(3);
    expect(await sched.getSchedule(db, T, s.id)).toMatchObject({ lastStatus: "SUCCESS", retryCount: 0, nextRetryAt: null });
    const sum = await monitor.getSummary(db, T);
    expect(sum.syncsToday).toMatchObject({ total: 1, success: 1 }); expect(sum.nextScheduledSync).toMatchObject({ connectionName: "Custom ERP", capability: "PRODUCT_MASTER", isRetry: false });
    expect(sum.perConnection.find((x) => x.id === c.id)).toMatchObject({ health: { status: "HEALTHY" }, lastSync: { status: "SUCCESS" }, nextSync: { capability: "PRODUCT_MASTER" } });
    expect(await sched.workerTick(db, { fetchImpl: f })).toEqual([]);   // nothing left to run
  });
  test("worker respects the concurrency cap (ERP_SYNC_MAX_CONCURRENT) and never takes a job twice", async () => {
    const w = await world(); process.env.ERP_SYNC_MAX_CONCURRENT = "1";
    try {
      const c1 = await mkConn({ name: "E1" }); const c2 = await mkConn({ name: "E2" });
      for (const c of [c1, c2]) { await mkMap(c, "PRODUCT_MASTER", PROD_MAP); await sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope }); }
      await sched.schedulerTick(db, { now: later(16) });
      const f = products(1);
      expect(await sched.workerTick(db, { fetchImpl: f, logger: () => {}, retryDelayMs: 0 })).toHaveLength(1);
      expect(await sched.workerTick(db, { fetchImpl: f, logger: () => {}, retryDelayMs: 0 })).toHaveLength(1);
      expect(await sched.workerTick(db, { fetchImpl: f })).toHaveLength(0);
    } finally { delete process.env.ERP_SYNC_MAX_CONCURRENT; }
  });
  test("a preflight failure at fire time (mapping removed) is SKIPPED with a reason on the schedule — no job, no ERP call", async () => {
    const { w, c, save } = await ready(); const f = products();
    const s = await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    await db.ErpEntityMapping.destroy({ where: { connection_id: c.id } });
    const r = await sched.schedulerTick(db, { now: later(16) });
    expect(r[0]).toMatchObject({ outcome: "SKIPPED", code: "MAPPING_NOT_CONFIGURED" });
    expect(await db.ErpSyncJob.count()).toBe(0); expect(await sched.getSchedule(db, T, s.id)).toMatchObject({ lastStatus: "SKIPPED", lastError: { code: "MAPPING_NOT_CONFIGURED" } }); expect(f).not.toHaveBeenCalled();
  });
  test("a crashed job (no heartbeat) is closed as FAILED by the scheduler so the schedule is not blocked forever", async () => {
    const { w, save } = await ready();
    const s = await save({ enabled: true, frequency: "EVERY_15_MIN", scope: w.pScope });
    await sched.schedulerTick(db, { now: later(16) });
    const job = await db.ErpSyncJob.findOne(); await job.update({ status: "RUNNING", heartbeat_at: new Date(Date.now() - 3600000) });
    await sched.schedulerTick(db, { now: later(17) });
    expect(await db.ErpSyncJob.findByPk(job.id)).toMatchObject({ status: "FAILED", active_key: null });
    expect((await sched.getSchedule(db, T, s.id)).lastStatus).toBe("FAILED");
  });
  test("'Run now' goes through the same claim → job → worker path; a disabled schedule cannot be triggered; foreign schedule is 404", async () => {
    const { w, save } = await ready(); const f = products(2);
    const s = await save({ enabled: true, frequency: "DAILY", scope: w.pScope });
    const out = await sched.triggerSchedule(db, T, 1, s.id, { deps: { await: true, fetchImpl: f, logger: () => {}, retryDelayMs: 0 } });
    expect(out.lastStatus).toBe("SUCCESS"); expect((await db.ErpSyncJob.findOne()).trigger_type).toBe("SCHEDULED"); expect(await db.Product.count()).toBe(2);
    expect(await sched.triggerSchedule(db, T2, 1, s.id)).toBeNull(); expect(await sched.getSchedule(db, T2, s.id)).toBeNull();
    await save({ enabled: false }); await expect(sched.triggerSchedule(db, T, 1, s.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  test("tenant isolation: tenant B cannot list, read, save, trigger — and a foreign connection id is 404", async () => {
    const { w, c, save } = await ready(); const s = await save({ enabled: true, frequency: "DAILY", scope: w.pScope });
    expect((await sched.listSchedules(db, T2)).total).toBe(0); expect(await sched.getSchedule(db, T2, s.id)).toBeNull();
    expect(await sched.saveSchedule(db, T2, 1, c.id, "PRODUCT_MASTER", { enabled: true, frequency: "DAILY", scope: w.pScope })).toBeNull();
    const res = await A(erp.getSchedule, { params: { id: s.id }, tenantKey: T2 }); expect(res.statusCode).toBe(200);          // tenant comes from the session, never the request
    process.env.ERP_TENANT_KEY = T2; try { expect((await A(erp.getSchedule, { params: { id: s.id } })).statusCode).toBe(404); expect((await A(erp.listSchedules)).jsonBody.total).toBe(0); } finally { delete process.env.ERP_TENANT_KEY; }
  });
});

// ═════════════════════════════════════ AUTOMATIC RETRY ═════════════════════════════════════
describe("Automatic retry with exponential backoff (scheduled jobs)", () => {
  const later = (min) => new Date(Date.now() + min * 60000);
  const D0 = (f) => ({ fetchImpl: f, logger: () => {}, retryDelayMs: 0 });
  async function ready(frequency = "DAILY") {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const s = await sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { enabled: true, frequency, scope: w.pScope });
    return { w, c, s };
  }
  const fire = async (min, f) => { await sched.schedulerTick(db, { now: later(min) }); return sched.workerTick(db, D0(f)); };

  test("a transient failure (5xx) is retried automatically: bounded, exponentially spaced, and visible (retry count, last retry, next retry)", async () => {
    const { s } = await ready(); const f = restFetch({ "/products": () => json(500, {}) });
    const [j0] = await fire(60 * 25, f);
    expect(j0).toMatchObject({ status: "FAILED", error_code: "SERVER_ERROR" });
    let st = await sched.getSchedule(db, T, s.id);
    expect(st).toMatchObject({ retryCount: 1, lastStatus: "FAILED", lastError: { code: "SERVER_ERROR", retryable: true } });
    const gap1 = new Date(st.nextRetryAt).getTime() - Date.now(); expect(gap1).toBeGreaterThan(1.5 * 60000); expect(gap1).toBeLessThan(2.5 * 60000);   // 2 min
    expect(st.nextRunAt).toBe(st.nextRetryAt);
    const gaps = [gap1];
    for (let k = 2; k <= 3; k += 1) {
      const [jr] = await fire(60 * 25 + 10 * k, f);
      expect(jr).toMatchObject({ trigger_type: "RETRY", attempt: k, retry_of_job_id: expect.any(Number), status: "FAILED" });
      st = await sched.getSchedule(db, T, s.id); expect(st.retryCount).toBe(k); expect(st.lastRetryAt).not.toBeNull();
      gaps.push(new Date(st.nextRetryAt).getTime() - Date.now());
    }
    expect(gaps[1]).toBeGreaterThan(gaps[0] * 1.8); expect(gaps[2]).toBeGreaterThan(gaps[1] * 1.8);                                                // 2, 4, 8 min
    const [last] = await fire(60 * 25 + 100, f);                                                                                                     // 3rd automatic retry fails → exhausted
    expect(last).toMatchObject({ attempt: 4, status: "FAILED" });
    st = await sched.getSchedule(db, T, s.id);
    expect(st).toMatchObject({ retryCount: 3, nextRetryAt: null }); expect(st.maxAutoRetries).toBe(3);
    expect(await sched.schedulerTick(db, { now: later(60 * 25 + 200) })).toEqual([]);                                                               // not before the regular slot
    expect(await db.ErpSyncJob.count()).toBe(4);
    const job = await sync.getJob(db, T, last.id); expect(job).toMatchObject({ retryable: true, retryCount: 3 });
    expect((await sync.getJob(db, T, j0.id)).lastRetryAt).not.toBeNull();
  });
  test("a NON-retryable failure (401) is never retried automatically", async () => {
    const { s } = await ready(); const f = restFetch({ "/products": () => json(401, {}) });
    const [j] = await fire(60 * 25, f); expect(j).toMatchObject({ status: "FAILED", error_code: "AUTHENTICATION_ERROR" });
    expect(await sched.getSchedule(db, T, s.id)).toMatchObject({ retryCount: 0, nextRetryAt: null, lastError: { code: "AUTHENTICATION_ERROR", retryable: false } });
    expect(f).toHaveBeenCalledTimes(1);
    expect(await sched.schedulerTick(db, { now: later(60 * 25 + 30) })).toEqual([]);
  });
  test("a successful retry clears the retry state; per-record data errors are not auto-retried", async () => {
    const { s } = await ready(); let n = 0;
    const flaky = restFetch({ "/products": () => { n += 1; return n <= 3 ? json(503, {}) : json(200, { rows: [{ Code: "M1", Title: "A" }] }); } });
    expect((await fire(60 * 25, flaky))[0].status).toBe("FAILED");
    const [ok] = await fire(60 * 25 + 10, flaky); expect(ok).toMatchObject({ status: "SUCCESS", trigger_type: "RETRY", attempt: 2 });
    expect(await sched.getSchedule(db, T, s.id)).toMatchObject({ retryCount: 0, nextRetryAt: null, lastStatus: "SUCCESS" });
    const bad = restFetch({ "/products": [{ Code: "X", Title: "" }] });
    await db.ErpSyncSchedule.update({ next_run_at: new Date(Date.now() - 1000) }, { where: { id: s.id } });
    const [pj] = await sched.schedulerTick(db, { now: new Date() }).then(() => sched.workerTick(db, D0(bad))); expect(pj.status).toBe("FAILED");
    expect(await sched.getSchedule(db, T, s.id)).toMatchObject({ retryCount: 0, nextRetryAt: null });
  });
  test("manual retry (Phase 14) still works and now exposes retry visibility", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const j1 = await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(500, {}) }));
    expect(j1).toMatchObject({ status: "FAILED", retryable: true, retryCount: 0, lastRetryAt: null, canRetry: true });
    const j2 = await sync.retryJob(db, T, 1, j1.id, D(restFetch({ "/products": [{ Code: "M1", Title: "A" }] })));
    expect(j2).toMatchObject({ status: "SUCCESS", trigger: "RETRY", attempt: 2, retryCount: 1 });
    expect((await sync.getJob(db, T, j1.id)).lastRetryAt).not.toBeNull();
  });
});

// ═════════════════════════════════════ MONITORING ═════════════════════════════════════
describe("Sync health & dashboard (real data only)", () => {
  test("health rule: UNKNOWN / HEALTHY / WARNING / ERROR from real job statuses (pure function)", () => {
    const h = monitor.computeHealth;
    expect(h([])).toMatchObject({ status: "UNKNOWN" });
    expect(h(["SUCCESS", "SUCCESS", "SUCCESS"])).toMatchObject({ status: "HEALTHY", reason: "No recent failures" });
    expect(h(["PARTIAL", "SUCCESS"])).toMatchObject({ status: "WARNING" });
    expect(h(["SUCCESS", "FAILED", "SUCCESS"])).toMatchObject({ status: "WARNING" });                       // recovered, but recent problems
    expect(h(["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "FAILED"])).toMatchObject({ status: "HEALTHY" }); // old failure outside the window
    expect(h(["FAILED", "SUCCESS"])).toMatchObject({ status: "ERROR", reason: "The last sync failed" });
    expect(h(["FAILED", "FAILED", "FAILED", "SUCCESS"])).toMatchObject({ status: "ERROR", reason: "Failed 3 times in a row" });
  });
  test("empty tenant: zeros and nulls, hasSyncActivity=false, no per-ERP stats invented", async () => {
    const s = await monitor.getSummary(db, T);
    expect(s).toMatchObject({ connections: 0, activeConnections: 0, runningSyncs: 0, syncsToday: { total: 0, success: 0, partial: 0, failed: 0 }, lastSuccessfulSync: null, nextScheduledSync: null, hasSyncActivity: false, perConnection: [] });
  });
  test("per-ERP statistics, today's counts and health come from the job rows; each ERP and each tenant stays separate", async () => {
    const w = await world();
    const sap = await mkConn({ name: "SAP Production", capabilities: [cap("PRODUCT_MASTER", "/products")] });
    const ora = await mkConn({ name: "Oracle Production", capabilities: [cap("PRODUCT_MASTER", "/products")] });
    const dyn = await conns.createConnection(db, T, 1, { name: "Dynamics", erpType: "MS_DYNAMICS", environment: "TEST", baseUrl: "https://dyn.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN", capabilities: [{ capability: "PRODUCT_MASTER", endpointPath: "/products" }] });
    const other = await mkConn({ name: "Other tenant ERP", credentialRef: "OTHERTOK" }, T2);
    for (const x of [sap, ora]) await mkMap(x, "PRODUCT_MASTER", PROD_MAP);
    await run(sap, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": [{ Code: "A", Title: "A" }] }));
    await run(ora, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(500, {}) }));
    await expect(run(dyn, "PRODUCT_MASTER", w.pScope, restFetch({}))).rejects.toMatchObject({ code: expect.stringMatching(/MAPPING_NOT_CONFIGURED|PROVIDER_NOT_SUPPORTED/) });
    await sched.saveSchedule(db, T, 1, sap.id, "PRODUCT_MASTER", { enabled: true, frequency: "HOURLY", scope: w.pScope });
    const s = await monitor.getSummary(db, T);
    expect(s).toMatchObject({ connections: 3, activeConnections: 3, runningSyncs: 0, syncsToday: { total: 2, success: 1, failed: 1, partial: 0 }, hasSyncActivity: true, enabledSchedules: 1 });
    expect(s.lastSuccessfulSync).toMatchObject({ connectionName: "SAP Production", capability: "PRODUCT_MASTER" });
    expect(s.nextScheduledSync).toMatchObject({ connectionName: "SAP Production" });
    const by = Object.fromEntries(s.perConnection.map((p) => [p.name, p]));
    expect(by["SAP Production"]).toMatchObject({ health: { status: "HEALTHY" }, last7Days: { success: 1, failed: 0 }, lastSuccessfulSync: { status: "SUCCESS" } });
    expect(by["SAP Production"].nextSync).not.toBeNull();
    expect(by["Oracle Production"]).toMatchObject({ health: { status: "ERROR" }, last7Days: { success: 0, failed: 1 }, lastSuccessfulSync: null, nextSync: null });
    expect(by.Dynamics).toMatchObject({ health: { status: "UNKNOWN" }, lastSync: null, provider: { status: "FOUNDATION_ONLY" } });
    const t2 = await monitor.getSummary(db, T2);
    expect(t2).toMatchObject({ connections: 1, hasSyncActivity: false, syncsToday: { total: 0 } }); expect(t2.perConnection[0].name).toBe("Other tenant ERP");
    expect(sap.id).not.toBe(other.id);
    expect(JSON.stringify(s)).not.toMatch(/bearer-tok|other-tok|password/i);
  });
  test("running syncs are counted live", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    await db.ErpSyncJob.create({ tenant_key: T, connection_id: c.id, capability: "PRODUCT_MASTER", direction: "ERP_TO_DMS", status: "RUNNING", active_key: "k", scope: w.pScope });
    expect((await monitor.getSummary(db, T)).runningSyncs).toBe(1);
  });
});

describe("Error monitor (filters)", () => {
  async function seed() {
    const w = await world();
    const sap = await mkConn({ name: "SAP Production", capabilities: [cap("PRODUCT_MASTER", "/products"), cap("CUSTOMER_MASTER", "/customers")] });
    const ora = await mkConn({ name: "Oracle", capabilities: [cap("PRODUCT_MASTER", "/products")] });
    await mkMap(sap, "PRODUCT_MASTER", PROD_MAP); await mkMap(sap, "CUSTOMER_MASTER", CUST_MAP); await mkMap(ora, "PRODUCT_MASTER", PROD_MAP);
    const jAuth = await run(sap, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(401, {}) }));
    const jTimeout = await run(ora, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(500, {}) }));
    const jRec = await run(sap, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Pin: "x" }), cust(2)] }));
    return { w, sap, ora, jAuth, jTimeout, jRec };
  }
  test("run-level failures and record failures both appear; every filter works alone and combined", async () => {
    const { sap, ora } = await seed();
    const all = await monitor.listErrors(db, T); expect(all.total).toBe(3);
    expect(all.byCode.map((x) => x.code).sort()).toEqual(["AUTHENTICATION_ERROR", "SERVER_ERROR", "VALIDATION_ERROR"]);
    const q = (query) => monitor.listErrors(db, T, query);
    expect((await q({ connectionId: sap.id })).total).toBe(2); expect((await q({ connectionId: ora.id })).total).toBe(1);
    expect((await q({ capability: "customer_master" })).items[0]).toMatchObject({ scope: "RECORD", code: "VALIDATION_ERROR", externalId: "C1", retryable: false });
    expect((await q({ errorCode: "AUTHENTICATION_ERROR" })).items[0]).toMatchObject({ scope: "RUN", retryable: false, connection: { name: "SAP Production" }, capability: "PRODUCT_MASTER" });
    expect((await q({ retryable: "true" })).items.map((e) => e.code)).toEqual(["SERVER_ERROR"]);
    expect((await q({ retryable: "false" })).total).toBe(2);
    expect((await q({ status: "FAILED" })).total).toBe(2); expect((await q({ status: "PARTIAL" })).total).toBe(1); expect((await q({ status: "SUCCESS" })).total).toBe(0);
    expect((await q({ connectionId: sap.id, capability: "PRODUCT_MASTER", errorCode: "AUTHENTICATION_ERROR", retryable: "false" })).total).toBe(1);
    const n = new Date(); const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; // the filter uses the SERVER calendar day (local time), not UTC
    expect((await q({ from: today, to: today })).total).toBe(3); expect((await q({ from: "2000-01-01", to: "2000-01-02" })).total).toBe(0);
    expect((await q({ pageSize: 2 })).items).toHaveLength(2);
    const timeout = (await q({ errorCode: "SERVER_ERROR" })).items[0]; expect(timeout.job).toMatchObject({ status: "FAILED", attempt: 1, retryCount: 0, canRetry: true });
  });
  test("invalid filters are 400 (never silently ignored); another tenant sees nothing; messages never contain secrets", async () => {
    await seed();
    for (const bad of [{ errorCode: "NOPE" }, { capability: "NOPE" }, { status: "NOPE" }, { retryable: "maybe" }, { from: "yesterday" }, { connectionId: "abc" }, { from: "2026-02-01", to: "2026-01-01" }]) await expect(monitor.listErrors(db, T, bad)).rejects.toMatchObject({ statusCode: 400 });
    expect((await monitor.listErrors(db, T2)).total).toBe(0); expect((await monitor.listErrors(db, T2, { connectionId: 1 })).total).toBe(0);
    expect(JSON.stringify(await monitor.listErrors(db, T))).not.toMatch(/bearer-tok|Bearer /);
  });
  test("controller: GET /erp-sync/errors and /summary use the session tenant", async () => {
    await seed();
    const e = await A(erp.listErrors, { query: { errorCode: "SERVER_ERROR" } }); expect(e.statusCode).toBe(200); expect(e.jsonBody.total).toBe(1);
    const s = await A(erp.syncSummary); expect(s.jsonBody.perConnection).toHaveLength(2);
    const bad = await A(erp.listErrors, { query: { retryable: "x" } }); expect(bad.statusCode).toBe(400);
  });
});

// ═════════════════════════════════════ MULTI-ERP / ISOLATION ═════════════════════════════════════
describe("Multi-ERP in one tenant", () => {
  test("SAP-style, Oracle-style (via Generic REST) and Dynamics (foundation only) stay isolated: separate links, jobs, schedules; Dynamics cannot sync", async () => {
    const w = await world();
    const sap = await mkConn({ name: "SAP" }); const ora = await mkConn({ name: "Oracle", erpType: "ORACLE_ERP", provider: "GENERIC_REST" });
    const dyn = await conns.createConnection(db, T, 1, { name: "Dynamics", erpType: "MS_DYNAMICS", environment: "TEST", baseUrl: "https://dyn.example.com", credentialRef: "RESTBEARER", authType: "BEARER_TOKEN", capabilities: [{ capability: "CUSTOMER_MASTER", endpointPath: "/c" }] });
    for (const c of [sap, ora]) await mkMap(c, "CUSTOMER_MASTER", CUST_MAP);
    await run(sap, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Name: "From SAP" })] }));
    await run(ora, "CUSTOMER_MASTER", w.cScope, restFetch({ "/customers": [cust(1, { Name: "From Oracle", Phone: "9123456780", Gstin: "27AAAAA0000A1Z5" })] })); // same ERP code "C1" in a second ERP
    expect(await db.Customer.count()).toBe(2); expect(await db.ErpExternalLink.count({ where: { entity_type: "CUSTOMER" } })).toBe(2);
    await mkMap(dyn, "CUSTOMER_MASTER", CUST_MAP);
    await expect(run(dyn, "CUSTOMER_MASTER", w.cScope, restFetch({}))).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
    await expect(sched.saveSchedule(db, T, 1, dyn.id, "CUSTOMER_MASTER", { enabled: true, frequency: "HOURLY", scope: w.cScope })).rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED" });
    await sched.saveSchedule(db, T, 1, sap.id, "CUSTOMER_MASTER", { enabled: true, frequency: "HOURLY", scope: w.cScope });
    await sched.saveSchedule(db, T, 1, ora.id, "CUSTOMER_MASTER", { enabled: true, frequency: "DAILY", scope: w.cScope });
    expect((await sched.listSchedules(db, T, { connectionId: sap.id })).total).toBe(1); expect((await sched.listSchedules(db, T)).total).toBe(2);
    expect((await sync.listJobs(db, T, { connectionId: ora.id })).total).toBe(1);
    // the engine ignores a tampered job that points to another tenant's connection
    const other = await mkConn({ name: "B", credentialRef: "OTHERTOK" }, T2);
    const f = restFetch({ "/customers": [cust(9)] });
    const evil = await db.ErpSyncJob.create({ tenant_key: T, connection_id: other.id, capability: "CUSTOMER_MASTER", direction: "ERP_TO_DMS", status: "QUEUED", scope: w.cScope });
    const { runSync } = require("../services/erp/sync/syncEngine");
    expect((await runSync(db, evil.id, { fetchImpl: f, logger: () => {} })).status).toBe("FAILED"); expect(f).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════ ENGINE / GOVERNANCE ═════════════════════════════════════
describe("Engine & governance", () => {
  test("a run-level failure is recorded in the error table (scope RUN) without counting as a failed record", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const j = await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(401, {}) }));
    expect(j.counts.failed).toBe(0);
    expect((await sync.listJobErrors(db, T, j.id)).items).toEqual([expect.objectContaining({ scope: "RUN", code: "AUTHENTICATION_ERROR", retryable: false, recordIndex: null })]);
  });
  test("audit events use the existing log convention and never contain credentials", async () => {
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    await sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { enabled: true, frequency: "HOURLY", scope: w.pScope });
    await sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { frequency: "DAILY" });
    await sched.saveSchedule(db, T, 1, c.id, "PRODUCT_MASTER", { enabled: false });
    await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": [{ Code: "A", Title: "A" }] }));
    const bad = await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": () => json(500, {}) }));
    await sync.retryJob(db, T, 1, bad.id, D(restFetch({ "/products": [{ Code: "A", Title: "A" }] })));
    const lines = spy.mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith("[erp-audit]")).join("\n");
    for (const ev of ["ERP_SCHEDULE_CREATED", "ERP_SCHEDULE_UPDATED", "ERP_SCHEDULE_DISABLED", "ERP_SYNC_CREATED", "ERP_SYNC_STARTED", "ERP_SYNC_COMPLETED", "ERP_SYNC_FAILED", "ERP_SYNC_RETRIED"]) expect(lines).toContain(`event=${ev}`);
    expect(lines).not.toMatch(/bearer-tok|XYZ789|password/i);
  });
  test("new routes require an Admin session", () => {
    const wanted = ["/erp-sync/errors", "/erp-sync/schedules", "/erp-sync/schedules/:id", "/erp-sync/schedules/:id/run", "/erp-integrations/:id/schedules/:capability"];
    const routes = adminRoutes.stack.filter((l) => l.route && wanted.includes(l.route.path));
    expect(routes).toHaveLength(5); routes.forEach((l) => expect(l.route.stack[0].handle).toBe(requireAdmin));
  });
  test("controller flow: PUT schedule → GET schedules → POST run (202); validation errors are 4xx", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(json(200, { rows: [{ Code: "A", Title: "A" }] }));
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const put = await A(erp.saveSchedule, { params: { id: c.id, capability: "PRODUCT_MASTER" }, body: { enabled: true, frequency: "HOURLY", scope: w.pScope } });
    expect(put.statusCode).toBe(200); expect(put.jsonBody.enabled).toBe(true);
    expect((await A(erp.saveSchedule, { params: { id: c.id, capability: "PRODUCT_MASTER" }, body: { frequency: "EVERY_MINUTE" } })).statusCode).toBe(400);
    expect((await A(erp.saveSchedule, { params: { id: 9999, capability: "PRODUCT_MASTER" }, body: { frequency: "HOURLY" } })).statusCode).toBe(404);
    expect((await A(erp.listSchedules)).jsonBody.total).toBe(1);
    const run1 = await A(erp.runSchedule, { params: { id: put.jsonBody.id } }); expect(run1.statusCode).toBe(202);
    const end = Date.now() + 3000; let jb;
    for (;;) { jb = await db.ErpSyncJob.findOne(); if (jb && !["QUEUED", "RUNNING"].includes(jb.status)) break; if (Date.now() > end) throw new Error("scheduled job did not finish"); await new Promise((r) => setTimeout(r, 20)); }
    expect(jb).toMatchObject({ trigger_type: "SCHEDULED", status: "SUCCESS" });
    await new Promise((r) => setTimeout(r, 50)); // let the worker finish its schedule bookkeeping
  });
  test("neutrality: the generic layers (targets, scheduler, monitoring, engine) contain no SAP / OData vocabulary", () => {
    for (const f of ["services/erp/sync/targets.js", "services/erpScheduler.service.js", "services/erpMonitoring.service.js", "services/erp/sync/syncEngine.js"]) {
      expect(fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/\bsap\b|odata/i);
    }
  });
});

// ═════════════════════════════════════ MIGRATION ═════════════════════════════════════
describe("Migration (Phase 14 → 15)", () => {
  test("up/down/up is idempotent and reversible; existing errors are back-filled from their job; no business table is touched", async () => {
    const { Sequelize } = require("sequelize"); const qi = db.sequelize.getQueryInterface();
    const m = require("../migrations/20261008090000-erp-sync-phase15");
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const w = await world(); const c = await mkConn(); await mkMap(c, "PRODUCT_MASTER", PROD_MAP);
    const j = await run(c, "PRODUCT_MASTER", w.pScope, restFetch({ "/products": [{ Code: "X", Title: "" }, { Code: "Y", Title: "Ok" }] }));
    expect(j.counts.failed).toBe(1);
    await db.sequelize.query("PRAGMA foreign_keys = OFF");
    await m.down(qi, Sequelize);
    expect(await tables()).not.toContain("erp_sync_schedules"); expect(await cols("erp_sync_errors")).not.toContain("connection_id");
    await m.up(qi, Sequelize); await m.up(qi, Sequelize);
    expect(await tables()).toContain("erp_sync_schedules"); expect(await cols("erp_sync_errors")).toEqual(expect.arrayContaining(["connection_id", "capability"]));
    const [[row]] = await db.sequelize.query("SELECT connection_id, capability FROM erp_sync_errors LIMIT 1");
    expect(row).toEqual({ connection_id: c.id, capability: "PRODUCT_MASTER" });
    expect((await qi.showIndex("erp_sync_schedules")).map((i) => i.name)).toContain("uq_erp_sched_conn_cap");
    expect(await db.Product.count()).toBe(1); expect(await tables()).toEqual(expect.arrayContaining(["Products", "Customers", "Distributors", "PricingMasters", "Payments"]));
    await db.sequelize.query("PRAGMA foreign_keys = ON");
    await db.sequelize.sync({ force: true });
  });
});
