// Phase 25 — Super Admin dashboard. REAL Express admin router (tests/helpers-http.js), in-memory sqlite.
const { db, resetDb, seedDistributor, seedCustomer } = require("./helpers");
const H = require("./helpers-http");

let server; let call;
beforeAll(async () => { server = await H.listen(H.buildApp()); call = H.client(server); });
afterAll(async () => { server.close(); await db.sequelize.close(); });
beforeEach(async () => { await resetDb(); });

const body = (o = {}) => ({
  name: "Sharma Pharma", contact_person: "Ravi", email: "ravi@sharma.example.com", phone_number: "+91 98765 43210",
  street1: "12 Market Road", city: "Pune", region: "Maharashtra", postal_code: "411001", tax_no: "27ABCDE1234F1Z5", pan: "ABCDE1234F", ...o,
});

describe("access control", () => {
  test("unauthenticated → 401, no-store", async () => {
    for (const p of ["/superadmin/overview", "/superadmin/admins/1/distributors"]) {
      const r = await call("GET", p);
      expect(r.status).toBe(401);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });
  test("plain ADMIN and ERP roles → 403 FORBIDDEN, no-store, no data", async () => {
    for (const role of ["ADMIN", "ERP_ADMIN", "ERP_VIEWER"]) {
      const a = await H.adminCookie(role);
      for (const p of ["/superadmin/overview", `/superadmin/admins/${a.id}/distributors`]) {
        const r = await call("GET", p, { cookie: a.cookie });
        expect(r.status).toBe(403);
        expect(r.json.code).toBe("FORBIDDEN");
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.json.admins).toBeUndefined();
      }
    }
  });
  test("a lower-case / padded role value is normalised", async () => {
    const a = await H.adminCookie(" super_admin ");
    expect((await call("GET", "/superadmin/overview", { cookie: a.cookie })).status).toBe(200);
  });
  test("an inactive SUPER_ADMIN is rejected (401)", async () => {
    const a = await H.adminCookie("SUPER_ADMIN", { active: false });
    expect((await call("GET", "/superadmin/overview", { cookie: a.cookie })).status).toBe(401);
  });
});



describe("live platform endpoints", () => {
  test("roles come from the backend permission map", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const r = await call("GET", "/superadmin/roles", { cookie: sup.cookie });
    expect(r.status).toBe(200);
    expect(r.json.permissions).toContain("ERP_VIEW");
    expect(r.json.roles.map((x) => x.id)).toEqual(expect.arrayContaining(["SUPER_ADMIN", "ERP_ADMIN", "ERP_OPERATOR", "ERP_VIEWER", "ADMIN"]));
  });

  test("network and onboarding endpoints return database rows only", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    await seedDistributor({ status: "pending", name: "Live Pending Distributor" });
    await seedDistributor({ status: "active", name: "Live Active Distributor" });
    const all = await call("GET", "/superadmin/distributors", { cookie: sup.cookie });
    expect(all.status).toBe(200);
    expect(all.json).toHaveLength(2);
    expect(all.json.map((x) => x.name)).toEqual(expect.arrayContaining(["Live Pending Distributor", "Live Active Distributor"]));
    const pending = await call("GET", "/superadmin/onboarding", { cookie: sup.cookie });
    expect(pending.status).toBe(200);
    expect(pending.json).toHaveLength(1);
    expect(pending.json[0].business).toBe("Live Pending Distributor");
  });
});

describe("Super Admin admin creation", () => {
  test("only a Super Admin can create an admin account and password is hashed", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const body = { name: "Jiban Jena", email: "jiban.admin@example.com", password: "Strong-Admin-Password-123", role: "ERP_ADMIN" };
    const r = await call("POST", "/superadmin/admins", { cookie: sup.cookie, body });
    expect(r.status).toBe(201);
    expect(r.json.admin).toMatchObject({ name: body.name, email: body.email, role: "ERP_ADMIN", isActive: true });
    const saved = await db.AdminUser.findOne({ where: { email: body.email } });
    expect(saved.password_hash).not.toBe(body.password);
    expect(await require("bcryptjs").compare(body.password, saved.password_hash)).toBe(true);
    const duplicate = await call("POST", "/superadmin/admins", { cookie: sup.cookie, body });
    expect(duplicate.status).toBe(409);
  });

  test("non-super-admin cannot create admin accounts", async () => {
    const adm = await H.adminCookie("ADMIN");
    const r = await call("POST", "/superadmin/admins", {
      cookie: adm.cookie,
      body: { name: "Blocked", email: "blocked@example.com", password: "Strong-Admin-Password-123", role: "ERP_VIEWER" },
    });
    expect(r.status).toBe(403);
  });

  test("invalid roles and short passwords are rejected", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const base = { name: "Valid Name", email: "valid@example.com", password: "Strong-Admin-Password-123", role: "ERP_ADMIN" };
    expect((await call("POST", "/superadmin/admins", { cookie: sup.cookie, body: { ...base, role: "FAKE_ROLE" } })).status).toBe(400);
    expect((await call("POST", "/superadmin/admins", { cookie: sup.cookie, body: { ...base, email: "short@example.com", password: "short" } })).status).toBe(400);
  });
});

