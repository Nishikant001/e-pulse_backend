// Phase 24 — Distributor Batch Master regression. The page (StockMaster.jsx) now manages batch IDENTITY through the existing /api/stock API and reads balances from the
// ledger (/api/stockLedger/batch). These tests pin that contract on the REAL app: no /batch endpoint, quantity is never a batch field, stock stays ledger-derived,
// product change / duplicate / date rules / delete-with-history are enforced by the server, and Distributor A can never see or touch Distributor B's batches.
const http = require("http");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "a".repeat(48);
const { db, resetDb, seedDistributor, seedProduct } = require("./helpers");

let server;
beforeAll(async () => { const app = require("../server"); await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); }); });
afterAll(async () => { server.close(); await db.sequelize.close(); });
beforeEach(async () => { await resetDb(); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

const tok = (d) => jwt.sign({ id: d.id, distributor_code: d.distributor_code }, process.env.JWT_SECRET, { expiresIn: 300 });
const call = (d, method, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: { authorization: `Bearer ${tok(d)}`, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } },
    (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() })); });
  r.on("error", reject); r.end(data);
});
const setup = async () => { const a = await seedDistributor(); const b = await seedDistributor(); return { a, b, pa: await seedProduct(a.id), pb: await seedProduct(b.id) }; };
const body = (p, o = {}) => ({ batch_no: "B-001", productId: p.id, mfg_date: "2026-01-01", exp_date: "2028-01-01", purchase_price: 10, mrp: 15, status: "active", ...o });

