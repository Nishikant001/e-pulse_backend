// Phase 12 — Accounts & Financial Management. Same in-memory sqlite + direct-controller convention as Phases 7–11.
const { db, resetDb, mockRes, seedDistributor, seedProduct, seedCustomer, seedSalesOrder, seedGLAccounts } = require("./helpers");
const adminAccounts = require("../controllers/admin.accounts.controller");
const distAccounts = require("../controllers/accounts.controller");
const adminClaims = require("../controllers/admin.claims.controller");
const distClaims = require("../controllers/claim.controller");
const adminSchemes = require("../controllers/admin.schemes.controller");
const creditNoteCtl = require("../controllers/salescreditnote.controller");
const paymentCtl = require("../controllers/payment.controller");
const requireAdmin = require("../middleware/adminAuth");
const adminRoutes = require("../routes/adminRoutes");
const allRoutes = require("../routes/allRoutes");
const accounting = require("../services/accounting.service");
const rec = require("../services/receivables.service");
const pay = require("../services/payments.service");

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await db.sequelize.close(); });

const DAY = 86400000;
const day = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const at = (o) => new Date(Date.now() + o * DAY);
const A = async (fn, o = {}) => { const res = mockRes(); await fn({ admin: { id: 1, name: "Admin" }, body: {}, params: {}, query: {}, ...o }, res); return res; };
const D = async (fn, d, o = {}) => { const res = mockRes(); await fn({ user: { id: d.id }, body: {}, params: {}, query: {}, ...o }, res); return res; };

let seq = 0;
async function world(opts = {}) {
  const d = await seedDistributor();
  if (opts.gl !== false) await seedGLAccounts(d);
  const p = await seedProduct(d.id);
  const cust = await seedCustomer(d.id);
  return { d, p, cust };
}
// A posted invoice exactly as salesinvoice.post leaves it: header + AR debit / Sales credit journal rows, due date set.
async function invoice(w, total, { dueIn = 30, ago = 10, cust = w.cust, qty = 20 } = {}) {
  const order = await seedSalesOrder(w.d, { productId: w.p.id, quantity: qty, pricePerUnit: total / qty });
  const delivery = await db.SalesDeliveryHeader.create({ deliveryDate: new Date(), distributor_id: w.d.id, orderId: order.id, status: "Delivered" });
  const h = await db.SalesInvoiceHeader.create({
    invoiceDate: at(-ago), dueDate: at(dueIn), distributor_id: w.d.id, distributor_code: w.d.distributor_code, invoice_number: `INV${++seq}`, customer_id: cust.id,
    deliveryId: delivery.id, status: "POSTED", netValue: total, totalAmount: total, outstandingAmount: total, paymentTerms: "Net 30",
  }, { validate: false });
  const line = await db.SalesInvoiceLine.create({ invoiceId: h.id, productId: w.p.id, quantity: qty, pricePerUnit: total / qty, taxableValue: total, lineTotal: total });
  const ar = await accounting.getGL("Accounts Receivable", w.d.distributor_code);
  const sales = await accounting.getGL("Sales", w.d.distributor_code);
  const base = { distributor_code: w.d.distributor_code, reference_type: "SALES_INVOICE", reference_no: h.id, customer_id: cust.id, customer_code: cust.customer_code, transaction_date: at(-ago) };
  await db.JournalEntry.bulkCreate([{ ...base, gl_id: ar, debit: total, credit: 0, narration: `Sales Invoice ${h.invoice_number} Posting` }, { ...base, gl_id: sales, debit: 0, credit: total, narration: "Sales" }]);
  return { h, line };
}
// A credit note posted through the REAL posting function
async function creditNote(w, inv, total, extra = {}) {
  const note = await db.SalesCreditNote.create({ invoiceId: inv.h.id, distributor_id: w.d.id, distributor_code: w.d.distributor_code, credit_note_number: `CN${++seq}`, customerId: inv.h.customer_id, status: "DRAFT", netValue: total, totalAmount: total, amount: total, ...extra });
  const t = await db.sequelize.transaction();
  try { await creditNoteCtl.postCreditNoteAccounting(note, w.d.distributor_code, t); await t.commit(); } catch (e) { await t.rollback(); throw e; }
  return note;
}
const payBody = (w, o = {}) => ({ customerId: w.cust.id, amount: 500, paymentDate: day(0), mode: "BANK_TRANSFER", referenceNo: `UTR${++seq}`, ...o });
const record = (w, o) => A(adminAccounts.createPayment, { body: payBody(w, o) });
const outstandingOf = async (w, cust = w.cust, query = {}) => { const r = await A(adminAccounts.outstanding, { query: { entityType: "RETAILER", retailerId: cust.id, ...query } }); return r.jsonBody.items[0]; };
const arBalance = async (code) => { const rows = await db.JournalEntry.findAll({ where: { distributor_code: code }, include: [{ model: db.GLMaster, as: "gl", where: { gl_name: "Accounts Receivable" } }], raw: true }); return rows.reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0); };