describe("overview", () => {
  test("returns correct counts per admin and totals, never password_hash", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const adm = await H.adminCookie("ADMIN");
    const idle = await H.adminCookie("ADMIN", { active: false });
    await seedDistributor({ created_by_admin_id: sup.id, status: "active" });
    await seedDistributor({ created_by_admin_id: sup.id, status: "pending" });
    const d3 = await seedDistributor({ created_by_admin_id: adm.id, status: "inactive" });
    await seedDistributor({ status: "active" }); // self-signup / legacy → unassigned
    await seedCustomer(d3.id);
    await seedCustomer(d3.id);

    const r = await call("GET", "/superadmin/overview", { cookie: sup.cookie });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json.totals).toEqual({
      admins: { total: 3, active: 2, inactive: 1 },
      distributors: { total: 4, active: 2, inactive: 1, pending: 1, unassigned: 1 },
      retailers: 2,
    });
    const by = Object.fromEntries(r.json.admins.map((a) => [a.id, a]));
    expect(by[sup.id]).toMatchObject({ role: "SUPER_ADMIN", isActive: true, distributorsCreated: 2, activeDistributors: 1, inactiveDistributors: 0, pendingDistributors: 1 });
    expect(by[adm.id]).toMatchObject({ distributorsCreated: 1, inactiveDistributors: 1 });
    expect(by[idle.id]).toMatchObject({ isActive: false, distributorsCreated: 0 });
    expect(Object.keys(by[sup.id]).sort()).toEqual(["activeDistributors", "createdAt", "distributorsCreated", "email", "id", "inactiveDistributors", "isActive", "lastLoginAt", "name", "pendingDistributors", "role"]);
    expect(r.text).not.toMatch(/password/i);
    expect(typeof r.json.generatedAt).toBe("string");
  });
});

describe("admin distributors", () => {
  test("lists only that admin's distributors; 404 for unknown admin; 400 for a bad id", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const adm = await H.adminCookie("ADMIN");
    const mine = await seedDistributor({ created_by_admin_id: adm.id, city: "Pune", status: "active" });
    await seedDistributor({ created_by_admin_id: sup.id });
    const r = await call("GET", `/superadmin/admins/${adm.id}/distributors`, { cookie: sup.cookie });
    expect(r.status).toBe(200);
    expect(r.json.admin).toEqual({ id: adm.id, name: adm.admin.name, email: adm.admin.email });
    expect(r.json.distributors).toHaveLength(1);
    expect(r.json.distributors[0]).toMatchObject({ id: mine.id, code: mine.distributor_code, name: mine.name, city: "Pune", status: "active" });
    expect(Object.keys(r.json.distributors[0]).sort()).toEqual(["city", "code", "createdAt", "id", "name", "status"]);
    expect(r.text).not.toMatch(/password/i);
    expect((await call("GET", "/superadmin/admins/99999/distributors", { cookie: sup.cookie })).status).toBe(404);
    expect((await call("GET", "/superadmin/admins/abc/distributors", { cookie: sup.cookie })).status).toBe(400);
  });
});

describe("created_by_admin_id stamping", () => {
  test("creating a distributor through the admin API records the creating admin and shows up in the overview", async () => {
    const sup = await H.adminCookie("SUPER_ADMIN");
    const adm = await H.adminCookie("ADMIN");
    const c = await call("POST", "/distributors", { cookie: adm.cookie, body: body() });
    expect(c.status).toBe(201);
    expect((await db.Distributor.findByPk(c.json.id)).created_by_admin_id).toBe(adm.id);
    const o = await call("GET", "/superadmin/overview", { cookie: sup.cookie });
    expect(o.json.admins.find((a) => a.id === adm.id)).toMatchObject({ distributorsCreated: 1, pendingDistributors: 1 });
    expect(o.json.totals.distributors.unassigned).toBe(0);
  });
  test("the service still works with two arguments (owner stays NULL)", async () => {
    const svc = require("../services/adminDistributors.service");
    const out = await svc.createDistributor(db, body({ email: "b@x.example.com", tax_no: "29ABCDE1234F1Z5" }));
    expect((await db.Distributor.findByPk(out.id)).created_by_admin_id).toBeNull();
  });
});
