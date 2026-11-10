// Phase 9 — Retailer Management. Same in-memory sqlite + direct-controller convention as Phases 7/8.
const jwt = require("jsonwebtoken");
const { db, resetDb, mockRes, seedDistributor } = require("./helpers");
const adminCtrl = require("../controllers/admin.retailers.controller");
const distCtrl = require("../controllers/retailer.controller");
const salesOrder = require("../controllers/salesOrder.controller");
const legacyCustomer = require("../controllers/customer.controller");
const requireAdmin = require("../middleware/adminAuth");

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

const adminReq = (o = {}) => ({ admin: { id: 1, name: "Admin", role: "ADMIN" }, body: {}, params: {}, query: {}, ...o });
const distReq = (d, o = {}) => ({ user: { id: d.id, distributor_code: d.distributor_code }, body: {}, params: {}, query: {}, ...o });
const callAdmin = async (fn, o) => {
  const res = mockRes();
  await fn(adminReq(o), res);
  return res;
};
const callDist = async (fn, d, o) => {
  const res = mockRes();
  await fn(distReq(d, o), res);
  return res;
};

let seq = 0;
async function seedGroup(distributorId) {
  seq += 1;
  return db.CustomerGroup.create({ code: `G${seq}`, name: `Group ${seq}`, distributor_id: distributorId });
}
async function seedRetailer(d, o = {}) {
  const g = await seedGroup(d.id);
  seq += 1;
  return db.Customer.create({
    name: `Retailer ${seq}`, distributor_id: d.id, customer_group_id: g.id, city: "Pune", region: "Maharashtra", phone_number: "9876543210", pincode: "411001", ...o,
  });
}
const body = (groupId, o = {}) => ({
  name: "City Chemist", contact_person: "Anil", phone_number: "+91 98765 43210", email: "Anil@City.example.com", street1: "5 Main Road", city: "Pune",
  region: "Maharashtra", pincode: "411001", taxNumber: "27abcde1234f1z5", pan: "abcde1234f", territory: "Pune East", customer_group_id: groupId, ...o,
});

