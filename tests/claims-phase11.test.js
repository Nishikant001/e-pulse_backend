// Phase 11 — Claims. Same in-memory sqlite + direct-controller convention as Phases 7–10.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedCustomer, seedSalesOrder } = require("./helpers");
const adminClaims = require("../controllers/admin.claims.controller");
const distClaims = require("../controllers/claim.controller");
const adminSchemes = require("../controllers/admin.schemes.controller");
const requireAdmin = require("../middleware/adminAuth");
const adminRoutes = require("../routes/adminRoutes");
const allRoutes = require("../routes/allRoutes");
const svc = require("../services/claims.service");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const D = async (fn, d, o = {}) => { const res = mockRes(); await fn({ user: { id: d.id }, body: {}, params: {}, query: {}, ...o }, res); return res; };

let seq = 0;
async function world() {
  const d = await seedDistributor(); const p = await seedProduct(d.id); const cust = await seedCustomer(d.id);
  const mk = await A(adminSchemes.create, { body: { name: "Buy10Get1", scheme_code: `B10G1${++seq}`, scheme_type: "QUANTITY_FREE", product_ids: [p.id], buy_quantity: 10, free_quantity: 1, valid_from: day(-60), valid_to: day(60) } });
  const scheme = mk.jsonBody;
  const inv = await invoice(d, cust, p, 20, 100);
  return { d, p, cust, scheme, inv };
}
async function invoice(d, cust, p, qty, price, o = {}) {
  const order = await seedSalesOrder(d, { productId: p.id, quantity: qty, pricePerUnit: price });
  const delivery = await db.SalesDeliveryHeader.create({ deliveryDate: new Date(), distributor_id: d.id, orderId: order.id, status: "Delivered" });
  const h = await db.SalesInvoiceHeader.create({ invoiceDate: new Date(Date.now() - 5 * 86400000), distributor_id: d.id, distributor_code: d.distributor_code, invoice_number: `INV${++seq}`, customer_id: cust.id, deliveryId: delivery.id, status: "POSTED", netValue: qty * price, totalAmount: qty * price, ...o }, { validate: false });
  const line = await db.SalesInvoiceLine.create({ invoiceId: h.id, productId: p.id, quantity: qty, pricePerUnit: price, taxableValue: qty * price, lineTotal: qty * price });
  return { h, line };
}
const body = (w, o = {}) => ({ invoice_id: w.inv.h.id, scheme_id: w.scheme.id, period_from: day(-30), period_to: day(0), description: "Free goods given", items: [{ invoice_line_id: w.inv.line.id, quantity: 20 }], ...o });
const create = (w, o) => D(distClaims.create, w.d, { body: body(w, o) });
const mine = async (w) => (await create(w)).jsonBody;
const submitted = async (w) => { const c = await mine(w); await D(distClaims.submit, w.d, { params: { id: c.id } }); return c; };
const underReview = async (w) => { const c = await submitted(w); await A(adminClaims.review, { params: { id: c.id } }); return c; };