// ───────────────────────────────────────── Outstanding ─────────────────────────────────────────
describe("Outstanding calculation", () => {
  test("invoice only", async () => {
    const w = await world(); await invoice(w, 1000);
    const o = await outstandingOf(w);
    expect(o).toMatchObject({ invoiceCount: 1, invoiceAmount: 1000, paymentsReceived: 0, creditNotes: 0, outstanding: 1000, overdue: 0, ageingBucket: "NOT_DUE" });
  });

  test("invoice + payment", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    expect((await record(w, { amount: 400, allocations: [{ invoiceId: inv.h.id, amount: 400 }] })).statusCode).toBe(201);
    const o = await outstandingOf(w);
    expect(o).toMatchObject({ invoiceAmount: 1000, paymentsReceived: 400, creditNotes: 0, outstanding: 600 });
  });

  test("invoice + credit note (real posting path)", async () => {
    const w = await world(); const inv = await invoice(w, 1000); await creditNote(w, inv, 100);
    expect(await outstandingOf(w)).toMatchObject({ invoiceAmount: 1000, creditNotes: 100, outstanding: 900 });
    expect(Number((await db.SalesInvoiceHeader.findByPk(inv.h.id)).outstandingAmount)).toBe(900); // stored balance follows the credit note
    expect((await db.SalesInvoiceHeader.findByPk(inv.h.id)).status).toBe("POSTED"); // status untouched so returns/credit notes keep working
  });

  test("invoice + payment + credit note (₹1,000 − ₹100 − ₹500 = ₹400)", async () => {
    const w = await world(); const inv = await invoice(w, 1000); await creditNote(w, inv, 100);
    await record(w, { amount: 500, allocations: [{ invoiceId: inv.h.id, amount: 500 }] });
    expect(await outstandingOf(w)).toMatchObject({ invoiceAmount: 1000, paymentsReceived: 500, creditNotes: 100, outstanding: 400 });
    expect(await arBalance(w.d.distributor_code)).toBe(400); // equals the AR ledger
  });

  test("partial payment keeps the rest open; full payment clears it", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    await record(w, { amount: 600, allocations: [{ invoiceId: inv.h.id, amount: 600 }] });
    expect((await outstandingOf(w)).outstanding).toBe(400);
    await record(w, { amount: 400, allocations: [{ invoiceId: inv.h.id, amount: 400 }] });
    const all = await A(adminAccounts.outstanding, { query: { entityType: "RETAILER", status: "outstanding" } });
    expect(all.jsonBody.items.find((i) => i.entityId === w.cust.id)).toBeUndefined();
    expect((await outstandingOf(w)).outstanding).toBe(0);
    expect(Number((await db.SalesInvoiceHeader.findByPk(inv.h.id)).outstandingAmount)).toBe(0);
  });

  test("multiple invoices aggregate per retailer and per distributor", async () => {
    const w = await world(); const c2 = await seedCustomer(w.d.id);
    await invoice(w, 1000); await invoice(w, 500); await invoice(w, 250, { cust: c2 });
    expect((await outstandingOf(w)).outstanding).toBe(1500);
    const r = await A(adminAccounts.outstanding, { query: { entityType: "DISTRIBUTOR", distributorId: w.d.id } });
    expect(r.jsonBody.items[0]).toMatchObject({ entityType: "DISTRIBUTOR", invoiceCount: 3, invoiceAmount: 1750, outstanding: 1750, retailerCount: 2 });
  });

  test("a payment recorded through the LEGACY /payment/receive flow reduces outstanding and ageing oldest-first, and the report equals the ledger", async () => {
    const w = await world();
    await invoice(w, 1000, { dueIn: -40, ago: 70 }); await invoice(w, 1000, { dueIn: 20, ago: 10 });
    const res = mockRes(); await paymentCtl.receivePayment({ user: { id: w.d.id, distributor_code: w.d.distributor_code }, body: { customer_id: w.cust.id, amount: 1200, reference_no: "OLD-1", mode: "cash" } }, res);
    expect(res.statusCode).toBe(200);
    const o = await outstandingOf(w);
    expect(o.outstanding).toBe(800);
    expect(o.overdue).toBe(0); // the overdue invoice was cleared first (FIFO), the rest is still not due
    expect(o.paymentsReceived).toBe(1200);
    expect(o.ledgerBalance).toBe(800);
    expect(await arBalance(w.d.distributor_code)).toBe(800);
  });

  test("advance (payment above what is owed) is kept as unapplied credit and reduces the ledger balance", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    expect((await record(w, { amount: 1500, allocations: [{ invoiceId: inv.h.id, amount: 1000 }] })).statusCode).toBe(201);
    const o = await outstandingOf(w);
    expect(o).toMatchObject({ outstanding: 0, advance: 500, ledgerBalance: -500 });
  });

  test("filters, sort, search and pagination work and are validated", async () => {
    const w = await world(); const c2 = await seedCustomer(w.d.id, { name: "Zeta Pharmacy" });
    await invoice(w, 1000, { dueIn: -5, ago: 40 }); await invoice(w, 300, { cust: c2 });
    const q = (query) => A(adminAccounts.outstanding, { query: { entityType: "RETAILER", ...query } });
    expect((await q({ status: "overdue" })).jsonBody.items.map((i) => i.entityId)).toEqual([w.cust.id]);
    expect((await q({ search: "zeta" })).jsonBody.items.map((i) => i.entityId)).toEqual([c2.id]);
    expect((await q({ sort: "outstanding", dir: "asc" })).jsonBody.items[0].entityId).toBe(c2.id);
    const p = await q({ pageSize: 1, page: 2 });
    expect(p.jsonBody).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(p.jsonBody.items).toHaveLength(1);
    expect((await q({ from: day(-15), to: day(1) })).jsonBody.items.map((i) => i.entityId)).toEqual([c2.id]); // invoice date window (c2 invoiced 10 days ago, the other 40)
    expect((await q({ from: "nope" })).statusCode).toBe(400);
    expect((await q({ status: "weird" })).statusCode).toBe(400);
    expect((await q({ from: day(0), to: day(-5) })).statusCode).toBe(400);
  });
});

