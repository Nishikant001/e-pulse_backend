// Phase 22 (D3) — the Purchase Order screen finds a vendor by code from the EXISTING distributor-scoped vendor list (GET /vendor); the
// non-existent /vendor/by-code/:code endpoint was NOT added. These tests pin the contract that lookup relies on:
//   * the list contains only the caller's own vendors and exposes `vendor_code`,
//   * another distributor's vendor (and its code) is never visible, by list or by id,
//   * an unknown code simply is not in the list.
// In-memory sqlite: behaviour/logic only.
const { db, resetDb, mockRes, seedDistributor } = require("./helpers");
const vendorCtl = require("../controllers/vendor.controller");

beforeEach(async () => { await resetDb(); jest.restoreAllMocks(); });
afterAll(async () => { await db.sequelize.close(); });

const reqFor = (d, extra = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, params: {}, body: {}, ...extra });
async function mkVendor(d, name) {
  const res = mockRes();
  await vendorCtl.create(reqFor(d, { body: { name, email: `${name.replace(/\s/g, "").toLowerCase()}@v.test`, phone: "9999999999", vendor_group: "GEN" } }), res);
  expect(res.statusCode).toBe(201);
  return res.jsonBody;
}
const listFor = async (d) => { const res = mockRes(); await vendorCtl.getAll(reqFor(d), res); expect(res.statusCode).toBe(200); return res.jsonBody; };

describe("vendor lookup by code (list-based, distributor scoped)", () => {
  test("own vendor is in the list and carries vendor_code", async () => {
    const d = await seedDistributor();
    const v = await mkVendor(d, "Alpha Pharma");
    const list = await listFor(d);
    const found = list.find((x) => String(x.vendor_code).toLowerCase() === String(v.vendor_code).toLowerCase());
    expect(found).toBeTruthy();
    expect(found.id).toBe(v.id);
    expect(v.vendor_code).toMatch(/^VDR\d{3}$/);
  });

  test("a vendor created after the first load appears on the next list call (the refresh path used by the screen)", async () => {
    const d = await seedDistributor();
    await mkVendor(d, "First");
    const before = await listFor(d);
    const later = await mkVendor(d, "Second");
    const after = await listFor(d);
    expect(before.find((x) => x.id === later.id)).toBeUndefined();
    expect(after.find((x) => x.id === later.id)).toBeTruthy();
  });

  test("cross-distributor: another distributor's vendor and code never appear in the list", async () => {
    const a = await seedDistributor(); const b = await seedDistributor();
    const va = await mkVendor(a, "A Vendor"); const vb = await mkVendor(b, "B Vendor");
    const listA = await listFor(a);
    expect(listA.map((x) => x.id)).toEqual([va.id]);
    expect(listA.find((x) => x.id === vb.id)).toBeUndefined();
    const listB = await listFor(b);
    expect(listB.map((x) => x.id)).toEqual([vb.id]);
  });

  test("cross-distributor: reading another distributor's vendor by id is 404", async () => {
    const a = await seedDistributor(); const b = await seedDistributor();
    const vb = await mkVendor(b, "B Vendor");
    const res = mockRes();
    await vendorCtl.getOne(reqFor(a, { params: { id: String(vb.id) } }), res);
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.jsonBody)).not.toContain("B Vendor");
  });

  test("an unknown or invalid code is simply absent from the list (no error, nothing disclosed)", async () => {
    const d = await seedDistributor();
    await mkVendor(d, "Only One");
    const list = await listFor(d);
    for (const code of ["VDR999", "", "'; DROP TABLE Vendors;--", "../etc/passwd"]) {
      expect(list.find((x) => String(x.vendor_code).toLowerCase() === code.toLowerCase())).toBeUndefined();
    }
    expect(await db.Vendor.count()).toBe(1);
  });

  test("the removed endpoint stays removed: no /vendor/by-code route is registered", () => {
    const routes = require("../routes/allRoutes");
    const paths = routes.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths).not.toContain("/vendor/by-code/:code");
    expect(paths).toContain("/vendor");
  });
});