describe("Admin", () => {
  test("creates a retailer for a chosen distributor (normalised, generated code, optional shipping address)", async () => {
    const d = await seedDistributor();
    const g = await seedGroup(d.id);
    const res = await callAdmin(adminCtrl.create, {
      body: body(g.id, { distributor_id: d.id, status: "pending", shipping: { street1: "Godown 2", city: "Pune", region: "Maharashtra", pincode: "411002" } }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.code).toMatch(/^CTR\d+$/);
    const row = await db.Customer.findByPk(res.jsonBody.id);
    expect(row.distributor_id).toBe(d.id);
    expect(row.status).toBe("pending");
    expect(row.email).toBe("anil@city.example.com");
    expect(row.taxNumber).toBe("27ABCDE1234F1Z5");
    expect(row.postalCode).toBe("411001");
    expect((await db.Address.findOne({ where: { customer_id: row.id, type: "ship_to_party" } })).street1).toBe("Godown 2");
  });

  test("field errors, unknown distributor, group of a different distributor, duplicate GSTIN (per distributor)", async () => {
    const d1 = await seedDistributor();
    const d2 = await seedDistributor();
    const g1 = await seedGroup(d1.id);
    const g2 = await seedGroup(d2.id);

    const bad = await callAdmin(adminCtrl.create, { body: { email: "x", phone_number: "1", pincode: "1", taxNumber: "BAD", pan: "BAD" } });
    expect(bad.statusCode).toBe(400);
    for (const f of ["name", "street1", "city", "region", "phone_number", "email", "pincode", "taxNumber", "pan", "customer_group_id", "distributor_id"]) expect(bad.jsonBody.details[f]).toBeTruthy();

    expect((await callAdmin(adminCtrl.create, { body: body(g1.id, { distributor_id: 9999 }) })).statusCode).toBe(400);
    expect((await callAdmin(adminCtrl.create, { body: body(g2.id, { distributor_id: d1.id }) })).jsonBody.details.customer_group_id).toBeTruthy();

    expect((await callAdmin(adminCtrl.create, { body: body(g1.id, { distributor_id: d1.id }) })).statusCode).toBe(201);
    const dup = await callAdmin(adminCtrl.create, { body: body(g1.id, { distributor_id: d1.id }) });
    expect(dup.statusCode).toBe(409);
    // same GSTIN under a DIFFERENT distributor is a legitimate separate customer record
    expect((await callAdmin(adminCtrl.create, { body: body(g2.id, { distributor_id: d2.id }) })).statusCode).toBe(201);
  });

  test("cannot assign a new retailer to an inactive distributor", async () => {
    const d = await seedDistributor({ status: "inactive" });
    const g = await seedGroup(d.id);
    expect((await callAdmin(adminCtrl.create, { body: body(g.id, { distributor_id: d.id }) })).statusCode).toBe(409);
  });

  test("list: search, filters (distributor/state/city/status), sort, pagination, distributor shown", async () => {
    const a = await seedDistributor({ name: "Dist A" });
    const b = await seedDistributor({ name: "Dist B" });
    await seedRetailer(a, { name: "Alpha Meds", city: "Pune", region: "Maharashtra" });
    await seedRetailer(a, { name: "Beta Chemist", city: "Surat", region: "Gujarat", status: "inactive" });
    await seedRetailer(b, { name: "Gamma Store", city: "Pune", region: "Maharashtra", contact_person: "Zoya" });

    const all = await callAdmin(adminCtrl.list, { query: {} });
    expect(all.jsonBody.total).toBe(3);
    expect(all.jsonBody.items[0].distributor.name).toBe("Dist A");
    expect((await callAdmin(adminCtrl.list, { query: { distributorId: String(b.id) } })).jsonBody.items.map((i) => i.name)).toEqual(["Gamma Store"]);
    expect((await callAdmin(adminCtrl.list, { query: { status: "inactive" } })).jsonBody.total).toBe(1);
    expect((await callAdmin(adminCtrl.list, { query: { state: "Maharashtra" } })).jsonBody.total).toBe(2);
    expect((await callAdmin(adminCtrl.list, { query: { city: "Surat" } })).jsonBody.total).toBe(1);
    expect((await callAdmin(adminCtrl.list, { query: { q: "zoya" } })).jsonBody.items.map((i) => i.name)).toEqual(["Gamma Store"]);
    expect((await callAdmin(adminCtrl.list, { query: { q: "%" } })).jsonBody.total).toBe(0);
    const sorted = await callAdmin(adminCtrl.list, { query: { sort: "name", dir: "desc", pageSize: "2" } });
    expect(sorted.jsonBody.items.map((i) => i.name)).toEqual(["Gamma Store", "Beta Chemist"]);
    expect(sorted.jsonBody.total).toBe(3);
    expect((await callAdmin(adminCtrl.list, { query: { sort: "password" } })).statusCode).toBe(400);
  });

  test("detail, edit, deactivate / activate", async () => {
    const d = await seedDistributor();
    const r = await seedRetailer(d, { name: "Old Name" });
    const detail = await callAdmin(adminCtrl.get, { params: { id: String(r.id) } });
    expect(detail.statusCode).toBe(200);
    expect(detail.jsonBody.distributor.code).toBe(d.distributor_code);
    expect(detail.jsonBody.summary.outstanding).toBeNull();
    expect(detail.jsonBody.summary.creditLimit).toBeNull();

    const up = await callAdmin(adminCtrl.update, { params: { id: String(r.id) }, body: { name: "New Name", territory: "North", distributor_id: 555, customer_code: "HACK" } });
    expect(up.statusCode).toBe(400); // an admin cannot move ownership through edit either
    expect(up.jsonBody.code).toBe("USE_REASSIGN");
    const up2 = await callAdmin(adminCtrl.update, { params: { id: String(r.id) }, body: { name: "New Name", territory: "North", customer_code: "HACK", status: "inactive" } });
    expect(up2.statusCode).toBe(200);
    const row = await db.Customer.findByPk(r.id);
    expect(row.name).toBe("New Name");
    expect(row.customer_code).toBe(r.customer_code);
    expect(row.status).toBe("active"); // status only changes through the status endpoint

    expect((await callAdmin(adminCtrl.setStatus, { params: { id: String(r.id) }, body: { status: "inactive", reason: "Closed" } })).statusCode).toBe(200);
    expect((await db.Customer.findByPk(r.id)).status_reason).toBe("Closed");
    expect((await callAdmin(adminCtrl.setStatus, { params: { id: String(r.id) }, body: { status: "inactive" } })).statusCode).toBe(409);
    expect((await callAdmin(adminCtrl.setStatus, { params: { id: String(r.id) }, body: { status: "active" } })).statusCode).toBe(200);
    expect((await callAdmin(adminCtrl.get, { params: { id: "9999" } })).statusCode).toBe(404);
  });

  test("reassigns a retailer to another distributor; history stays put; new owner does not see old paperwork", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const r = await seedRetailer(a);
    const gB = await seedGroup(b.id);
    const gA = await seedGroup(a.id);
    await db.SalesOrderHeader.create({ distributor_id: a.id, distributor_code: a.distributor_code, customerId: r.id, order_number: "SO-1", status: "CANCELLED", totalAmount: 100, orderDate: new Date() });

    expect((await callAdmin(adminCtrl.assign, { params: { id: String(r.id) }, body: { distributor_id: b.id, customer_group_id: gA.id } })).statusCode).toBe(400); // group of the OLD distributor
    expect((await callAdmin(adminCtrl.assign, { params: { id: String(r.id) }, body: { distributor_id: a.id, customer_group_id: gA.id } })).statusCode).toBe(409); // no-op

    const ok = await callAdmin(adminCtrl.assign, { params: { id: String(r.id) }, body: { distributor_id: b.id, customer_group_id: gB.id } });
    expect(ok.statusCode).toBe(200);
    const row = await db.Customer.findByPk(r.id);
    expect(row.distributor_id).toBe(b.id);
    expect(row.customer_code).toBe(r.customer_code);
    const order = await db.SalesOrderHeader.findOne({ where: { order_number: "SO-1" } });
    expect(order.distributor_id).toBe(a.id); // history untouched

    expect((await callDist(distCtrl.get, b, { params: { id: String(r.id) } })).jsonBody.recentOrders).toEqual([]); // old distributor's paperwork not shown to the new owner
    expect((await callAdmin(adminCtrl.get, { params: { id: String(r.id) } })).jsonBody.recentOrders).toHaveLength(1);
    expect((await callDist(distCtrl.get, a, { params: { id: String(r.id) } })).statusCode).toBe(403); // the previous owner lost access
  });

  test("reassignment is blocked while there are open orders or an unsettled balance", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const r = await seedRetailer(a);
    const gB = await seedGroup(b.id);
    const order = await db.SalesOrderHeader.create({ distributor_id: a.id, distributor_code: a.distributor_code, customerId: r.id, order_number: "SO-9", status: "CONFIRMED", totalAmount: 100, orderDate: new Date() });
    const blocked = await callAdmin(adminCtrl.assign, { params: { id: String(r.id) }, body: { distributor_id: b.id, customer_group_id: gB.id } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.jsonBody.code).toBe("REASSIGN_BLOCKED");
    expect((await db.Customer.findByPk(r.id)).distributor_id).toBe(a.id);
    await order.update({ status: "CANCELLED" });
    expect((await callAdmin(adminCtrl.assign, { params: { id: String(r.id) }, body: { distributor_id: b.id, customer_group_id: gB.id } })).statusCode).toBe(200);
  });

  test("lookups give the admin distributors, groups and filter values", async () => {
    const d = await seedDistributor();
    await seedRetailer(d);
    const res = await callAdmin(adminCtrl.lookups, {});
    expect(res.jsonBody.distributors.map((x) => x.id)).toContain(d.id);
    expect(res.jsonBody.customerGroups.length).toBeGreaterThan(0);
    expect(res.jsonBody.states).toContain("Maharashtra");
  });
});

describe("Distributor — isolation and ownership", () => {
  test("sees ONLY its own retailers (list, counts, lookups) and no distributor info", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    await seedRetailer(a, { name: "Mine 1" });
    await seedRetailer(a, { name: "Mine 2" });
    await seedRetailer(b, { name: "Theirs", city: "Delhi", region: "Delhi" });

    const list = await callDist(distCtrl.list, a, { query: {} });
    expect(list.jsonBody.items.map((i) => i.name).sort()).toEqual(["Mine 1", "Mine 2"]);
    expect(list.jsonBody.items[0].distributor).toBeUndefined();

    // trying to widen the scope through the query string changes nothing
    const spoof = await callDist(distCtrl.list, a, { query: { distributorId: String(b.id), distributor_id: String(b.id) } });
    expect(spoof.jsonBody.items.map((i) => i.name).sort()).toEqual(["Mine 1", "Mine 2"]);
    expect((await callDist(distCtrl.list, a, { query: { q: "Theirs" } })).jsonBody.total).toBe(0);

    const lk = await callDist(distCtrl.lookups, a, {});
    expect(lk.jsonBody.states).not.toContain("Delhi");
    expect(lk.jsonBody.distributors).toBeUndefined();
    expect(lk.jsonBody.customerGroups.every((g) => g.distributorId === a.id)).toBe(true);
  });

  test("another distributor's retailer is 403 for view, edit and status — and nothing changes", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const theirs = await seedRetailer(b, { name: "Theirs" });
    const params = { id: String(theirs.id) };

    const view = await callDist(distCtrl.get, a, { params });
    expect(view.statusCode).toBe(403);
    expect(JSON.stringify(view.jsonBody)).not.toMatch(/Theirs|CTR|Pune/);
    expect((await callDist(distCtrl.update, a, { params, body: { name: "Hacked" } })).statusCode).toBe(403);
    expect((await callDist(distCtrl.setStatus, a, { params, body: { status: "inactive" } })).statusCode).toBe(403);
    const row = await db.Customer.findByPk(theirs.id);
    expect(row.name).toBe("Theirs");
    expect(row.status).toBe("active");
    expect((await callDist(distCtrl.get, a, { params: { id: "99999" } })).statusCode).toBe(404);
  });

  test("create: auto-owned by the logged-in distributor; a foreign distributor_id is rejected; group must be its own", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const gA = await seedGroup(a.id);
    const gB = await seedGroup(b.id);

    const ok = await callDist(distCtrl.create, a, { body: body(gA.id, { status: "inactive" }) });
    expect(ok.statusCode).toBe(201);
    const row = await db.Customer.findByPk(ok.jsonBody.id);
    expect(row.distributor_id).toBe(a.id);
    expect(row.status).toBe("active"); // a distributor cannot pick pending / inactive at creation

    const hijack = await callDist(distCtrl.create, a, { body: body(gA.id, { taxNumber: "29ABCDE1234F1Z5", distributor_id: b.id }) });
    expect(hijack.statusCode).toBe(403);
    expect(await db.Customer.count({ where: { distributor_id: b.id } })).toBe(0);
    expect((await callDist(distCtrl.create, a, { body: body(gA.id, { taxNumber: "29ABCDE1234F1Z5", distributor_code: b.distributor_code }) })).statusCode).toBe(403);
    // equal id is harmless
    expect((await callDist(distCtrl.create, a, { body: body(gA.id, { taxNumber: "29ABCDE1234F1Z5", distributor_id: a.id }) })).statusCode).toBe(201);
    // someone else's group is refused
    expect((await callDist(distCtrl.create, a, { body: body(gB.id, { taxNumber: "07ABCDE1234F1Z5" }) })).statusCode).toBe(400);
  });

  test("edit own retailer works; ownership cannot be changed through edit", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const mine = await seedRetailer(a);
    const ok = await callDist(distCtrl.update, a, { params: { id: String(mine.id) }, body: { name: "Renamed", city: "Nashik" } });
    expect(ok.statusCode).toBe(200);
    expect((await db.Customer.findByPk(mine.id)).name).toBe("Renamed");

    const move = await callDist(distCtrl.update, a, { params: { id: String(mine.id) }, body: { name: "Moved", distributor_id: b.id } });
    expect(move.statusCode).toBe(403);
    const row = await db.Customer.findByPk(mine.id);
    expect(row.distributor_id).toBe(a.id);
    expect(row.name).toBe("Renamed");
  });

  test("can deactivate / reactivate its own retailer; pending is admin-only; history is kept", async () => {
    const a = await seedDistributor();
    const mine = await seedRetailer(a);
    const order = await db.SalesOrderHeader.create({ distributor_id: a.id, distributor_code: a.distributor_code, customerId: mine.id, order_number: "SO-3", status: "CONFIRMED", totalAmount: 10, orderDate: new Date() });
    expect((await callDist(distCtrl.setStatus, a, { params: { id: String(mine.id) }, body: { status: "inactive", reason: "Stopped buying" } })).statusCode).toBe(200);
    expect(await db.SalesOrderHeader.findByPk(order.id)).toBeTruthy();
    expect((await callDist(distCtrl.setStatus, a, { params: { id: String(mine.id) }, body: { status: "active" } })).statusCode).toBe(200);

    const pending = await seedRetailer(a, { status: "pending" });
    expect((await callDist(distCtrl.setStatus, a, { params: { id: String(pending.id) }, body: { status: "active" } })).statusCode).toBe(403);
    expect((await callAdmin(adminCtrl.setStatus, { params: { id: String(pending.id) }, body: { status: "active" } })).statusCode).toBe(200);
  });

  test("has no assign / reassign capability at all", async () => {
    expect(distCtrl.assign).toBeUndefined();
    expect(distCtrl.reassign).toBeUndefined();
    expect(distCtrl.remove).toBeUndefined();
    const routes = require("../routes/allRoutes").stack.filter((l) => l.route && l.route.path.startsWith("/retailers")).map((l) => l.route.path);
    expect(routes.some((p) => /assign|reassign/.test(p))).toBe(false);
  });

  test("a deactivated distributor is locked out of retailer data even with a valid token", async () => {
    const a = await seedDistributor({ status: "inactive" });
    const res = await callDist(distCtrl.list, a, { query: {} });
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody.code).toBe("DISTRIBUTOR_INACTIVE");
  });

  test("detail shows only real data for its own retailer, scoped to its own documents", async () => {
    const a = await seedDistributor();
    const mine = await seedRetailer(a);
    await db.SalesOrderHeader.create({ distributor_id: a.id, distributor_code: a.distributor_code, customerId: mine.id, order_number: "SO-7", status: "CONFIRMED", totalAmount: 250, orderDate: new Date() });
    const res = await callDist(distCtrl.get, a, { params: { id: String(mine.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.summary.orderCount).toBe(1);
    expect(res.jsonBody.recentOrders[0].number).toBe("SO-7");
    expect(res.jsonBody.summary.outstanding).toBeNull();
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/password|reset_otp/i);
  });
});