describe("Distributor create / own-scope", () => {
  test("creates a draft; amount is server-calculated from the Scheme Engine (20 bought → 2 free × ₹100)", async () => {
    const w = await world();
    const r = await create(w, { claim_amount: 999999, distributor_id: 12345, status: "APPROVED", customer_id: 777 });
    expect(r.statusCode).toBe(201);
    expect(r.jsonBody.status).toBe("DRAFT");
    expect(r.jsonBody.amount).toBe(200);
    expect(r.jsonBody.distributorId).toBe(w.d.id);
    expect(r.jsonBody.customerId).toBe(w.cust.id);
    expect(r.jsonBody.items[0]).toMatchObject({ freeQuantity: 2, eligibleAmount: 200, benefitType: "FREE_QUANTITY" });
    expect(r.jsonBody.issues).toEqual([]);
    expect(r.jsonBody.history.map((h) => h.to)).toEqual(["DRAFT"]);
    expect(r.jsonBody.number).toMatch(/^CLM\d{10}$/);
  });

  test("cannot claim another distributor's invoice / lines; unknown scheme rejected", async () => {
    const w = await world(); const w2 = await world();
    expect((await create(w, { invoice_id: w2.inv.h.id })).statusCode).toBe(400);
    expect((await create(w, { items: [{ invoice_line_id: w2.inv.line.id, quantity: 1 }] })).statusCode).toBe(400);
    expect((await create(w, { scheme_id: 99999 })).statusCode).toBe(400);
    expect((await create(w, { items: [{ invoice_line_id: w.inv.line.id, quantity: 21 }] })).statusCode).toBe(400);
    expect((await create(w, { items: [] })).statusCode).toBe(400);
    expect((await create(w, { period_to: day(-60) })).statusCode).toBe(400);
    expect(await db.Claim.count()).toBe(0);
  });

  test("direct access to another distributor's claim is 404 for read / update / submit / resubmit; lists are scoped", async () => {
    const w = await world(); const w2 = await world();
    const c = await mine(w);
    for (const [fn, o] of [[distClaims.get, {}], [distClaims.update, { body: body(w) }], [distClaims.submit, {}], [distClaims.resubmit, {}]]) {
      const r = await D(fn, w2.d, { params: { id: c.id }, ...o });
      expect(r.statusCode).toBe(404);
    }
    expect((await D(distClaims.list, w2.d)).jsonBody.total).toBe(0);
    expect((await D(distClaims.list, w2.d, { query: { distributorId: w.d.id } })).jsonBody.total).toBe(0);
    expect((await D(distClaims.list, w.d)).jsonBody.total).toBe(1);
    expect((await db.Claim.findByPk(c.id)).status).toBe("DRAFT");
  });

  test("ineligible claims save as drafts with issues but cannot be submitted (below minimum quantity)", async () => {
    const w = await world();
    const small = await invoice(w.d, w.cust, w.p, 9, 100);
    const r = await create(w, { invoice_id: small.h.id, items: [{ invoice_line_id: small.line.id, quantity: 9 }] });
    expect(r.statusCode).toBe(201);
    expect(r.jsonBody.issues[0].code).toBe("SCHEME_NOT_ELIGIBLE");
    const s = await D(distClaims.submit, w.d, { params: { id: r.jsonBody.id } });
    expect(s.statusCode).toBe(422);
    expect(s.jsonBody.code).toBe("CLAIM_NOT_ELIGIBLE");
    expect((await db.Claim.findByPk(r.jsonBody.id)).status).toBe("DRAFT");
  });

  test("period must include the invoice date; draft edit recalculates; invoice/scheme cannot change", async () => {
    const w = await world();
    const c = (await create(w, { period_from: day(-2), period_to: day(0) })).jsonBody;
    expect(c.issues[0].code).toBe("OUTSIDE_PERIOD");
    const u = await D(distClaims.update, w.d, { params: { id: c.id }, body: body(w, { items: [{ invoice_line_id: w.inv.line.id, quantity: 10 }] }) });
    expect(u.statusCode).toBe(200);
    expect(u.jsonBody.amount).toBe(100);
    expect((await D(distClaims.update, w.d, { params: { id: c.id }, body: body(w, { invoice_id: 99 }) })).statusCode).toBe(400);
  });

  test("invoice preview lines show eligibility and already-claimed state", async () => {
    const w = await world();
    let p = (await D(distClaims.invoiceLines, w.d, { params: { invoiceId: w.inv.h.id }, query: { schemeId: w.scheme.id } })).jsonBody;
    expect(p.lines[0]).toMatchObject({ eligible: true, freeQuantity: 2, benefitAmount: 200, alreadyClaimedIn: null });
    await mine(w);
    p = (await D(distClaims.invoiceLines, w.d, { params: { invoiceId: w.inv.h.id }, query: { schemeId: w.scheme.id } })).jsonBody;
    expect(p.lines[0].alreadyClaimedIn).toMatch(/^CLM/);
    const w2 = await world();
    expect((await D(distClaims.invoiceLines, w2.d, { params: { invoiceId: w.inv.h.id } })).statusCode).toBe(400);
  });

  test("non-posted (draft/cancelled) invoices cannot be claimed", async () => {
    const w = await world();
    const x = await invoice(w.d, w.cust, w.p, 20, 100, { status: "DRAFT" });
    expect((await create(w, { invoice_id: x.h.id, items: [{ invoice_line_id: x.line.id, quantity: 20 }] })).jsonBody.code).toBe("INVOICE_NOT_CLAIMABLE");
  });
});

