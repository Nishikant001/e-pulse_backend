// Phase 22 (D5) — customer_code / vendor_code generation picked "the last row by createdAt". MySQL DATETIME has 1-second precision, so rows
// created within one second TIE and the same code was generated twice (unique-constraint failure; reproduced on MariaDB 10.11: 37 suite
// failures, mostly this). The fix adds an "id" tie-breaker (the same pattern salesOrder.controller already used).
// SQLite keeps milliseconds, so the tie is simulated deterministically: the older row is given a LATER-or-equal createdAt than the newer one.
const { db, resetDb, seedDistributor } = require("./helpers");
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

async function mkCustomer(d, n) {
  const g = await db.CustomerGroup.create({ code: `G${n}`, name: "Retail", distributor_id: d.id });
  return db.Customer.create({ name: `C${n}`, distributor_id: d.id, customer_group_id: g.id });
}

test("customer codes stay unique and sequential when createdAt ties (same-second creation)", async () => {
  const d = await seedDistributor();
  const c1 = await mkCustomer(d, 1); const c2 = await mkCustomer(d, 2);
  expect([c1.customer_code, c2.customer_code]).toEqual(["CTR001", "CTR002"]);
  // identical createdAt for both rows = a MySQL same-second tie; with createdAt ordering alone, row 1 could be picked as "last"
  const t = new Date("2030-01-01T00:00:00Z");
  await db.sequelize.query("UPDATE Customers SET createdAt = :t", { replacements: { t: t.toISOString().replace("T", " ").replace("Z", "") } });
  const c3 = await mkCustomer(d, 3);
  expect(c3.customer_code).toBe("CTR003");
  const codes = (await db.Customer.findAll()).map((c) => c.customer_code);
  expect(new Set(codes).size).toBe(codes.length);
});

test("vendor codes stay unique and sequential when createdAt ties", async () => {
  const d = await seedDistributor();
  const mk = (n) => db.Vendor.create({ name: `V${n}`, vendor_group: "GEN", distributor_id: d.id });
  const v1 = await mk(1); const v2 = await mk(2);
  expect([v1.vendor_code, v2.vendor_code]).toEqual(["VDR001", "VDR002"]);
  await db.sequelize.query("UPDATE Vendors SET createdAt = :t", { replacements: { t: "2030-01-01 00:00:00" } });
  const v3 = await mk(3);
  expect(v3.vendor_code).toBe("VDR003");
});

test("distributor codes stay unique and sequential when createdAt ties", async () => {
  const mk = (n) => db.Distributor.create({ name: `D${n}`, email: `tie${n}@t.com`, password: "x" });
  const a = await mk(1); const b = await mk(2);
  expect([a.distributor_code, b.distributor_code]).toEqual(["DTC001", "DTC002"]);
  await db.sequelize.query("UPDATE Distributors SET createdAt = :t", { replacements: { t: "2030-01-01 00:00:00" } });
  const c = await mk(3);
  expect(c.distributor_code).toBe("DTC003");
});
