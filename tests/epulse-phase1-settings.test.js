const bcrypt = require("bcryptjs");
const { db, resetDb, mockRes, seedDistributor } = require("./helpers");
const ctrl = require("../controllers/settings.controller");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const reqFor = (d, body = {}) => ({ user: d ? { id: d.id } : null, body, params: {}, query: {} });

describe("Distributor settings", () => {
  test("returns own profile without any password or reset data", async () => {
    const d = await seedDistributor({ contact_person: "Ravi" });
    const res = mockRes();
    await ctrl.get(reqFor(d), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.code).toBe(d.distributor_code);
    expect(res.jsonBody.contactPerson).toBe("Ravi");
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/password|otp|hashed/i);
  });

  test("is unauthorised without a token identity", async () => {
    const res = mockRes();
    await ctrl.get(reqFor(null), res);
    expect(res.statusCode).toBe(401);
  });

  test("updates only contact person and phone; ignores attempts to change protected fields", async () => {
    const d = await seedDistributor({ status: "active" });
    const res = mockRes();
    await ctrl.updateProfile(reqFor(d, { contactPerson: "Meera", phone: "9876543210", name: "Hacked", email: "x@y.com", status: "inactive", distributor_code: "ZZZ", tax_no: "X" }), res);
    expect(res.statusCode).toBe(200);
    const fresh = await db.Distributor.findByPk(d.id);
    expect(fresh.contact_person).toBe("Meera");
    expect(fresh.phone_number).toBe("9876543210");
    expect(fresh.name).toBe(d.name);
    expect(fresh.email).toBe(d.email);
    expect(fresh.status).toBe("active");
    expect(fresh.distributor_code).toBe(d.distributor_code);
  });

  test("validates the phone number and rejects an empty update", async () => {
    const d = await seedDistributor();
    const bad = mockRes();
    await ctrl.updateProfile(reqFor(d, { phone: "abc" }), bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.jsonBody.details.phone).toBeDefined();
    const empty = mockRes();
    await ctrl.updateProfile(reqFor(d, { name: "only protected" }), empty);
    expect(empty.statusCode).toBe(400);
  });

  test("changes the password only with the correct current password", async () => {
    const d = await seedDistributor({ password: await bcrypt.hash("OldPass#123", 10) });
    const wrong = mockRes();
    await ctrl.changePassword(reqFor(d, { currentPassword: "nope", newPassword: "NewPass#456" }), wrong);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.jsonBody.code).toBe("WRONG_PASSWORD");

    const short = mockRes();
    await ctrl.changePassword(reqFor(d, { currentPassword: "OldPass#123", newPassword: "short" }), short);
    expect(short.statusCode).toBe(400);

    const same = mockRes();
    await ctrl.changePassword(reqFor(d, { currentPassword: "OldPass#123", newPassword: "OldPass#123" }), same);
    expect(same.statusCode).toBe(400);

    const ok = mockRes();
    await ctrl.changePassword(reqFor(d, { currentPassword: "OldPass#123", newPassword: "NewPass#456" }), ok);
    expect(ok.statusCode).toBe(200);
    const fresh = await db.Distributor.findByPk(d.id);
    expect(await bcrypt.compare("NewPass#456", fresh.password)).toBe(true);
    expect(await bcrypt.compare("OldPass#123", fresh.password)).toBe(false);
  });

  test("one distributor can never touch another's record (identity is the token only)", async () => {
    const a = await seedDistributor();
    const b = await seedDistributor();
    const res = mockRes();
    await ctrl.updateProfile({ user: { id: a.id }, body: { contactPerson: "A-only", id: b.id, distributor_id: b.id }, params: { id: b.id }, query: {} }, res);
    expect((await db.Distributor.findByPk(b.id)).contact_person).toBeNull();
    expect((await db.Distributor.findByPk(a.id)).contact_person).toBe("A-only");
  });
});