test("there is no /api/batch endpoint (the old page called one)", async () => {
  const { a } = await setup();
  for (const [m, p] of [["GET", "/api/batch"], ["POST", "/api/batch"], ["PUT", "/api/batch/1"], ["DELETE", "/api/batch/1"]]) expect((await call(a, m, p, m === "POST" || m === "PUT" ? {} : undefined)).status).toBe(404);
});
test("create → list → update through /api/stock; the list carries the product and NO quantity", async () => {
  const { a, pa } = await setup();
  const c = await call(a, "POST", "/api/stock", body(pa)); expect(c.status).toBe(201);
  const l = await call(a, "GET", "/api/stock"); expect(l.status).toBe(200); expect(l.json).toHaveLength(1);
  expect(l.json[0].product.name).toBe(pa.name); expect(l.json[0]).not.toHaveProperty("quantity");
  const u = await call(a, "PUT", `/api/stock/${c.json.batch.id}`, { mrp: 20, status: "inactive", mfg_date: "2026-02-01" }); expect(u.status).toBe(200);
  expect(Number(u.json.batch.mrp)).toBe(20); expect(u.json.batch.status).toBe("inactive");
});
test("a quantity sent to the batch API is NOT stored (stock is ledger-only)", async () => {
  const { a, pa } = await setup();
  const c = await call(a, "POST", "/api/stock", { ...body(pa), quantity: 500 }); expect(c.status).toBe(201);
  expect(c.json.batch.quantity).toBeUndefined();
  const bal = await call(a, "GET", "/api/stockLedger/batch"); expect(bal.json.find((r) => r.batchId === c.json.batch.id)).toBeUndefined(); // no ledger row → no balance
  const u = await call(a, "PUT", `/api/stock/${c.json.batch.id}`, { quantity: 900 }); expect(u.status).toBe(200);
  expect(await db.StockLedger.count({ where: { batchId: c.json.batch.id } })).toBe(0);
});
test("balance shown by the page comes from the ledger: opening-stock IN then OUT gives the net quantity", async () => {
  const { a, pa } = await setup();
  const id = (await call(a, "POST", "/api/stock", body(pa))).json.batch.id;
  expect((await call(a, "POST", "/api/stockLedger/in", { productId: pa.id, batchId: id, quantity: 100 })).status).toBeLessThan(300);
  expect((await call(a, "POST", "/api/stockLedger/out", { productId: pa.id, batchId: id, quantity: 30 })).status).toBeLessThan(300);
  const row = (await call(a, "GET", "/api/stockLedger/batch")).json.find((r) => r.batchId === id); expect(row.quantity).toBe(70);
});
test("server validation the page relies on: required fields, duplicate batch, dates, money, status", async () => {
  const { a, pa } = await setup();
  await call(a, "POST", "/api/stock", body(pa));
  expect((await call(a, "POST", "/api/stock", body(pa))).json.code).toBe("DUPLICATE_BATCH");
  expect((await call(a, "POST", "/api/stock", body(pa, { batch_no: "B-2", exp_date: "2025-12-31" }))).json.code).toBe("EXPIRY_BEFORE_MFG");
  expect((await call(a, "POST", "/api/stock", body(pa, { batch_no: "B-3", mfg_date: "2999-01-01", exp_date: "3000-01-01" }))).json.code).toBe("MFG_IN_FUTURE");
  expect((await call(a, "POST", "/api/stock", body(pa, { batch_no: "B-4", mrp: -1 }))).json.code).toBe("INVALID_AMOUNT");
  expect((await call(a, "POST", "/api/stock", body(pa, { batch_no: "B-5", status: "available" }))).json.code).toBe("INVALID_STATUS");
  expect((await call(a, "POST", "/api/stock", { batch_no: "B-6" })).status).toBe(400);
});
test("a batch cannot be moved to another product (productId ignored on update)", async () => {
  const { a, pa } = await setup(); const p2 = await seedProduct(a.id);
  const id = (await call(a, "POST", "/api/stock", body(pa))).json.batch.id;
  await call(a, "PUT", `/api/stock/${id}`, { productId: p2.id, mrp: 99 });
  expect((await db.Batch.findByPk(id)).productId).toBe(pa.id);
});
test("delete is refused when the batch has ledger history; allowed (and removes the row) when it has none", async () => {
  const { a, pa } = await setup();
  const used = (await call(a, "POST", "/api/stock", body(pa))).json.batch.id;
  await call(a, "POST", "/api/stockLedger/in", { productId: pa.id, batchId: used, quantity: 5 });
  const r = await call(a, "DELETE", `/api/stock/${used}`); expect(r.status).toBe(400); expect(await db.Batch.findByPk(used)).not.toBeNull();
  const free = (await call(a, "POST", "/api/stock", body(pa, { batch_no: "B-FREE" }))).json.batch.id;
  expect((await call(a, "DELETE", `/api/stock/${free}`)).status).toBe(200); expect(await db.Batch.findByPk(free)).toBeNull();
});
test("tenant isolation: B cannot list, read, update, delete or create against A's batches/products", async () => {
  const { a, b, pa, pb } = await setup();
  const id = (await call(a, "POST", "/api/stock", body(pa))).json.batch.id;
  await call(b, "POST", "/api/stock", body(pb));
  expect((await call(b, "GET", "/api/stock")).json.map((x) => x.id)).not.toContain(id);
  expect((await call(b, "GET", `/api/stock/${id}`)).status).toBe(404);
  expect((await call(b, "PUT", `/api/stock/${id}`, { mrp: 1 })).status).toBe(404);
  expect((await call(b, "DELETE", `/api/stock/${id}`)).status).toBe(404);
  expect((await call(b, "POST", "/api/stock", body(pa, { batch_no: "X" }))).status).toBe(404); // product of A
  expect(Number((await db.Batch.findByPk(id)).mrp)).toBe(15);
  await call(a, "POST", "/api/stockLedger/in", { productId: pa.id, batchId: id, quantity: 7 });
  expect((await call(b, "GET", "/api/stockLedger/batch")).json.find((r) => r.batchId === id)).toBeUndefined();
});
test("unauthenticated calls to the batch API are refused", async () => {
  await setup();
  const r = await new Promise((res) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/stock" }, (q) => { q.resume(); res(q.statusCode); })); expect(r).toBe(401);
});
