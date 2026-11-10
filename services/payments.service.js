// services/payments.service.js — Phase 12 payment recording and invoice-level allocation (Admin writes, Distributor reads).
//
// A payment is written as ONE transaction: Payment row → PaymentAllocation rows → the double-entry journal (Dr Cash/Bank, Cr Accounts
// Receivable, reference_type CUSTOMER_PAYMENT — the same posting the legacy /payment/receive uses) → the stored balance/status of every
// invoice it touched. If any step fails nothing is kept.
//
// Allocation rules
//   • An allocation can never exceed that invoice's open amount (total − posted credit notes − earlier allocations).
//   • The allocations can never exceed the payment amount.
//   • Whatever is not allocated stays on the retailer's account as an unapplied credit (advance). This IS supported: the existing
//     receipt flow already posts un-allocated credits, and ageing/outstanding apply them oldest-first (see receivables.service.js).
//   • autoAllocate:true allocates the whole payment to the oldest-due open invoices.
const { Op, fn, col, UniqueConstraintError } = require("sequelize");
const db = require("../models");
const accounting = require("./accounting.service");
const q = require("./salesQuery");
const { QueryError } = q;

const { ACCOUNTS, round2 } = accounting;
const LIVE_INVOICE = ["POSTED", "PARTIALLY_PAID", "PAID"];
const OPEN_INVOICE = ["POSTED", "PARTIALLY_PAID"];
const REFERENCE_REQUIRED = ["BANK_TRANSFER", "UPI", "CHEQUE"];
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,59}$/;
const MAX_AMOUNT = 99999999999.99;
const DAY = 86400000;

class PaymentError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new PaymentError(400, "VALIDATION_FAILED", message, details);
const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));

