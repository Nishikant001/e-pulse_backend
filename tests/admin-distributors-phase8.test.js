// Phase 8 — Distributor Management (Admin portal). Same in-memory sqlite + direct-controller convention as Phase 7.
const { db, resetDb, mockRes, seedDistributor, seedCustomer } = require("./helpers");
const ctrl = require("../controllers/admin.distributors.controller");
const salesOrder = require("../controllers/salesOrder.controller");
const auth = require("../controllers/auth.controller");
const bcrypt = require("bcryptjs");

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

// auth.login sets cookies; the shared mockRes has no cookie() so add a no-op for these login assertions.
const loginRes = () => Object.assign(mockRes(), { cookie: jest.fn(), clearCookie: jest.fn() });

const req = (o = {}) => ({ admin: { id: 1, name: "Admin", role: "ADMIN" }, body: {}, params: {}, query: {}, ...o });
const call = async (fn, r) => {
  const res = mockRes();
  await fn(req(r), res);
  return res;
};

const validBody = (o = {}) => ({
  name: "Sharma Pharma Distributors",
  contact_person: "Ravi Sharma",
  email: "Ravi@Sharma.example.com",
  phone_number: "+91 98765 43210",
  street1: "12 Market Road",
  city: "Pune",
  region: "Maharashtra",
  postal_code: "411001",
  tax_no: "27abcde1234f1z5",
  pan: "abcde1234f",
  territory: "Pune West",
  credit_limit: "500000",
  payment_terms: "Net 30",
  ...o,
});

describe("create", () => {
  test("creates a distributor with generated code, normalised values, pending status and NO login", async () => {
    const res = await call(ctrl.create, { body: validBody() });
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.code).toMatch(/^DTC\d+$/);
    expect(res.jsonBody.status).toBe("pending");
    const row = await db.Distributor.findByPk(res.jsonBody.id);
    expect(row.email).toBe("ravi@sharma.example.com");
    expect(row.tax_no).toBe("27ABCDE1234F1Z5");
    expect(row.pan).toBe("ABCDE1234F");
    expect(row.password).toBeNull();
    expect(Number(row.credit_limit)).toBe(500000);
  });

  test("ignores a client-supplied distributor_code (codes are system-owned, so they cannot collide)", async () => {
    const existing = await seedDistributor();
    const res = await call(ctrl.create, { body: validBody({ distributor_code: existing.distributor_code }) });
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody.code).not.toBe(existing.distributor_code);
  });

  test("returns field-level errors for missing / malformed values", async () => {
    const res = await call(ctrl.create, { body: { email: "nope", phone_number: "12", postal_code: "12", tax_no: "BAD", pan: "BAD", credit_limit: "-5" } });
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.code).toBe("VALIDATION_FAILED");
    for (const f of ["name", "street1", "city", "region", "email", "phone_number", "postal_code", "tax_no", "pan", "credit_limit"]) {
      expect(res.jsonBody.details[f]).toBeTruthy();
    }
  });

  test("rejects a duplicate email (case-insensitive) and a duplicate GSTIN with 409", async () => {
    await call(ctrl.create, { body: validBody() });
    const dupEmail = await call(ctrl.create, { body: validBody({ email: "RAVI@sharma.example.com", tax_no: "29ABCDE1234F1Z5" }) });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.jsonBody.details.email).toBeTruthy();
    const dupGst = await call(ctrl.create, { body: validBody({ email: "other@x.example.com" }) });
    expect(dupGst.statusCode).toBe(409);
    expect(dupGst.jsonBody.details.tax_no).toBeTruthy();
    expect(await db.Distributor.count()).toBe(1);
  });
});

describe("list", () => {
  test("search, filters, sort, pagination and retailer counts", async () => {
    const a = await seedDistributor({ name: "Alpha Pharma", city: "Pune", region: "Maharashtra", contact_person: "Asha", status: "active" });
    await seedDistributor({ name: "Beta Meds", city: "Surat", region: "Gujarat", territory: "South Gujarat", status: "inactive" });
    await seedDistributor({ name: "Gamma Health", city: "Pune", region: "Maharashtra", status: "pending" });
    await seedCustomer(a.id);
    await seedCustomer(a.id);

    const all = await call(ctrl.list, { query: {} });
    expect(all.jsonBody.total).toBe(3);
    expect(all.jsonBody.items[0].name).toBe("Alpha Pharma");
    expect(all.jsonBody.items[0].retailerCount).toBe(2);

    expect((await call(ctrl.list, { query: { status: "inactive" } })).jsonBody.items.map((i) => i.name)).toEqual(["Beta Meds"]);
    expect((await call(ctrl.list, { query: { state: "Maharashtra" } })).jsonBody.total).toBe(2);
    expect((await call(ctrl.list, { query: { territory: "South Gujarat" } })).jsonBody.total).toBe(1);
    expect((await call(ctrl.list, { query: { territory: "Pune" } })).jsonBody.total).toBe(2); // falls back to city
    expect((await call(ctrl.list, { query: { q: "asha" } })).jsonBody.items.map((i) => i.name)).toEqual(["Alpha Pharma"]);
    expect((await call(ctrl.list, { query: { q: "%" } })).jsonBody.total).toBe(0); // wildcard is literal

    const sorted = await call(ctrl.list, { query: { sort: "name", dir: "desc", page: "1", pageSize: "2" } });
    expect(sorted.jsonBody.items.map((i) => i.name)).toEqual(["Gamma Health", "Beta Meds"]);
    expect(sorted.jsonBody.total).toBe(3);
  });

  test("rejects bad sort / status / paging values", async () => {
    expect((await call(ctrl.list, { query: { sort: "password" } })).statusCode).toBe(400);
    expect((await call(ctrl.list, { query: { status: "deleted" } })).statusCode).toBe(400);
    expect((await call(ctrl.list, { query: { pageSize: "9999" } })).statusCode).toBe(400);
  });

  test("never exposes password, reset OTP or expiry", async () => {
    await seedDistributor({ reset_otp: "123456" });
    const res = await call(ctrl.list, { query: {} });
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/password|reset_otp|hashed|123456/i);
  });
});