// ───────────────────────────────────────── Payments ─────────────────────────────────────────
describe("Payments", () => {
  test("valid payment: number, journal (Dr Cash/Bank, Cr AR), allocations, created-by", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    const r = await record(w, { amount: 600, allocations: [{ invoiceId: inv.h.id, amount: 600 }], remarks: "Part payment" });
    expect(r.statusCode).toBe(201);
    expect(r.jsonBody).toMatchObject({ amount: 600, mode: "BANK_TRANSFER", allocatedAmount: 600, unallocatedAmount: 0, status: "POSTED", remarks: "Part payment" });
    expect(r.jsonBody.number).toMatch(/^PAY\d{8}$/);
    expect(r.jsonBody.createdBy.id).toBe(1);
    expect(r.jsonBody.allocations).toEqual([{ invoiceId: inv.h.id, invoiceNumber: inv.h.invoice_number, amount: 600 }]);
    const je = await db.JournalEntry.findAll({ where: { reference_no: r.jsonBody.number }, raw: true });
    expect(je).toHaveLength(2);
    expect(je.reduce((t, x) => t + Number(x.debit) - Number(x.credit), 0)).toBe(0);
    expect(je.every((x) => x.reference_type === "CUSTOMER_PAYMENT" && x.customer_id === w.cust.id)).toBe(true);
    expect(await arBalance(w.d.distributor_code)).toBe(400);
  });

  test("payment spec example: ₹1,00,000 over invoices of ₹60,000 and ₹40,000", async () => {
    const w = await world(); const a = await invoice(w, 60000); const b = await invoice(w, 40000);
    const r = await record(w, { amount: 100000, allocations: [{ invoiceId: a.h.id, amount: 60000 }, { invoiceId: b.h.id, amount: 40000 }] });
    expect(r.statusCode).toBe(201);
    expect((await outstandingOf(w)).outstanding).toBe(0);
  });

  test("autoAllocate fills the oldest-due invoices first", async () => {
    const w = await world(); const late = await invoice(w, 500, { dueIn: -10, ago: 40 }); const soon = await invoice(w, 500, { dueIn: 10 });
    const r = await record(w, { amount: 700, autoAllocate: true });
    expect(r.jsonBody.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([[late.h.id, 500], [soon.h.id, 200]]);
  });

  test.each([[0], [-5], ["abc"], [1.234], [1e15], [null], [true]])("invalid amount %p is rejected and nothing is written", async (amount) => {
    const w = await world();
    const r = await record(w, { amount });
    expect(r.statusCode).toBe(400);
    expect(await db.Payment.count()).toBe(0); expect(await db.JournalEntry.count()).toBe(0);
  });

  test("invalid date / mode / reference are rejected", async () => {
    const w = await world();
    for (const o of [{ paymentDate: "2026-13-40" }, { paymentDate: undefined }, { paymentDate: day(30) }, { mode: "BITCOIN" }, { referenceNo: "" }, { referenceNo: "bad<script>" }]) {
      expect((await record(w, o)).statusCode).toBe(400);
    }
    expect((await record(w, { mode: "CASH", referenceNo: undefined })).statusCode).toBe(201); // reference is optional for cash
    expect(await db.Payment.count()).toBe(1);
  });

  test("allocation errors: unknown invoice, other retailer's invoice, over-allocation, more than the payment, duplicates", async () => {
    const w = await world(); const c2 = await seedCustomer(w.d.id);
    const mine = await invoice(w, 1000); const theirs = await invoice(w, 1000, { cust: c2 });
    expect((await record(w, { allocations: [{ invoiceId: 999999, amount: 100 }] })).statusCode).toBe(400);
    expect((await record(w, { allocations: [{ invoiceId: theirs.h.id, amount: 100 }] })).statusCode).toBe(400);
    const over = await record(w, { amount: 5000, allocations: [{ invoiceId: mine.h.id, amount: 1000.01 }] });
    expect(over.statusCode).toBe(422); expect(over.jsonBody.code).toBe("EXCEEDS_OUTSTANDING");
    const more = await record(w, { amount: 100, allocations: [{ invoiceId: mine.h.id, amount: 200 }] });
    expect(more.statusCode).toBe(422); expect(more.jsonBody.code).toBe("ALLOCATION_EXCEEDS_PAYMENT");
    expect((await record(w, { amount: 500, allocations: [{ invoiceId: mine.h.id, amount: 100 }, { invoiceId: mine.h.id, amount: 100 }] })).statusCode).toBe(400);
    expect((await record(w, { allocations: [{ invoiceId: mine.h.id, amount: 100 }], autoAllocate: true })).statusCode).toBe(400);
    expect(await db.Payment.count()).toBe(0); expect(await db.PaymentAllocation.count()).toBe(0);
  });

  test("cannot allocate to a fully paid invoice, or to a DRAFT / CANCELLED invoice", async () => {
    const w = await world(); const inv = await invoice(w, 300); const draft = await invoice(w, 300);
    await draft.h.update({ status: "DRAFT" }, { validate: false });
    await record(w, { amount: 300, allocations: [{ invoiceId: inv.h.id, amount: 300 }] });
    expect((await record(w, { allocations: [{ invoiceId: inv.h.id, amount: 10 }] })).statusCode).toBe(400);
    expect((await record(w, { allocations: [{ invoiceId: draft.h.id, amount: 10 }] })).statusCode).toBe(400);
  });

  test("a credit note shrinks what can be allocated", async () => {
    const w = await world(); const inv = await invoice(w, 1000); await creditNote(w, inv, 200);
    expect((await record(w, { amount: 900, allocations: [{ invoiceId: inv.h.id, amount: 900 }] })).statusCode).toBe(422);
    expect((await record(w, { amount: 800, allocations: [{ invoiceId: inv.h.id, amount: 800 }] })).statusCode).toBe(201);
    expect((await outstandingOf(w)).outstanding).toBe(0);
  });

  test("cross-tenant: unknown retailer 404; retailer from a different distributor than the one named is refused; client distributorId never decides the tenant", async () => {
    const w = await world(); const w2 = await world();
    expect((await record(w, { customerId: 999999 })).statusCode).toBe(404);
    const mismatch = await record(w, { customerId: w2.cust.id, distributorId: w.d.id });
    expect(mismatch.statusCode).toBe(400); expect(mismatch.jsonBody.code).toBe("RETAILER_DISTRIBUTOR_MISMATCH");
    const ok = await record(w2, { distributorId: w.d.id === w2.d.id ? undefined : undefined });
    expect(ok.statusCode).toBe(201);
    expect(ok.jsonBody.distributor.id).toBe(w2.d.id); // derived from the retailer
    expect(await db.JournalEntry.count({ where: { distributor_code: w.d.distributor_code } })).toBe(0);
  });

  test("cross-distributor: an invoice of another distributor's retailer cannot be allocated", async () => {
    const w = await world(); const w2 = await world(); const other = await invoice(w2, 1000);
    expect((await record(w, { allocations: [{ invoiceId: other.h.id, amount: 100 }] })).statusCode).toBe(400);
  });

  test("duplicate payment reference is refused per distributor but allowed for another distributor", async () => {
    const w = await world(); const w2 = await world();
    expect((await record(w, { referenceNo: "UTR-1" })).statusCode).toBe(201);
    const dup = await record(w, { referenceNo: "UTR-1" });
    expect(dup.statusCode).toBe(409); expect(dup.jsonBody.code).toBe("DUPLICATE_REFERENCE");
    expect((await record(w2, { referenceNo: "UTR-1" })).statusCode).toBe(201);
    expect((await record(w, { mode: "CASH", referenceNo: undefined })).statusCode).toBe(201);
    expect((await record(w, { mode: "CASH", referenceNo: undefined })).statusCode).toBe(201); // many cash payments without a reference
  });

  test("the unique constraint itself blocks a duplicate reference", async () => {
    const w = await world();
    const mk = () => db.Payment.create({ payment_number: `P${++seq}`, distributor_id: w.d.id, customer_id: w.cust.id, payment_date: day(0), amount: 1, mode: "UPI", reference_no: "SAME" });
    await mk(); await expect(mk()).rejects.toThrow();
  });

  test("atomic: a missing GL account rolls back the payment, allocations and invoice balance", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    const acc = require("../services/accounting.service"); // standard accounts are auto-created now, so simulate the lookup failing
    const spy = jest.spyOn(acc, "getGL").mockRejectedValueOnce(new acc.AccountingError("GL not configured: Cash/Bank"));
    const r = await record(w, { amount: 400, allocations: [{ invoiceId: inv.h.id, amount: 400 }] });
    spy.mockRestore();
    expect(r.statusCode).toBe(400); expect(r.jsonBody.code).toBe("GL_NOT_CONFIGURED");
    expect(await db.Payment.count()).toBe(0); expect(await db.PaymentAllocation.count()).toBe(0);
    expect(Number((await db.SalesInvoiceHeader.findByPk(inv.h.id)).outstandingAmount)).toBe(1000);
    expect(await db.JournalEntry.count({ where: { reference_type: "CUSTOMER_PAYMENT" } })).toBe(0);
  });

  test("atomic: a failure while writing the journal leaves no payment behind", async () => {
    const w = await world(); const inv = await invoice(w, 1000);
    const spy = jest.spyOn(db.JournalEntry, "bulkCreate").mockRejectedValueOnce(new Error("boom"));
    const r = await record(w, { amount: 400, allocations: [{ invoiceId: inv.h.id, amount: 400 }] });
    spy.mockRestore();
    expect(r.statusCode).toBe(500);
    expect(await db.Payment.count()).toBe(0); expect(await db.PaymentAllocation.count()).toBe(0);
  });

  test("list / get / filters; the numbers of a payment are never taken from the body", async () => {
    const w = await world();
    const r = await record(w, { amount: 100, mode: "UPI", referenceNo: "UPI-77", status: "CANCELLED", payment_number: "HACK", created_by_admin_id: 999 });
    expect(r.jsonBody.status).toBe("POSTED"); expect(r.jsonBody.number).not.toBe("HACK"); expect(r.jsonBody.createdBy.id).toBe(1);
    await record(w, { amount: 50, mode: "CASH", referenceNo: undefined });
    const all = await A(adminAccounts.payments, { query: { retailerId: w.cust.id } });
    expect(all.jsonBody).toMatchObject({ total: 2, totalAmount: 150 });
    expect((await A(adminAccounts.payments, { query: { mode: "upi" } })).jsonBody.items).toHaveLength(1);
    expect((await A(adminAccounts.payments, { query: { search: "UPI-77" } })).jsonBody.items).toHaveLength(1);
    expect((await A(adminAccounts.payments, { query: { from: day(1) } })).jsonBody.items).toHaveLength(0);
    expect((await A(adminAccounts.payment, { params: { id: r.jsonBody.id } })).jsonBody.number).toBe(r.jsonBody.number);
    expect((await A(adminAccounts.payment, { params: { id: 99999 } })).statusCode).toBe(404);
    expect((await A(adminAccounts.payments, { query: { mode: "bitcoin" } })).statusCode).toBe(400);
  });

  test("open-invoices lookup lists only the retailer's invoices that still owe money", async () => {
    const w = await world(); const a = await invoice(w, 1000); await invoice(w, 200);
    await record(w, { amount: 200, allocations: [{ invoiceId: a.h.id, amount: 200 }] });
    const r = await A(adminAccounts.openInvoices, { query: { retailerId: w.cust.id } });
    expect(r.jsonBody.map((i) => [i.open, i.paymentStatus]).sort()).toEqual([[200, "UNPAID"], [800, "PARTIALLY_PAID"]]);
    expect((await A(adminAccounts.openInvoices, { query: { retailerId: 999999 } })).statusCode).toBe(404);
  });
});