describe("Access model", () => {
  test("a Distributor token cannot open Admin retailer APIs (requireAdmin ignores the distributor cookie / bearer)", async () => {
    const d = await seedDistributor();
    const token = jwt.sign({ id: d.id, distributor_code: d.distributor_code }, process.env.JWT_SECRET || "test-secret");
    const res = mockRes();
    const next = jest.fn();
    await requireAdmin({ cookies: { access_token: token }, headers: { authorization: `Bearer ${token}` } }, Object.assign(res, { set: jest.fn() }), next);
    expect(next).not.toHaveBeenCalled();
    expect([401, 503]).toContain(res.statusCode);
    const guarded = require("../routes/adminRoutes").stack.filter((l) => l.route && l.route.path.startsWith("/retailers")).map((l) => l.route.stack.some((s) => s.handle === requireAdmin));
    expect(guarded.length).toBe(7);
    expect(guarded.every(Boolean)).toBe(true);
  });

  test("NO retailer login / auth / dashboard / portal exists", async () => {
    const auth = require("../controllers/auth.controller");
    expect(Object.keys(auth).filter((k) => /retailer/i.test(k))).toEqual([]);
    const customerAttrs = Object.keys(db.Customer.rawAttributes);
    expect(customerAttrs).not.toContain("password");
    expect(customerAttrs).not.toContain("reset_otp");
    const all = require("../routes/allRoutes").stack.filter((l) => l.route).map((l) => l.route.path);
    expect(all.filter((p) => /retailer.*(login|register|auth|token|password|dashboard)/i.test(p))).toEqual([]);
  });
});