function money(v, name, { allowZero = false } = {}) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || Array.isArray(v) || typeof v === "object") throw bad(`${name} is required`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (n < 0 || (!allowZero && n === 0)) throw bad(`${name} must be greater than zero`);
  if (n > MAX_AMOUNT) throw bad(`${name} is too large`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw bad(`${name} can have at most 2 decimal places`);
  return round2(n);
}

// ───────────────────────── invoice balances ─────────────────────────
// Open amount of each invoice = total − posted credit notes − allocations. Single definition shared with receivables.service.js's inputs.
async function openAmounts(invoices, transaction) {
  if (!invoices.length) return new Map();
  const ids = invoices.map((i) => Number(i.id));
  const cn = await db.SalesCreditNote.findAll({ where: { invoiceId: { [Op.in]: ids }, status: "POSTED" }, attributes: ["invoiceId", [fn("SUM", col("totalAmount")), "amount"]], group: ["invoiceId"], raw: true, transaction });
  const al = await db.PaymentAllocation.findAll({ where: { invoice_id: { [Op.in]: ids } }, attributes: ["invoice_id", [fn("SUM", col("amount")), "amount"]], group: ["invoice_id"], raw: true, transaction });
  const cnMap = new Map(cn.map((r) => [Number(r.invoiceId), num(r.amount)]));
  const alMap = new Map(al.map((r) => [Number(r.invoice_id), num(r.amount)]));
  return new Map(invoices.map((i) => {
    const total = round2(num(i.totalAmount)); const c = Math.min(round2(cnMap.get(Number(i.id)) || 0), total);
    const a = Math.min(round2(alMap.get(Number(i.id)) || 0), round2(total - c));
    return [Number(i.id), { total, creditNotes: c, allocated: a, open: round2(total - c - a) }];
  }));
}

// Keeps the invoice's own stored outstandingAmount (it existed but was never reduced) in line with its documents. Called after a
// payment is allocated and after a credit note is posted.
// invoice.status is deliberately NOT changed: the existing return / credit-note / debit-note flows only accept a POSTED invoice, so moving
// it to PARTIALLY_PAID / PAID here would block returns on a part-paid invoice. Payment state is derived instead (see paymentStatusOf).
async function refreshInvoiceBalance(invoiceId, transaction) {
  const inv = await db.SalesInvoiceHeader.findOne({ where: { id: invoiceId }, transaction });
  if (!inv || !LIVE_INVOICE.includes(inv.status)) return null;
  const { open } = (await openAmounts([inv], transaction)).get(Number(inv.id));
  await inv.update({ outstandingAmount: Math.max(0, open) }, { transaction });
  return inv;
}

const paymentStatusOf = ({ total, open, allocated }) => (open <= 0.005 ? "PAID" : allocated > 0 ? "PARTIALLY_PAID" : "UNPAID");

// ───────────────────────── create ─────────────────────────
function parseInput(body) {
  const b = body || {};
  const customerId = q.intId(b.customerId, "customerId");
  if (!customerId) throw bad("customerId (the retailer) is required");
  const amount = money(b.amount, "amount");

  const date = b.paymentDate;
  if (!date) throw bad("paymentDate is required");
  let paymentDate;
  try { paymentDate = q.day(date, "paymentDate"); } catch (e) { throw bad(e.message); }
  const maxDay = new Date(Date.now() + DAY).toISOString().slice(0, 10); // one day of slack for time zones ahead of UTC
  if (paymentDate < "2000-01-01") throw bad("paymentDate is not valid");
  if (paymentDate > maxDay) throw bad("paymentDate cannot be in the future");

  const mode = String(b.mode || "").toUpperCase();
  if (!db.PAYMENT_MODES.includes(mode)) throw bad(`mode must be one of ${db.PAYMENT_MODES.join(", ")}`);

  let reference = b.referenceNo === undefined || b.referenceNo === null ? "" : String(b.referenceNo).trim();
  if (!reference && REFERENCE_REQUIRED.includes(mode)) throw bad("A bank / UPI / cheque reference number is required for this payment mode");
  if (reference && !REFERENCE_RE.test(reference)) throw bad("referenceNo may contain letters, digits, spaces and . _ / # - (max 60 characters)");
  reference = reference || null;

  const remarks = b.remarks === undefined || b.remarks === null || String(b.remarks).trim() === "" ? null : String(b.remarks).trim();
  if (remarks && remarks.length > 500) throw bad("remarks is too long");

  let allocations = [];
  if (b.allocations !== undefined && b.allocations !== null) {
    if (!Array.isArray(b.allocations)) throw bad("allocations must be a list");
    if (b.allocations.length > 200) throw bad("Too many allocations");
    const seen = new Set();
    allocations = b.allocations.map((a, i) => {
      const invoiceId = q.intId(a && a.invoiceId, `allocations[${i}].invoiceId`);
      if (!invoiceId) throw bad(`allocations[${i}].invoiceId is required`);
      if (seen.has(invoiceId)) throw bad("An invoice can appear only once in the allocations");
      seen.add(invoiceId);
      return { invoiceId, amount: money(a.amount, `allocations[${i}].amount`) };
    });
  }
  const autoAllocate = b.autoAllocate === true;
  if (autoAllocate && allocations.length) throw bad("Use either allocations or autoAllocate, not both");
  return { customerId, requestedDistributorId: q.intId(b.distributorId, "distributorId"), amount, paymentDate, mode, reference, remarks, allocations, autoAllocate };
}

async function createPayment(adminId, body) {
  const input = parseInput(body);
  const t = await db.sequelize.transaction();
  try {
    // The tenant is derived from the retailer — a distributorId in the body is only ever cross-checked, never trusted.
    const customer = await db.Customer.findOne({ where: { id: input.customerId }, transaction: t });
    if (!customer) throw new PaymentError(404, "RETAILER_NOT_FOUND", "Retailer not found");
    if (input.requestedDistributorId && input.requestedDistributorId !== Number(customer.distributor_id)) throw new PaymentError(400, "RETAILER_DISTRIBUTOR_MISMATCH", "This retailer does not belong to the selected distributor");
    const distributor = await db.Distributor.findOne({ where: { id: customer.distributor_id }, attributes: ["id", "distributor_code", "name"], transaction: t });
    if (!distributor || !distributor.distributor_code) throw new PaymentError(404, "DISTRIBUTOR_NOT_FOUND", "The retailer's distributor could not be found");

    if (input.reference) {
      const dup = await db.Payment.findOne({ where: { distributor_id: distributor.id, reference_no: input.reference }, attributes: ["id", "payment_number"], transaction: t });
      if (dup) throw new PaymentError(409, "DUPLICATE_REFERENCE", `Reference ${input.reference} is already recorded on payment ${dup.payment_number}`);
    }

    // Lock the retailer's live invoices so two concurrent payments cannot both consume the same open amount.
    const invoices = await db.SalesInvoiceHeader.findAll({ where: { customer_id: customer.id, distributor_id: distributor.id, status: { [Op.in]: LIVE_INVOICE } }, transaction: t, lock: t.LOCK.UPDATE });
    const open = await openAmounts(invoices, t);
    const byId = new Map(invoices.map((i) => [Number(i.id), i]));

    let allocations = input.allocations;
    if (input.autoAllocate) {
      let left = input.amount;
      const dueKey = (i) => (i.dueDate ? new Date(i.dueDate).getTime() : new Date(i.invoiceDate).getTime());
      allocations = [];
      for (const inv of invoices.filter((i) => OPEN_INVOICE.includes(i.status)).sort((a, b) => dueKey(a) - dueKey(b) || a.id - b.id)) {
        const room = open.get(Number(inv.id)).open;
        if (room <= 0.005 || left <= 0.005) continue;
        const take = round2(Math.min(room, left));
        allocations.push({ invoiceId: Number(inv.id), amount: take });
        left = round2(left - take);
      }
    }

    let allocated = 0;
    for (const a of allocations) {
      const inv = byId.get(a.invoiceId);
      if (!inv) throw new PaymentError(400, "INVALID_INVOICE", `Invoice ${a.invoiceId} was not found for this retailer`);
      if (!OPEN_INVOICE.includes(inv.status)) throw new PaymentError(400, "INVALID_INVOICE", `Invoice ${inv.invoice_number || inv.id} is already fully paid`);
      const room = open.get(Number(inv.id)).open;
      if (room <= 0.005) throw new PaymentError(400, "INVALID_INVOICE", `Invoice ${inv.invoice_number || inv.id} has nothing outstanding`);
      if (a.amount > room + 0.005) throw new PaymentError(422, "EXCEEDS_OUTSTANDING", `Allocation to invoice ${inv.invoice_number || inv.id} (${a.amount.toFixed(2)}) exceeds its outstanding amount (${room.toFixed(2)})`);
      allocated = round2(allocated + a.amount);
    }
    if (allocated > input.amount + 0.005) throw new PaymentError(422, "ALLOCATION_EXCEEDS_PAYMENT", `Allocations (${allocated.toFixed(2)}) exceed the payment amount (${input.amount.toFixed(2)})`);

    const payment = await db.Payment.create({
      payment_number: `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, distributor_id: distributor.id, customer_id: customer.id,
      payment_date: input.paymentDate, amount: input.amount, mode: input.mode, reference_no: input.reference, remarks: input.remarks, status: "POSTED", created_by_admin_id: adminId || null,
    }, { transaction: t });
    const number = `PAY${String(payment.id).padStart(8, "0")}`;
    await payment.update({ payment_number: number }, { transaction: t });

    for (const a of allocations) await db.PaymentAllocation.create({ payment_id: payment.id, invoice_id: a.invoiceId, amount: a.amount }, { transaction: t });

    const cashBankGL = await accounting.getGL(ACCOUNTS.CASH_BANK, distributor.distributor_code, t);
    const receivableGL = await accounting.getGL(ACCOUNTS.RECEIVABLE, distributor.distributor_code, t);
    const transaction_date = new Date(`${input.paymentDate}T00:00:00.000Z`);
    const base = { distributor_code: distributor.distributor_code, reference_type: "CUSTOMER_PAYMENT", reference_no: number, customer_id: customer.id, customer_code: customer.customer_code, transaction_date };
    const rows = [
      { ...base, gl_id: cashBankGL, debit: input.amount, credit: 0, narration: `Payment received (${input.mode})${input.reference ? ` ref ${input.reference}` : ""}` },
      { ...base, gl_id: receivableGL, debit: 0, credit: input.amount, narration: `Customer balance reduced — ${number}` },
    ];
    accounting.assertBalanced(rows);
    await db.JournalEntry.bulkCreate(rows, { transaction: t });

    for (const a of allocations) await refreshInvoiceBalance(a.invoiceId, t);

    await t.commit();
    return getPayment({ role: "admin" }, payment.id);
  } catch (err) {
    await t.rollback();
    if (err instanceof UniqueConstraintError) throw new PaymentError(409, "DUPLICATE_REFERENCE", "This payment reference is already recorded");
    if (err instanceof accounting.AccountingError) throw new PaymentError(err.statusCode, err.statusCode === 400 ? "GL_NOT_CONFIGURED" : "ACCOUNTING_FAILED", err.message);
    throw err;
  }
}

// ───────────────────────── read ─────────────────────────
async function shape(rows) {
  if (!rows.length) return [];
  const ids = rows.map((p) => Number(p.id));
  const [custs, dists, allocs, admins] = await Promise.all([
    db.Customer.findAll({ where: { id: { [Op.in]: [...new Set(rows.map((p) => Number(p.customer_id)))] } }, attributes: ["id", "name", "customer_code"], raw: true }),
    db.Distributor.findAll({ where: { id: { [Op.in]: [...new Set(rows.map((p) => Number(p.distributor_id)))] } }, attributes: ["id", "name", "distributor_code"], raw: true }),
    db.PaymentAllocation.findAll({ where: { payment_id: { [Op.in]: ids } }, order: [["id", "ASC"]], raw: true }),
    db.AdminUser.findAll({ where: { id: { [Op.in]: [...new Set(rows.map((p) => p.created_by_admin_id).filter(Boolean))] } }, attributes: ["id", "name"], raw: true }),
  ]);
  const invs = allocs.length ? await db.SalesInvoiceHeader.findAll({ where: { id: { [Op.in]: [...new Set(allocs.map((a) => Number(a.invoice_id)))] } }, attributes: ["id", "invoice_number"], raw: true }) : [];
  const cm = new Map(custs.map((c) => [Number(c.id), c])); const dm = new Map(dists.map((d) => [Number(d.id), d]));
  const am = new Map(admins.map((a) => [Number(a.id), a.name])); const im = new Map(invs.map((i) => [Number(i.id), i.invoice_number]));
  return rows.map((p) => {
    const mine = allocs.filter((a) => Number(a.payment_id) === Number(p.id));
    const allocated = round2(mine.reduce((t, a) => t + num(a.amount), 0));
    const c = cm.get(Number(p.customer_id)); const d = dm.get(Number(p.distributor_id));
    return {
      id: Number(p.id), number: p.payment_number, date: p.payment_date, amount: num(p.amount), mode: p.mode, referenceNo: p.reference_no || null, remarks: p.remarks || null, status: p.status,
      retailer: c ? { id: Number(c.id), name: c.name, code: c.customer_code } : null, distributor: d ? { id: Number(d.id), name: d.name, code: d.distributor_code } : null,
      allocatedAmount: allocated, unallocatedAmount: round2(num(p.amount) - allocated),
      allocations: mine.map((a) => ({ invoiceId: Number(a.invoice_id), invoiceNumber: im.get(Number(a.invoice_id)) || null, amount: num(a.amount) })),
      createdBy: p.created_by_admin_id ? { id: Number(p.created_by_admin_id), name: am.get(Number(p.created_by_admin_id)) || "Admin" } : null, createdAt: p.createdAt,
    };
  });
}

async function listPayments(scope, query = {}) {
  const where = {};
  if (scope.role === "distributor") where.distributor_id = Number(scope.distributorId);
  else { const d = q.intId(query.distributorId, "distributorId"); if (d) where.distributor_id = d; }
  const retailerId = q.intId(query.retailerId, "retailerId"); if (retailerId) where.customer_id = retailerId;
  const mode = q.oneOf(query.mode, db.PAYMENT_MODES, "mode", (s) => s.toUpperCase()); if (mode) where.mode = mode;
  const from = q.day(query.from, "from"); const to = q.day(query.to, "to");
  if (from && to && from > to) throw new QueryError("from must not be after to");
  if (from || to) where.payment_date = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  const search = q.text(query.search, "search", 100);
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
    const cs = await db.Customer.findAll({ where: { name: { [Op.like]: like } }, attributes: ["id"], raw: true, limit: 500 });
    where[Op.or] = [{ payment_number: { [Op.like]: like } }, { reference_no: { [Op.like]: like } }, ...(cs.length ? [{ customer_id: { [Op.in]: cs.map((c) => Number(c.id)) } }] : [])];
  }
  const page = Math.max(1, q.intId(query.page, "page") || 1); const pageSize = Math.min(100, Math.max(1, q.intId(query.pageSize, "pageSize") || 25));
  const sortCol = { date: "payment_date", amount: "amount", number: "payment_number" }[query.sort] || "payment_date";
  const dir = String(query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const { rows, count } = await db.Payment.findAndCountAll({ where, order: [[sortCol, dir], ["id", "DESC"]], limit: pageSize, offset: (page - 1) * pageSize });
  const total = await db.Payment.sum("amount", { where });
  return { items: await shape(rows), total: count, page, pageSize, totalAmount: round2(num(total)) };
}

async function getPayment(scope, rawId) {
  const id = q.intId(rawId, "id");
  if (!id) throw new QueryError("id is required");
  const where = { id };
  if (scope.role === "distributor") where.distributor_id = Number(scope.distributorId); // another distributor's payment does not exist
  const p = await db.Payment.findOne({ where });
  return p ? (await shape([p]))[0] : null;
}

// Open invoices of a retailer (for the allocation form). Same scoping rules as everything else.
async function openInvoices(scope, rawCustomerId) {
  const customerId = q.intId(rawCustomerId, "retailerId");
  if (!customerId) throw new QueryError("retailerId is required");
  const c = await db.Customer.findOne({ where: { id: customerId, ...(scope.role === "distributor" ? { distributor_id: scope.distributorId } : {}) }, attributes: ["id", "name", "distributor_id"], raw: true });
  if (!c) return null;
  const invoices = await db.SalesInvoiceHeader.findAll({ where: { customer_id: c.id, distributor_id: c.distributor_id, status: { [Op.in]: OPEN_INVOICE } }, order: [["dueDate", "ASC"], ["id", "ASC"]] });
  const open = await openAmounts(invoices);
  return invoices.map((i) => ({ id: Number(i.id), number: i.invoice_number, invoiceDate: i.invoiceDate, dueDate: i.dueDate, total: open.get(Number(i.id)).total, creditNotes: open.get(Number(i.id)).creditNotes, paid: open.get(Number(i.id)).allocated, open: open.get(Number(i.id)).open, paymentStatus: paymentStatusOf(open.get(Number(i.id))) })).filter((i) => i.open > 0.005);
}

module.exports = { paymentStatusOf, PaymentError, createPayment, listPayments, getPayment, openInvoices, refreshInvoiceBalance, openAmounts };