// ───────────────────────────────────────── Credit ─────────────────────────────────────────
describe("Credit limit", () => {
  test("set / update / clear a distributor and a retailer limit; utilisation and available credit", async () => {
    const w = await world(); await invoice(w, 1000); const inv2 = await invoice(w, 500); await creditNote(w, inv2, 100);
    const setD = await A(adminAccounts.updateCredit, { params: { entityId: w.d.id }, body: { entityType: "DISTRIBUTOR", creditLimit: 5000 } });
    expect(setD.statusCode).toBe(200);
    expect(setD.jsonBody).toMatchObject({ entityType: "DISTRIBUTOR", creditLimit: 5000, utilised: 1400, availableCredit: 3600, utilisationPct: 28, overLimit: false });
    expect(Number((await db.Distributor.findByPk(w.d.id)).credit_limit)).toBe(5000); // the EXISTING field
    const setR = await A(adminAccounts.updateCredit, { params: { entityId: w.cust.id }, body: { entityType: "RETAILER", creditLimit: 1000 } });
    expect(setR.jsonBody).toMatchObject({ creditLimit: 1000, utilised: 1400, availableCredit: -400, overLimit: true });
    expect((await A(adminAccounts.updateCredit, { params: { entityId: w.cust.id }, body: { entityType: "RETAILER", creditLimit: null } })).jsonBody.creditLimit).toBeNull();
    const list = await A(adminAccounts.credit, { query: { entityType: "DISTRIBUTOR" } });
    expect(list.jsonBody).toMatchObject({ enforced: false });
    expect(list.jsonBody.items[0]).toMatchObject({ creditLimit: 5000, availableCredit: 3600 });
  });

  test.each([[-1], ["x"], [1e12], [10.123], [true], [""]])("invalid credit limit %p is rejected and nothing changes", async (creditLimit) => {
    const w = await world();
    const r = await A(adminAccounts.updateCredit, { params: { entityId: w.d.id }, body: { entityType: "DISTRIBUTOR", creditLimit } });
    expect(r.statusCode).toBe(400);
    expect((await db.Distributor.findByPk(w.d.id)).credit_limit).toBeNull();
  });

  test("bad entity type / unknown entity", async () => {
    const w = await world();
    expect((await A(adminAccounts.updateCredit, { params: { entityId: w.d.id }, body: { creditLimit: 1 } })).statusCode).toBe(400);
    expect((await A(adminAccounts.updateCredit, { params: { entityId: 99999 }, body: { entityType: "DISTRIBUTOR", creditLimit: 1 } })).statusCode).toBe(404);
  });

  test("unauthorised modification: not an admin scope, no distributor handler, route guarded; distributor sees only own credit", async () => {
    const w = await world(); const w2 = await world();
    await expect(rec.updateCredit({ role: "distributor", distributorId: w.d.id }, w.d.id, { entityType: "DISTRIBUTOR", creditLimit: 1 })).rejects.toThrow(/administrator/);
    expect(Object.keys(distAccounts)).not.toEqual(expect.arrayContaining(["updateCredit"]));
    const layer = adminRoutes.stack.find((l) => l.route && l.route.path === "/accounts/credit/:entityId" && l.route.methods.put);
    expect(layer.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    await A(adminAccounts.updateCredit, { params: { entityId: w2.d.id }, body: { entityType: "DISTRIBUTOR", creditLimit: 777 } });
    const mine = await D(distAccounts.credit, w.d, { query: { distributorId: w2.d.id } });
    expect(mine.jsonBody.items.every((i) => i.distributorId === w.d.id)).toBe(true);
    expect(mine.jsonBody.items.find((i) => i.entityType === "DISTRIBUTOR").creditLimit).toBeNull();
  });

  test("credit limits are visibility only: sales orders are not blocked by an exceeded limit", async () => {
    const w = await world(); await invoice(w, 1000);
    await db.Distributor.update({ credit_limit: 1 }, { where: { id: w.d.id } });
    const order = await seedSalesOrder(w.d, { productId: w.p.id, quantity: 1, pricePerUnit: 10 });
    expect(order.id).toBeTruthy();
  });
});

// ───────────────────────────────────────── Ageing ─────────────────────────────────────────
describe("Ageing (by due date)", () => {
  test("every bucket, using the invoice due date", async () => {
    const w = await world();
    const cases = [["NOT_DUE", 5], ["D1_30", -10], ["D31_60", -45], ["D61_90", -75], ["D91_180", -120], ["D180_PLUS", -200]];
    const invs = {};
    for (const [key, dueIn] of cases) invs[key] = await invoice(w, 100, { dueIn, ago: Math.max(1, 30 - dueIn), cust: await seedCustomer(w.d.id) });
    const r = await A(adminAccounts.ageing, { query: { entityType: "RETAILER" } });
    expect(r.statusCode).toBe(200);
    for (const [key] of cases) {
      const row = r.jsonBody.items.find((i) => i.entityId === invs[key].h.customer_id);
      expect(row.buckets[key]).toBe(100);
      expect(row.ageingBucket).toBe(key);
      expect(row.overdue).toBe(key === "NOT_DUE" ? 0 : 100);
    }
    expect(r.jsonBody.totals).toMatchObject({ outstanding: 600, overdue: 500, invoiceCount: 6 });
    expect(Object.values(r.jsonBody.totals.buckets)).toEqual([100, 100, 100, 100, 100, 100]);
  });

  test("bucket edges: due today is Not due; 1, 30, 31, 90, 91, 180, 181 days late", async () => {
    expect(rec.bucketFor(0).key).toBe("NOT_DUE");
    expect([1, 30, 31, 60, 61, 90, 91, 180, 181].map((n) => rec.bucketFor(n).key)).toEqual(["D1_30", "D1_30", "D31_60", "D31_60", "D61_90", "D61_90", "D91_180", "D91_180", "D180_PLUS"]);
  });

  test("ageing uses the due date, not the invoice creation date", async () => {
    const w = await world();
    await invoice(w, 100, { ago: 200, dueIn: 10 }); // created 200 days ago but only due in 10 days
    const o = await outstandingOf(w);
    expect(o.ageingBucket).toBe("NOT_DUE"); expect(o.overdue).toBe(0);
  });

  test("a paid invoice leaves ageing; a missing due date falls back to invoice date + payment terms; asOf moves the clock", async () => {
    const w = await world(); const a = await invoice(w, 100, { dueIn: -10, ago: 40 }); const b = await invoice(w, 200, { ago: 50 });
    await b.h.update({ dueDate: null, paymentTerms: "Net 15" }, { validate: false }); // due = 50 days ago + 15 = 35 days late
    await record(w, { amount: 100, allocations: [{ invoiceId: a.h.id, amount: 100 }] });
    const r = await A(adminAccounts.ageing, { query: {} });
    expect(r.jsonBody.items[0].buckets.D31_60).toBe(200);
    expect(r.jsonBody.totals.outstanding).toBe(200);
    const future = await A(adminAccounts.ageing, { query: { asOf: day(200) } });
    expect(future.jsonBody.items[0].ageingBucket).toBe("D180_PLUS");
    expect((await A(adminAccounts.ageing, { query: { asOf: "bad" } })).statusCode).toBe(400);
  });

  test("distributor-level ageing groups its retailers", async () => {
    const w = await world(); await invoice(w, 100, { dueIn: -5, ago: 30 }); await invoice(w, 100, { dueIn: -50, ago: 80, cust: await seedCustomer(w.d.id) });
    const r = await A(adminAccounts.ageing, { query: { entityType: "DISTRIBUTOR" } });
    expect(r.jsonBody.items).toHaveLength(1);
    expect(r.jsonBody.items[0]).toMatchObject({ entityType: "DISTRIBUTOR", retailerCount: 2, invoiceCount: 2, outstanding: 200, overdue: 200, ageingBucket: "D31_60" });
  });
});

// ───────────────────────────────────────── Ledger ─────────────────────────────────────────
describe("Ledger", () => {
  test("debit, credit, running balance and ordering across invoice / payment / credit note / return adjustment", async () => {
    const w = await world();
    const i1 = await invoice(w, 1000, { ago: 20 }); const i2 = await invoice(w, 500, { ago: 15 });
    await creditNote(w, i1, 100);
    await creditNote(w, i2, 50, { sourceReturnId: 42 });
    await record(w, { amount: 300, paymentDate: day(-1), allocations: [{ invoiceId: i1.h.id, amount: 300 }] });
    const r = await A(adminAccounts.ledger, { query: { entityType: "RETAILER", entityId: w.cust.id } });
    expect(r.statusCode).toBe(200);
    const e = r.jsonBody.entries;
    // ordered by transaction date: invoices (20 and 15 days ago), the payment (yesterday), then the two credit notes (posted now)
    expect(e.map((x) => x.type)).toEqual(["Invoice", "Invoice", "Payment", "Credit Note", "Return adjustment"]);
    expect(e.map((x) => [x.debit, x.credit, x.balance])).toEqual([[1000, 0, 1000], [500, 0, 1500], [0, 300, 1200], [0, 100, 1100], [0, 50, 1050]]);
    expect(e[0].reference).toBe(i1.h.invoice_number);
    expect(e[2].reference).toMatch(/^PAY\d{8}$/);
    expect(e[3].reference).toMatch(/^CN\d+$/);
    expect(r.jsonBody).toMatchObject({ openingBalance: 0, totalDebit: 1500, totalCredit: 450, closingBalance: 1050 });
    expect(r.jsonBody.closingBalance).toBe((await outstandingOf(w)).outstanding);
    const dates = e.map((x) => new Date(x.date).getTime()); expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });

  test("date window gives the correct opening balance; distributor-level ledger covers all retailers", async () => {
    const w = await world(); const c2 = await seedCustomer(w.d.id);
    await invoice(w, 1000, { ago: 30 }); await invoice(w, 400, { ago: 5, cust: c2 });
    const r = await A(adminAccounts.ledger, { query: { entityType: "DISTRIBUTOR", entityId: w.d.id, from: day(-10) } });
    expect(r.jsonBody).toMatchObject({ openingBalance: 1000, totalDebit: 400, closingBalance: 1400 });
    expect(r.jsonBody.entries[0].retailer).toBe(c2.name);
    const page = await A(adminAccounts.ledger, { query: { entityType: "DISTRIBUTOR", entityId: w.d.id, pageSize: 1, page: 2 } });
    expect(page.jsonBody).toMatchObject({ total: 2, page: 2 }); expect(page.jsonBody.entries).toHaveLength(1);
  });

  test("validation: missing id, bad dates, claims account only per distributor, unknown entity", async () => {
    const w = await world();
    expect((await A(adminAccounts.ledger, { query: { entityType: "RETAILER" } })).statusCode).toBe(400);
    expect((await A(adminAccounts.ledger, { query: { entityType: "RETAILER", entityId: w.cust.id, from: "x" } })).statusCode).toBe(400);
    expect((await A(adminAccounts.ledger, { query: { entityType: "RETAILER", entityId: w.cust.id, account: "CLAIMS" } })).statusCode).toBe(400);
    expect((await A(adminAccounts.ledger, { query: { entityType: "RETAILER", entityId: 999999 } })).statusCode).toBe(404);
  });
});

// ───────────────────────────────────────── Claims → accounting ─────────────────────────────────────────
let cseq = 0;
async function claimWorld(opts) {
  const w = await world(opts);
  const mk = await A(adminSchemes.create, { body: { name: "Buy10Get1", scheme_code: `P12${++cseq}`, scheme_type: "QUANTITY_FREE", product_ids: [w.p.id], buy_quantity: 10, free_quantity: 1, valid_from: day(-60), valid_to: day(60) } });
  const inv = await invoice(w, 2000, { qty: 20, ago: 5 }); // 20 × ₹100 → 2 free = ₹200
  return { ...w, scheme: mk.jsonBody, inv };
}
const claimBody = (w) => ({ invoice_id: w.inv.h.id, scheme_id: w.scheme.id, period_from: day(-30), period_to: day(0), description: "Free goods given", items: [{ invoice_line_id: w.inv.line.id, quantity: 20 }] });
const draftClaim = async (w) => (await D(distClaims.create, w.d, { body: claimBody(w) })).jsonBody;
const submitted = async (w) => { const c = await draftClaim(w); await D(distClaims.submit, w.d, { params: { id: c.id } }); return c; };
const underReview = async (w) => { const c = await submitted(w); await A(adminClaims.review, { params: { id: c.id } }); return c; };
const claimJournal = (ref) => db.JournalEntry.findAll({ where: { reference_type: "CLAIM_SETTLEMENT", ...(ref ? { reference_no: ref } : {}) }, raw: true });

describe("Claim → accounting", () => {
  test("approval posts ONE balanced settlement, links it to the claim, and moves the ledger — outstanding is not touched", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    const before = await outstandingOf(w);
    const r = await A(adminClaims.approve, { params: { id: c.id }, body: { comment: "ok" } });
    expect(r.statusCode).toBe(200);
    expect(r.jsonBody).toMatchObject({ status: "APPROVED", financialStatus: "SETTLED", settlementReference: `SET-${c.number}` });
    expect(r.jsonBody.amount).toBe(200);

    const rows = await claimJournal(`SET-${c.number}`);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((t, x) => t + Number(x.debit), 0)).toBe(200);
    expect(rows.reduce((t, x) => t + Number(x.credit), 0)).toBe(200);
    const gls = await db.GLMaster.findAll({ where: { id: rows.map((x) => x.gl_id) }, raw: true });
    expect(gls.map((g) => g.gl_name).sort()).toEqual(["Scheme Claim Income", "Scheme Claims Receivable"]);
    expect(rows.every((x) => x.distributor_code === w.d.distributor_code)).toBe(true);

    const claim = await db.Claim.findByPk(c.id);
    expect(claim.settled_at).toBeTruthy(); expect(claim.settled_by_admin_id).toBe(1); expect(claim.settlement_reference).toBe(`SET-${c.number}`);

    // outstanding (retailer receivables) unchanged — the claim is NOT netted against what the retailer owes
    const after = await outstandingOf(w);
    expect(after.outstanding).toBe(before.outstanding);
    expect(after.claimSettled).toBe(200);
    expect(await arBalance(w.d.distributor_code)).toBe(2000);

    // ledger: claims account shows the settlement; the retailer ledger does not
    const cl = await A(adminAccounts.ledger, { query: { entityType: "DISTRIBUTOR", entityId: w.d.id, account: "CLAIMS" } });
    expect(cl.jsonBody.entries).toHaveLength(1);
    expect(cl.jsonBody.entries[0]).toMatchObject({ type: "Claim settlement", reference: `SET-${c.number}`, debit: 200, credit: 0, balance: 200 });
    const rl = await A(adminAccounts.ledger, { query: { entityType: "RETAILER", entityId: w.cust.id } });
    expect(rl.jsonBody.entries.some((e) => e.typeCode === "CLAIM_SETTLEMENT")).toBe(false);

    // summary: settled, nothing pending
    const s = await A(adminAccounts.summary);
    expect(s.jsonBody.claimsSettled).toEqual({ count: 1, amount: 200 }); expect(s.jsonBody.claimsPendingSettlement).toEqual({ count: 0, amount: 0 });
    // the distributor sees the same state read-only
    const dv = await D(distClaims.get, w.d, { params: { id: c.id } });
    expect(dv.jsonBody).toMatchObject({ financialStatus: "SETTLED" });
    const dl = await D(distAccounts.ledger, w.d, { query: { entityType: "DISTRIBUTOR", account: "CLAIMS" } });
    expect(dl.jsonBody.entries).toHaveLength(1);
  });

  test("IDEMPOTENT: approving or settling the same claim again creates no second entry", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    expect((await A(adminClaims.approve, { params: { id: c.id } })).statusCode).toBe(200);
    expect((await A(adminClaims.approve, { params: { id: c.id } })).statusCode).toBe(409); // already terminal
    const again = await A(adminClaims.settle, { params: { id: c.id } });
    expect(again.statusCode).toBe(409); expect(again.jsonBody.code).toBe("ALREADY_SETTLED");
    expect(await claimJournal()).toHaveLength(2);
    expect(await db.GLMaster.count({ where: { gl_name: "Scheme Claims Receivable" } })).toBe(1);
  });

  test("IDEMPOTENT at the accounting layer: a second settleClaim in the same transaction is refused, and the unique reference blocks a duplicate row", async () => {
    const w = await claimWorld(); const c = await underReview(w); await A(adminClaims.approve, { params: { id: c.id } });
    const claim = await db.Claim.findByPk(c.id);
    const t = await db.sequelize.transaction();
    await expect(accounting.settleClaim({ claim, adminId: 1, transaction: t })).rejects.toMatchObject({ statusCode: 409 });
    await t.rollback();
    const other = await db.Claim.create({ claim_number: "CLM-OTHER", distributor_id: w.d.id, scheme_id: 1, invoice_id: 1, claim_date: day(0), period_from: day(-1), period_to: day(0) });
    await expect(other.update({ settlement_reference: `SET-${c.number}` })).rejects.toThrow();
    expect(await claimJournal()).toHaveLength(2);
  });

  test("two racing approvals leave exactly one settlement", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    const results = await Promise.allSettled([A(adminClaims.approve, { params: { id: c.id } }), A(adminClaims.approve, { params: { id: c.id } })]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.statusCode : 500)).sort();
    expect(codes.filter((x) => x === 200)).toHaveLength(1);
    expect(await claimJournal()).toHaveLength(2);
  });

  test("atomic: if the settlement cannot be written, the approval is rolled back too", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    const spy = jest.spyOn(db.JournalEntry, "bulkCreate").mockRejectedValueOnce(new Error("boom"));
    const r = await A(adminClaims.approve, { params: { id: c.id } });
    spy.mockRestore();
    expect(r.statusCode).toBe(500);
    const claim = await db.Claim.findByPk(c.id);
    expect(claim.status).toBe("UNDER_REVIEW"); expect(claim.settled_at).toBeNull(); expect(claim.settlement_reference).toBeNull();
    expect(await claimJournal()).toHaveLength(0);
    expect(await db.ClaimStatusHistory.count({ where: { claim_id: c.id, to_status: "APPROVED" } })).toBe(0);
    expect((await A(adminClaims.approve, { params: { id: c.id } })).statusCode).toBe(200); // and it can be retried cleanly
    expect(await claimJournal()).toHaveLength(2);
  });

  test("REJECTED and NEEDS_CORRECTION create no accounting; resubmission creates none until approval", async () => {
    const w = await claimWorld();
    const c1 = await underReview(w);
    expect((await A(adminClaims.needsCorrection, { params: { id: c1.id }, body: { reason: "Please add detail", required_information: "x" } })).statusCode).toBe(200);
    expect(await db.JournalEntry.count({ where: { reference_type: "CLAIM_SETTLEMENT" } })).toBe(0);
    await D(distClaims.update, w.d, { params: { id: c1.id }, body: { ...claimBody(w), description: "More detail" } });
    expect((await D(distClaims.resubmit, w.d, { params: { id: c1.id } })).statusCode).toBe(200);
    await A(adminClaims.review, { params: { id: c1.id } });
    expect(await db.JournalEntry.count({ where: { reference_type: "CLAIM_SETTLEMENT" } })).toBe(0);
    expect((await A(adminClaims.reject, { params: { id: c1.id }, body: { reason: "Not eligible" } })).statusCode).toBe(200);
    expect(await db.JournalEntry.count({ where: { reference_type: "CLAIM_SETTLEMENT" } })).toBe(0);
    const rejected = await db.Claim.findByPk(c1.id);
    expect(rejected.settled_at).toBeNull();
    expect((await A(adminClaims.settle, { params: { id: c1.id } })).jsonBody.code).toBe("CLAIM_NOT_APPROVED"); // cannot be settled by the back door
    expect(await db.JournalEntry.count({ where: { reference_type: "CLAIM_SETTLEMENT" } })).toBe(0);
    const d = await draftClaim({ ...w, inv: await invoice(w, 2000, { qty: 20, ago: 4 }) }); // DRAFT / SUBMITTED / UNDER_REVIEW also settle nothing
    expect((await A(adminClaims.settle, { params: { id: d.id } })).statusCode).toBe(409);
    expect(await db.JournalEntry.count({ where: { reference_type: "CLAIM_SETTLEMENT" } })).toBe(0);
  });

  test("a claim approved BEFORE Phase 12 shows as pending and can be settled exactly once", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    await A(adminClaims.approve, { params: { id: c.id } });
    // simulate a pre-Phase-12 approval: roll the settlement back out of the books
    await db.JournalEntry.destroy({ where: { reference_type: "CLAIM_SETTLEMENT" } });
    await db.Claim.update({ settled_at: null, settlement_reference: null, settled_by_admin_id: null }, { where: { id: c.id } });
    const s1 = await A(adminAccounts.summary);
    expect(s1.jsonBody.claimsPendingSettlement).toEqual({ count: 1, amount: 200 });
    expect((await A(adminClaims.get, { params: { id: c.id } })).jsonBody.financialStatus).toBe("PENDING_SETTLEMENT");
    expect((await A(adminClaims.settle, { params: { id: c.id } })).statusCode).toBe(200);
    expect(await claimJournal()).toHaveLength(2);
    expect((await A(adminClaims.settle, { params: { id: c.id } })).statusCode).toBe(409);
    expect(await claimJournal()).toHaveLength(2);
  });

  test("approval still works for a distributor that has no GL accounts at all (claim accounts are auto-provisioned)", async () => {
    const w = await claimWorld(); const c = await underReview(w);
    await db.GLMaster.destroy({ where: { distributor_code: w.d.distributor_code } }); // this distributor has no GL setup at all
    expect((await A(adminClaims.approve, { params: { id: c.id } })).statusCode).toBe(200);
    expect(await db.GLMaster.count({ where: { distributor_code: w.d.distributor_code } })).toBe(2);
  });

  test("the settlement is tenant-scoped: it is booked in the claim's own distributor", async () => {
    const w = await claimWorld(); const w2 = await claimWorld(); const c = await underReview(w);
    await A(adminClaims.approve, { params: { id: c.id } });
    expect((await claimJournal()).every((x) => x.distributor_code === w.d.distributor_code)).toBe(true);
    const other = await D(distAccounts.ledger, w2.d, { query: { entityType: "DISTRIBUTOR", account: "CLAIMS" } });
    expect(other.jsonBody.entries).toHaveLength(0);
    expect((await D(distAccounts.ledger, w2.d, { query: { entityType: "DISTRIBUTOR", entityId: w.d.id, account: "CLAIMS" } })).statusCode).toBe(404);
  });
});