describe("Transactions and existing behaviour", () => {
  test("an inactive retailer cannot receive NEW orders; an active one still can be looked up as before", async () => {
    const d = await seedDistributor();
    const r = await seedRetailer(d, { status: "inactive" });
    const res = mockRes();
    await salesOrder.create({ user: { id: d.id, distributor_code: d.distributor_code }, body: { customerId: r.id, lines: [{ productId: 1, quantity: 1 }] } }, res);
    expect(res.statusCode).toBe(409);
    expect(await db.SalesOrderHeader.count()).toBe(0);
  });

  test("legacy DELETE refuses to hard-delete a retailer with history, but still deletes a clean one", async () => {
    const d = await seedDistributor();
    const withHistory = await seedRetailer(d);
    const clean = await seedRetailer(d);
    await db.SalesOrderHeader.create({ distributor_id: d.id, distributor_code: d.distributor_code, customerId: withHistory.id, order_number: "SO-5", status: "CANCELLED", totalAmount: 1, orderDate: new Date() });
    const blocked = mockRes();
    await legacyCustomer.delete({ user: { id: d.id }, params: { id: String(withHistory.id) } }, blocked);
    expect(blocked.statusCode).toBe(409);
    expect(await db.Customer.findByPk(withHistory.id)).toBeTruthy();
    const okRes = mockRes();
    await legacyCustomer.delete({ user: { id: d.id }, params: { id: String(clean.id) } }, okRes);
    expect(await db.Customer.findByPk(clean.id)).toBeNull();
  });

  test("existing customers default to active and the legacy tenant-scoped reads still work", async () => {
    const d = await seedDistributor();
    const r = await seedRetailer(d);
    expect((await db.Customer.findByPk(r.id)).status).toBe("active");
    const res = mockRes();
    await legacyCustomer.getAll({ user: { id: d.id } }, res);
    expect(res.jsonBody).toHaveLength(1);
  });
});