describe("Duplicate prevention", () => {
  test("the same invoice line cannot be claimed twice under a scheme; a REJECTED claim frees it", async () => {
    const w = await world();
    const c1 = await underReview(w);
    const dup = await create(w);
    expect(dup.jsonBody.issues[0].code).toBe("DUPLICATE_CLAIM");
    expect((await D(distClaims.submit, w.d, { params: { id: dup.jsonBody.id } })).statusCode).toBe(422);
    await A(adminClaims.reject, { params: { id: c1.id }, body: { reason: "Quantity does not match" } });
    const again = await D(distClaims.submit, w.d, { params: { id: dup.jsonBody.id } }); // the rejected claim no longer blocks it
    expect(again.statusCode).toBe(200);
  });

  test("a claim never conflicts with itself when edited or submitted", async () => {
    const w = await world();
    const c = await mine(w);
    expect((await D(distClaims.update, w.d, { params: { id: c.id }, body: body(w) })).jsonBody.issues).toEqual([]);
    expect((await D(distClaims.submit, w.d, { params: { id: c.id } })).statusCode).toBe(200);
  });
});

describe("Workflow & Admin decisions", () => {
  test("DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED with full history and decision metadata", async () => {
    const w = await world();
    const c = await submitted(w);
    expect((await db.Claim.findByPk(c.id)).submitted_at).toBeTruthy();
    expect((await A(adminClaims.review, { params: { id: c.id } })).jsonBody.status).toBe("UNDER_REVIEW");
    const ok = await A(adminClaims.approve, { params: { id: c.id }, body: { comment: "Verified" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.jsonBody).toMatchObject({ status: "APPROVED", decisionReason: "Verified", decidedByAdminId: 1 });
    expect(ok.jsonBody.decidedAt).toBeTruthy();
    expect(ok.jsonBody.history.map((h) => `${h.from}>${h.to}`)).toEqual(["null>DRAFT", "DRAFT>SUBMITTED", "SUBMITTED>UNDER_REVIEW", "UNDER_REVIEW>APPROVED"]);
    expect(ok.jsonBody.history[3]).toMatchObject({ actorType: "ADMIN", actor: "Admin" });
    const dist = (await D(distClaims.get, w.d, { params: { id: c.id } })).jsonBody;
    expect(dist.status).toBe("APPROVED");
    expect(dist.decidedByAdminId).toBeUndefined();
    expect(dist.history[3].actor).toBe("Administrator");
    // Phase 12: approval now posts exactly one balanced CLAIM_SETTLEMENT (2 rows) and nothing else (details in accounts-phase12.test.js)
    const je = await db.JournalEntry.findAll({ raw: true });
    expect(je).toHaveLength(2);
    expect(je.every((r) => r.reference_type === "CLAIM_SETTLEMENT")).toBe(true);
  });

  test("illegal transitions are refused (409) and nothing changes", async () => {
    const w = await world();
    const other = await invoice(w.d, w.cust, w.p, 20, 100); // a separate invoice so the draft does not block `sub` as a duplicate
    const draft = (await create(w, { invoice_id: other.h.id, items: [{ invoice_line_id: other.line.id, quantity: 20 }] })).jsonBody;
    for (const fn of [adminClaims.review, adminClaims.approve]) expect((await A(fn, { params: { id: draft.id } })).statusCode).toBe(409);
    expect((await A(adminClaims.reject, { params: { id: draft.id }, body: { reason: "valid reason" } })).statusCode).toBe(409);
    const sub = await submitted(w);
    expect((await db.Claim.findByPk(sub.id)).status).toBe("SUBMITTED");
    expect((await A(adminClaims.approve, { params: { id: sub.id } })).statusCode).toBe(409); // must be reviewed first
    await A(adminClaims.review, { params: { id: sub.id } });
    expect((await A(adminClaims.review, { params: { id: sub.id } })).statusCode).toBe(409);
    await A(adminClaims.approve, { params: { id: sub.id } });
    for (const fn of [adminClaims.reject, adminClaims.needsCorrection]) expect((await A(fn, { params: { id: sub.id }, body: { reason: "too late now" } })).statusCode).toBe(409);
    expect((await D(distClaims.resubmit, w.d, { params: { id: sub.id } })).statusCode).toBe(409);
    expect((await D(distClaims.update, w.d, { params: { id: sub.id }, body: body(w) })).statusCode).toBe(409);
    expect((await db.Claim.findByPk(sub.id)).status).toBe("APPROVED");
    expect(svc.TRANSITIONS.APPROVED).toEqual({});
    expect(svc.TRANSITIONS.REJECTED).toEqual({});
  });

  test("rejection requires a reason; the distributor sees it", async () => {
    const w = await world();
    const c = await underReview(w);
    expect((await A(adminClaims.reject, { params: { id: c.id }, body: {} })).statusCode).toBe(400);
    expect((await A(adminClaims.reject, { params: { id: c.id }, body: { reason: "  no " } })).statusCode).toBe(400);
    const r = await A(adminClaims.reject, { params: { id: c.id }, body: { reason: "Claim quantity does not match eligible scheme quantity." } });
    expect(r.jsonBody.status).toBe("REJECTED");
    const d = (await D(distClaims.get, w.d, { params: { id: c.id } })).jsonBody;
    expect(d.decisionReason).toMatch(/does not match/);
    expect((await D(distClaims.resubmit, w.d, { params: { id: c.id } })).statusCode).toBe(409);
  });

  test("needs correction → distributor edits → resubmits → review → approve", async () => {
    const w = await world();
    const c = await underReview(w);
    expect((await A(adminClaims.needsCorrection, { params: { id: c.id }, body: {} })).statusCode).toBe(400);
    const n = await A(adminClaims.needsCorrection, { params: { id: c.id }, body: { reason: "Description is unclear", required_information: "Attach scheme proof reference" } });
    expect(n.jsonBody).toMatchObject({ status: "NEEDS_CORRECTION", correctionReason: "Description is unclear", requiredInformation: "Attach scheme proof reference", editable: true });
    const seen = (await D(distClaims.get, w.d, { params: { id: c.id } })).jsonBody;
    expect(seen.correctionReason).toBe("Description is unclear");
    expect((await D(distClaims.submit, w.d, { params: { id: c.id } })).statusCode).toBe(409); // must use resubmit
    expect((await D(distClaims.update, w.d, { params: { id: c.id }, body: body(w, { description: "Clarified: 2 cartons free on INV" }) })).statusCode).toBe(200);
    const rs = await D(distClaims.resubmit, w.d, { params: { id: c.id } });
    expect(rs.jsonBody.status).toBe("RESUBMITTED");
    expect((await A(adminClaims.review, { params: { id: c.id } })).jsonBody.status).toBe("UNDER_REVIEW");
    const ok = await A(adminClaims.approve, { params: { id: c.id } });
    expect(ok.jsonBody.status).toBe("APPROVED");
    expect(ok.jsonBody.history.map((h) => h.to)).toEqual(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_CORRECTION", "RESUBMITTED", "UNDER_REVIEW", "APPROVED"]);
  });

  test("approval re-checks the scheme: deactivated scheme / missing description blocks approval with reasons", async () => {
    const w = await world();
    const c = await underReview(w);
    await A(adminSchemes.setStatus, { params: { id: w.scheme.id }, body: { status: "inactive" } });
    const r = await A(adminClaims.approve, { params: { id: c.id } });
    expect(r.statusCode).toBe(422);
    expect(r.jsonBody.details.issues[0].code).toBe("SCHEME_NOT_ELIGIBLE");
    expect((await db.Claim.findByPk(c.id)).status).toBe("UNDER_REVIEW");
    await A(adminSchemes.setStatus, { params: { id: w.scheme.id }, body: { status: "active" } });
    await db.Claim.update({ description: null }, { where: { id: c.id } });
    expect((await A(adminClaims.approve, { params: { id: c.id } })).jsonBody.details.issues[0].code).toBe("NO_DESCRIPTION");
  });

  test("a higher-priority scheme taking over blocks the claim", async () => {
    const w = await world();
    const c = await underReview(w);
    await A(adminSchemes.create, { body: { name: "Better", scheme_code: "BETTER1", scheme_type: "PERCENT_DISCOUNT", discount_percent: 10, product_ids: [w.p.id], valid_from: day(-60), priority: 1 } });
    const r = await A(adminClaims.approve, { params: { id: c.id } });
    expect(r.jsonBody.details.issues[0].code).toBe("OTHER_SCHEME_APPLIES");
  });

  test("scheme snapshot is stored at submission and survives later scheme edits", async () => {
    const w = await world();
    const c = await submitted(w);
    await A(adminSchemes.update, { params: { id: w.scheme.id }, body: { free_quantity: 5 } });
    const g = (await A(adminClaims.get, { params: { id: c.id } })).jsonBody;
    expect(g.schemeSnapshot.ruleSummary).toBe("Buy 10 get 1 free");
    expect(g.scheme.ruleSummary).toBe("Buy 10 get 5 free");
    expect(g.amount).toBe(200);
  });

  test("stale decisions are refused (optimistic lock): a claim moved by someone else cannot be overwritten", async () => {
    const w = await world();
    const c = await underReview(w);
    const stale = await db.Claim.findByPk(c.id); // another admin loads the claim ...
    await A(adminClaims.reject, { params: { id: c.id }, body: { reason: "Not valid at all" } }); // ... and it is decided meanwhile
    await expect(svc._transition(db, stale, "APPROVED", { type: "ADMIN", id: 2 }, { comment: "late" })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect((await db.Claim.findByPk(c.id)).status).toBe("REJECTED");
    expect(await db.ClaimStatusHistory.count({ where: { claim_id: c.id } })).toBe(4);
    await expect(svc._transition(db, await db.Claim.findByPk(c.id), "SUBMITTED", { type: "ADMIN", id: 2 }, {})).rejects.toMatchObject({ statusCode: 409 });
    const d = await mine(w);
    await expect(svc._transition(db, await db.Claim.findByPk(d.id), "SUBMITTED", { type: "ADMIN", id: 2 }, {})).rejects.toMatchObject({ statusCode: 403 }); // admin cannot submit for a distributor
  });
});

describe("Admin list / filters / detail", () => {
  test("search, filters, sorting, pagination, hard limits", async () => {
    const w = await world(); const w2 = await world();
    const c1 = await submitted(w);
    const inv2 = await invoice(w.d, w.cust, w.p, 30, 50);
    const c2 = (await create(w, { invoice_id: inv2.h.id, items: [{ invoice_line_id: inv2.line.id, quantity: 30 }] })).jsonBody;
    const c3 = await mine(w2);
    const L = async (query) => (await A(adminClaims.list, { query })).jsonBody;
    expect((await L({})).total).toBe(3);
    expect((await L({ status: "SUBMITTED" })).total).toBe(1);
    expect((await L({ status: "DRAFT" })).total).toBe(2);
    expect((await L({ distributorId: w2.d.id })).items[0].id).toBe(c3.id);
    expect((await L({ schemeId: w.scheme.id })).total).toBe(2);
    expect((await L({ customerId: w.cust.id })).total).toBe(2);
    expect((await L({ type: "SCHEME" })).total).toBe(3);
    expect((await L({ q: c1.number.toLowerCase() })).total).toBe(1);
    expect((await L({ q: w2.d.name })).total).toBe(1);
    expect((await L({ q: "%" })).total).toBe(0);
    expect((await L({ from: day(0), to: day(0) })).total).toBe(3);
    expect((await L({ from: day(1) })).total).toBe(0);
    const s = await L({ sort: "amount", dir: "desc", pageSize: 2 });
    expect(s.items.map((i) => i.amount)).toEqual([200, 200]); // c1 and c3 (20 bought → 2 free × 100); c2 is 3 free × 50 = 150
    expect((await L({ sort: "amount", dir: "asc", pageSize: 1 })).items[0].id).toBe(c2.id);
    expect(s.totalPages).toBe(2);
    expect((await L({ page: 2, pageSize: 2 })).items).toHaveLength(1);
    for (const bad of [{ sort: "id; DROP" }, { status: "WEIRD" }, { pageSize: 5000 }, { from: "x" }, { from: day(2), to: day(0) }]) expect((await A(adminClaims.list, { query: bad })).statusCode).toBe(400);
    const row = (await L({ distributorId: w.d.id })).items[0];
    expect(row).toMatchObject({ distributor: { id: w.d.id }, scheme: { code: w.scheme.code }, retailer: { id: w.cust.id } });
  });

  test("detail contains distributor, retailer, scheme, invoice, items, history; unknown id → 404", async () => {
    const w = await world();
    const c = await submitted(w);
    const g = (await A(adminClaims.get, { params: { id: c.id } })).jsonBody;
    expect(g.distributor.code).toBe(w.d.distributor_code);
    expect(g.retailer.id).toBe(w.cust.id);
    expect(g.scheme.code).toBe(w.scheme.code);
    expect(g.invoice.number).toBe(w.inv.h.invoice_number);
    expect(g.items[0].productId).toBe(w.p.id);
    expect(g.history).toHaveLength(2);
    expect((await A(adminClaims.get, { params: { id: 99999 } })).statusCode).toBe(404);
    expect((await A(adminClaims.get, { params: { id: "abc" } })).statusCode).toBe(400);
  });

  test("history rows are never altered by later actions", async () => {
    const w = await world();
    const c = await underReview(w);
    const before = (await db.ClaimStatusHistory.findAll({ where: { claim_id: c.id }, raw: true })).map((h) => `${h.id}:${h.to_status}:${h.comment}`);
    await A(adminClaims.reject, { params: { id: c.id }, body: { reason: "Does not qualify for the scheme" } });
    const after = (await db.ClaimStatusHistory.findAll({ where: { claim_id: c.id }, order: [["id", "ASC"]], raw: true })).map((h) => `${h.id}:${h.to_status}:${h.comment}`);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });
});

describe("Authorization surface & scope", () => {
  test("admin routes are guarded; distributor routes expose no decision handlers", async () => {
    const layers = adminRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/claims"));
    expect(layers.length).toBe(8); // Phase 12 added POST /claims/:id/settle (settlement of pre-Phase-12 approvals; not an approval)
    for (const l of layers) expect(l.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    expect(Object.keys(distClaims).sort()).toEqual(["create", "get", "invoiceLines", "list", "lookups", "resubmit", "submit", "update"]);
    const routes = allRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/claims")).map((l) => Object.keys(l.route.methods)[0] + l.route.path);
    expect(routes.some((r) => /approve|reject|review|status|needs-correction/.test(r))).toBe(false);
    expect(routes).toHaveLength(8);
    const res = mockRes(); const next = jest.fn();
    await requireAdmin({ cookies: { distributor_token: "x" }, headers: { authorization: "Bearer x" } }, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test("distributor lookups only contain its own invoices / retailers / schemes", async () => {
    const w = await world(); const w2 = await world();
    const l = (await D(distClaims.lookups, w.d)).jsonBody;
    expect(l.invoices.map((i) => i.id)).toEqual([w.inv.h.id]);
    expect(l.retailers.map((r) => r.id)).toContain(w.cust.id);
    expect(l.retailers.map((r) => r.id)).not.toContain(w2.cust.id);
    expect(l.schemes.map((s) => s.id)).toContain(w.scheme.id);
    expect(l.invoices.find((i) => i.id === w2.inv.h.id)).toBeUndefined();
  });

  test("inactive distributor is locked out of claims", async () => {
    const w = await world();
    await db.Distributor.update({ status: "inactive" }, { where: { id: w.d.id } });
    expect((await D(distClaims.list, w.d)).statusCode).toBe(403);
  });

  test("no Retailer login / auth / portal introduced; claims reference retailers as data only", async () => {
    const fs = require("fs"); const path = require("path");
    const src = ["../routes/allRoutes.js", "../routes/adminRoutes.js", "../controllers/claim.controller.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
    expect(/retailer[^\n]*(login|auth\/|jwt)/i.test(src.replace(/authMiddleware/g, ""))).toBe(false);
    expect(db.Claim.rawAttributes.password).toBeUndefined();
    expect(db.Customer.rawAttributes.password).toBeUndefined();
  });
});

describe("Existing system intact", () => {
  test("claims never alter invoices, schemes, products or inventory", async () => {
    const w = await world();
    const snap = async () => JSON.stringify([await db.SalesInvoiceHeader.findByPk(w.inv.h.id, { raw: true }), await db.SalesInvoiceLine.findByPk(w.inv.line.id, { raw: true }), await db.Product.findByPk(w.p.id, { raw: true }), await db.Scheme.findByPk(w.scheme.id, { raw: true }), await db.Batch.count(), await db.StockLedger.count()]);
    const before = await snap();
    const c = await underReview(w);
    await A(adminClaims.approve, { params: { id: c.id } });
    expect(await snap()).toBe(before);
  });
});