// ───────────────────────────────────────── Authorization & scope ─────────────────────────────────────────
describe("Authorization & distributor scope", () => {
  test("every admin accounts route is behind requireAdmin; distributor accounts routes are GET-only", () => {
    const layers = adminRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/accounts"));
    expect(layers.length).toBe(11);
    for (const l of layers) expect(l.route.stack.some((s) => s.handle === requireAdmin)).toBe(true);
    const dist = allRoutes.stack.filter((l) => l.route && l.route.path.startsWith("/accounts"));
    expect(dist.length).toBe(8);
    for (const l of dist) expect(Object.keys(l.route.methods)).toEqual(["get"]);
    expect(Object.keys(distAccounts).sort()).toEqual(["ageing", "credit", "ledger", "lookups", "outstanding", "payment", "payments", "summary"]);
  });

  test("a distributor only ever sees its own money, whatever it puts in the query", async () => {
    const w = await world(); const w2 = await world();
    await invoice(w, 1000); await invoice(w2, 7777);
    await A(adminAccounts.createPayment, { body: payBody(w2, { amount: 111 }) });
    const q = { distributorId: w2.d.id, retailerId: w2.cust.id, entityId: w2.cust.id };
    const s = await D(distAccounts.summary, w.d, { query: q });
    expect(s.jsonBody.totalReceivables).toBe(1000);
    const o = await D(distAccounts.outstanding, w.d, { query: q });
    expect(o.jsonBody.items).toEqual([]); // asking for the other distributor's retailer yields nothing
    const o2 = await D(distAccounts.outstanding, w.d, { query: {} });
    expect(o2.jsonBody.items.every((i) => i.distributorId === w.d.id)).toBe(true);
    expect((await D(distAccounts.ageing, w.d, { query: q })).jsonBody.items).toEqual([]);
    expect((await D(distAccounts.ledger, w.d, { query: { entityType: "RETAILER", entityId: w2.cust.id } })).statusCode).toBe(404);
    expect((await D(distAccounts.payments, w.d, { query: q })).jsonBody.items).toEqual([]);
    const theirs = (await A(adminAccounts.payments, { query: { distributorId: w2.d.id } })).jsonBody.items[0];
    expect((await D(distAccounts.payment, w.d, { params: { id: theirs.id } })).statusCode).toBe(404);
    expect((await D(distAccounts.payment, w2.d, { params: { id: theirs.id } })).statusCode).toBe(200);
  });

  test("distributor can see own retailers' outstanding, ledger, payments, ageing, credit", async () => {
    const w = await world(); const inv = await invoice(w, 1000, { dueIn: -3, ago: 30 });
    await A(adminAccounts.createPayment, { body: payBody(w, { amount: 250, allocations: [{ invoiceId: inv.h.id, amount: 250 }] }) });
    expect((await D(distAccounts.outstanding, w.d, { query: { entityType: "RETAILER" } })).jsonBody.items[0]).toMatchObject({ outstanding: 750, overdue: 750 });
    expect((await D(distAccounts.ledger, w.d, { query: { entityType: "RETAILER", entityId: w.cust.id } })).jsonBody.closingBalance).toBe(750);
    expect((await D(distAccounts.ledger, w.d, { query: { entityType: "DISTRIBUTOR" } })).jsonBody.closingBalance).toBe(750); // defaults to itself
    expect((await D(distAccounts.payments, w.d)).jsonBody.items).toHaveLength(1);
    expect((await D(distAccounts.ageing, w.d)).jsonBody.totals.outstanding).toBe(750);
    const credit = (await D(distAccounts.credit, w.d)).jsonBody.items;
    expect(credit.filter((i) => i.entityType === "DISTRIBUTOR")).toHaveLength(1);
    expect(credit.filter((i) => i.entityType === "RETAILER").length).toBeGreaterThanOrEqual(1);
    expect(credit.every((i) => i.distributorId === w.d.id)).toBe(true);
    expect((await D(distAccounts.lookups, w.d)).jsonBody.distributors).toEqual([]);
  });

  test("unauthenticated / inactive distributor is refused", async () => {
    const w = await world();
    const res = mockRes(); await distAccounts.summary({ user: undefined, query: {} }, res); expect(res.statusCode).toBe(401);
    await db.Distributor.update({ status: "inactive" }, { where: { id: w.d.id } });
    expect((await D(distAccounts.summary, w.d)).statusCode).toBe(403);
    const next = jest.fn(); await requireAdmin({ cookies: { distributor_token: "x" }, headers: { authorization: "Bearer x" } }, mockRes(), next); expect(next).not.toHaveBeenCalled(); // a distributor token never opens an admin route
  });

  test("no retailer login / portal was added", () => {
    const paths = [...adminRoutes.stack, ...allRoutes.stack].filter((l) => l.route).map((l) => l.route.path);
    expect(paths.some((p) => /retailer.*(login|portal|dashboard)/i.test(p))).toBe(false);
  });
});