describe("detail", () => {
  test("returns profile, real summary numbers, retailers — and no secrets", async () => {
    const d = await seedDistributor({ credit_limit: 100000 });
    const c = await seedCustomer(d.id, { name: "City Chemist" });
    const gl = await db.GLMaster.create({ gl_name: "Accounts Receivable", gl_type: "ASSET", distributor_code: d.distributor_code }).catch(() => null);
    if (gl) {
      await db.JournalEntry.create({ distributor_code: d.distributor_code, gl_id: gl.id, debit: 30000, credit: 0, reference_type: "SALES_INVOICE", transaction_date: new Date(), customer_id: c.id });
      await db.JournalEntry.create({ distributor_code: d.distributor_code, gl_id: gl.id, debit: 0, credit: 10000, reference_type: "CUSTOMER_PAYMENT", reference_no: "PAY-1", transaction_date: new Date(), customer_id: c.id });
    }
    const res = await call(ctrl.get, { params: { id: String(d.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.code).toBe(d.distributor_code);
    expect(res.jsonBody.summary.retailerCount).toBe(1);
    expect(res.jsonBody.retailers[0].name).toBe("City Chemist");
    expect(res.jsonBody.schemes).toEqual({ supported: false });
    if (gl) {
      expect(res.jsonBody.summary.outstanding).toBe(20000);
      expect(res.jsonBody.summary.availableCredit).toBe(80000);
      expect(res.jsonBody.summary.paymentsReceived).toBe(10000);
      expect(res.jsonBody.recentPayments[0].reference).toBe("PAY-1");
    }
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/"password"|reset_otp/i);
  });

  test("outstanding and available credit are null (never invented) when there is no ledger", async () => {
    const d = await seedDistributor();
    const res = await call(ctrl.get, { params: { id: String(d.id) } });
    expect(res.jsonBody.summary.outstanding).toBeNull();
    expect(res.jsonBody.summary.availableCredit).toBeNull();
  });

  test("404 for unknown id, 400 for malformed id", async () => {
    expect((await call(ctrl.get, { params: { id: "9999" } })).statusCode).toBe(404);
    expect((await call(ctrl.get, { params: { id: "abc" } })).statusCode).toBe(400);
  });

  test("retailers endpoint only returns this distributor's retailers (tenant isolation)", async () => {
    const d1 = await seedDistributor();
    const d2 = await seedDistributor();
    await seedCustomer(d1.id, { name: "Mine" });
    await seedCustomer(d2.id, { name: "Theirs" });
    const res = await call(ctrl.retailers, { params: { id: String(d1.id) } });
    expect(res.jsonBody.items.map((r) => r.name)).toEqual(["Mine"]);
  });
});

describe("update", () => {
  test("updates editable fields but never code, password or status", async () => {
    const d = await seedDistributor({ status: "active" });
    const res = await call(ctrl.update, {
      params: { id: String(d.id) },
      body: { city: "Nashik", distributor_code: "HACK", password: "x", status: "inactive", territory: "North" },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.Distributor.findByPk(d.id);
    expect(row.city).toBe("Nashik");
    expect(row.territory).toBe("North");
    expect(row.distributor_code).toBe(d.distributor_code);
    expect(row.password).toBe("hashed");
    expect(row.status).toBe("active");
  });

  test("rejects an email or GSTIN already used by another distributor, allows keeping your own", async () => {
    const a = await seedDistributor({ email: "a@x.example.com", tax_no: "27ABCDE1234F1Z5" });
    const b = await seedDistributor({ email: "b@x.example.com" });
    expect((await call(ctrl.update, { params: { id: String(b.id) }, body: { email: "A@x.example.com" } })).statusCode).toBe(409);
    expect((await call(ctrl.update, { params: { id: String(b.id) }, body: { tax_no: "27ABCDE1234F1Z5" } })).statusCode).toBe(409);
    expect((await call(ctrl.update, { params: { id: String(a.id) }, body: { email: "a@x.example.com", tax_no: "27ABCDE1234F1Z5" } })).statusCode).toBe(200);
  });

  test("404 when the distributor does not exist", async () => {
    expect((await call(ctrl.update, { params: { id: "9999" }, body: { city: "X" } })).statusCode).toBe(404);
  });
});

describe("status management", () => {
  test("deactivate → reactivate keeps every business record intact", async () => {
    const d = await seedDistributor();
    const c = await seedCustomer(d.id);
    const order = await db.SalesOrderHeader.create({ distributor_id: d.id, customerId: c.id, order_number: "SO-1", distributor_code: d.distributor_code, status: "CONFIRMED", totalAmount: 100, orderDate: new Date() });

    const off = await call(ctrl.setStatus, { params: { id: String(d.id) }, body: { status: "inactive", reason: "Contract ended" } });
    expect(off.statusCode).toBe(200);
    let row = await db.Distributor.findByPk(d.id);
    expect(row.status).toBe("inactive");
    expect(row.status_reason).toBe("Contract ended");
    expect(row.status_changed_at).toBeTruthy();
    expect(await db.SalesOrderHeader.findByPk(order.id)).toBeTruthy();
    expect(await db.Customer.count({ where: { distributor_id: d.id } })).toBe(1);

    const on = await call(ctrl.setStatus, { params: { id: String(d.id) }, body: { status: "active" } });
    expect(on.statusCode).toBe(200);
    row = await db.Distributor.findByPk(d.id);
    expect(row.status).toBe("active");
    expect(row.status_reason).toBeNull();
  });

  test("rejects no-op, pending and unknown statuses; unknown id is 404", async () => {
    const d = await seedDistributor();
    expect((await call(ctrl.setStatus, { params: { id: String(d.id) }, body: { status: "active" } })).statusCode).toBe(409);
    expect((await call(ctrl.setStatus, { params: { id: String(d.id) }, body: { status: "pending" } })).statusCode).toBe(400);
    expect((await call(ctrl.setStatus, { params: { id: String(d.id) }, body: { status: "deleted" } })).statusCode).toBe(400);
    expect((await call(ctrl.setStatus, { params: { id: "9999" }, body: { status: "inactive" } })).statusCode).toBe(404);
  });

  test("a pending distributor can be activated", async () => {
    const created = await call(ctrl.create, { body: validBody() });
    const res = await call(ctrl.setStatus, { params: { id: String(created.jsonBody.id) }, body: { status: "active" } });
    expect(res.jsonBody.previousStatus).toBe("pending");
    expect(res.jsonBody.status).toBe("active");
  });

  test("there is no delete path — the row and its history survive deactivation", async () => {
    expect(ctrl.remove).toBeUndefined();
    expect(ctrl.destroy).toBeUndefined();
  });
});

describe("existing behaviour is preserved / enforced", () => {
  test("existing distributors default to active and can still log in", async () => {
    const hash = await bcrypt.hash("Secret#123", 4);
    const d = await seedDistributor({ email: "login@x.example.com", password: hash });
    expect((await db.Distributor.findByPk(d.id)).status).toBe("active");
    const res = loginRes();
    await auth.login({ body: { email: "login@x.example.com", password: "Secret#123" } }, res);
    expect(res.statusCode).toBe(200);
  });

  test("an inactive distributor cannot sign in (checked after the password) and cannot create orders", async () => {
    const hash = await bcrypt.hash("Secret#123", 4);
    const d = await seedDistributor({ email: "off@x.example.com", password: hash, status: "inactive" });

    const bad = loginRes();
    await auth.login({ body: { email: "off@x.example.com", password: "wrong" } }, bad);
    expect(bad.statusCode).toBe(401); // no status leak to someone without the password

    const blocked = loginRes();
    await auth.login({ body: { email: "off@x.example.com", password: "Secret#123" } }, blocked);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.jsonBody.code).toBe("DISTRIBUTOR_INACTIVE");

    const c = await seedCustomer(d.id);
    const order = mockRes();
    await salesOrder.create({ user: { id: d.id, distributor_code: d.distributor_code }, body: { customerId: c.id, lines: [{ productId: 1, quantity: 1 }] } }, order);
    expect(order.statusCode).toBe(403);
    expect(await db.SalesOrderHeader.count()).toBe(0);
  });

  test("an admin-created distributor (no password) gets a clean 401, not a crash", async () => {
    const created = await call(ctrl.create, { body: validBody({ status: "active" }) });
    const res = loginRes();
    await auth.login({ body: { email: "ravi@sharma.example.com", password: "anything" } }, res);
    expect(created.statusCode).toBe(201);
    expect(res.statusCode).toBe(401);
  });
});

describe("lookups", () => {
  test("returns distinct states / cities / territories and fixed options", async () => {
    await seedDistributor({ city: "Pune", region: "Maharashtra" });
    await seedDistributor({ city: "Surat", region: "Gujarat", territory: "South Gujarat" });
    const res = await call(ctrl.lookups, {});
    expect(res.jsonBody.states).toEqual(["Gujarat", "Maharashtra"]);
    expect(res.jsonBody.territories).toEqual(expect.arrayContaining(["Pune", "South Gujarat"]));
    expect(res.jsonBody.statuses).toEqual(["active", "inactive", "pending"]);
  });
});