// ───────────────────────────────────────── Summary & lookups ─────────────────────────────────────────
describe("Summary", () => {
  test("empty system shows zeros, not invented numbers", async () => {
    const r = await A(adminAccounts.summary);
    expect(r.jsonBody).toMatchObject({ hasData: false, totalReceivables: 0, overdueAmount: 0, todayCollections: 0, monthCollections: 0, totalCreditLimit: 0, creditUtilisationPct: null, claimsPendingSettlement: { count: 0, amount: 0 } });
  });

  test("KPIs are calculated from the books", async () => {
    const w = await world(); await db.Distributor.update({ credit_limit: 10000 }, { where: { id: w.d.id } });
    const a = await invoice(w, 1000, { dueIn: -10, ago: 40 }); await invoice(w, 500);
    await record(w, { amount: 300, paymentDate: day(0), allocations: [{ invoiceId: a.h.id, amount: 300 }] });
    await record(w, { amount: 100, paymentDate: day(-40), mode: "CASH", referenceNo: undefined });
    const s = (await A(adminAccounts.summary)).jsonBody;
    expect(s).toMatchObject({ hasData: true, totalReceivables: 1100, overdueAmount: 600, todayCollections: 300, totalCreditLimit: 10000, creditUtilised: 1100, creditUtilisationPct: 11 });
    expect(s.monthCollections).toBeGreaterThanOrEqual(300);
    expect((await A(adminAccounts.lookups)).jsonBody.paymentModes).toEqual(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "OTHER"]);
  });
});

// ───────────────────────────────────────── Migration ─────────────────────────────────────────
describe("Migration", () => {
  test("is idempotent and reversible (up → up → down → up)", async () => {
    const { Sequelize } = require("sequelize");
    const qi = db.sequelize.getQueryInterface();
    const m = require("../migrations/20261005090000-accounts-phase12");
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    await m.up(qi, Sequelize); await m.up(qi, Sequelize);
    expect(await tables()).toEqual(expect.arrayContaining(["Payments", "PaymentAllocations"]));
    await m.down(qi, Sequelize);
    expect(await tables()).not.toContain("Payments");
    expect(Object.keys(await qi.describeTable("Claims"))).not.toContain("settlement_reference");
    expect(Object.keys(await qi.describeTable("Customers"))).not.toContain("credit_limit");
    await m.up(qi, Sequelize);
    expect(Object.keys(await qi.describeTable("Claims"))).toEqual(expect.arrayContaining(["settlement_reference", "settled_at", "settled_by_admin_id"]));
    expect(Object.keys(await qi.describeTable("Customers"))).toContain("credit_limit");
    await db.sequelize.sync({ force: true }); // restore the model-defined schema for any later test
  });
});
