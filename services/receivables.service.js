// services/receivables.service.js — Phase 12 Accounts Receivable READ model (outstanding, ageing, ledger, summary, credit).
//
// This is NOT a second accounting engine. Every figure is derived from documents that already exist:
//   • invoices        → SalesInvoiceHeader (POSTED / PARTIALLY_PAID / PAID), due date = invoice.dueDate (set at posting from payment terms)
//   • credit notes    → SalesCreditNote with status POSTED (return-generated notes included)
//   • payments        → PaymentAllocation rows (invoice-level) and CUSTOMER_PAYMENT journal rows (all payments, incl. legacy)
//   • the ledger      → JournalEntry rows on the "Accounts Receivable" GL (the same definition of "outstanding" the Admin dashboard and
//                       the Distributor detail screen already use: AR debit − AR credit)
//
// Per retailer (Customer):
//   invoice open  = invoice total − posted credit notes − payments allocated to it
//   residual      = Σ invoice open − AR ledger balance
//                   > 0  → credits that are not tied to an invoice (legacy /payment/receive receipts, the unallocated part of a payment)
//                          They are applied to the oldest-due invoices first (FIFO) so ageing/overdue agree with the ledger; any excess is "advance".
//                   < 0  → debits not tied to an invoice (debit notes). Shown as "other charges" and counted in outstanding.
//   outstanding   = Σ invoice open after FIFO (+ other charges)          ledger balance = outstanding − advance
//
// A scheme-claim settlement is a different counterparty (the company owes the distributor), lives in its own GL accounts and is
// deliberately never netted against retailer outstanding — it is reported alongside (claimSettled).
const { Op, fn, col } = require("sequelize");
const db = require("../models");
const accounting = require("./accounting.service");
const { QueryError } = require("./salesQuery");
const q = require("./salesQuery");

const { ACCOUNTS, round2, parsePaymentTermsToDays } = accounting;
const LIVE_INVOICE = ["POSTED", "PARTIALLY_PAID", "PAID"];
const DAY = 86400000;
const EPS = 0.005;

const BUCKETS = [
  { key: "NOT_DUE", label: "Current / Not due", min: -Infinity, max: 0 },
  { key: "D1_30", label: "1–30 days", min: 1, max: 30 },
  { key: "D31_60", label: "31–60 days", min: 31, max: 60 },
  { key: "D61_90", label: "61–90 days", min: 61, max: 90 },
  { key: "D91_180", label: "91–180 days", min: 91, max: 180 },
  { key: "D180_PLUS", label: "180+ days", min: 181, max: Infinity },
];
const bucketFor = (daysPastDue) => BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const dayStr = (d) => new Date(d).toISOString().slice(0, 10);
const todayStr = () => dayStr(new Date());
const dayNumber = (s) => Math.floor(new Date(`${s}T00:00:00.000Z`).getTime() / DAY);

// ───────────────────────── scope ─────────────────────────
// Distributor scope always comes from the token; an admin may narrow to one distributor. Anything a distributor puts in the query
// string about another distributor is ignored, and an entity of another distributor is simply "not found".
function scopeDistributorId(scope, requested) {
  if (scope.role === "distributor") return Number(scope.distributorId);
  return requested || null;
}

// ───────────────────────── core load ─────────────────────────
async function loadBooks(scope, { distributorId: reqDist = null, customerId = null, asOf = null } = {}) {
  const distributorId = scopeDistributorId(scope, reqDist);
  const today = asOf || todayStr();

  const invWhere = { status: { [Op.in]: LIVE_INVOICE } };
  if (distributorId) invWhere.distributor_id = distributorId;
  if (customerId) invWhere.customer_id = customerId;
  const invoices = await db.SalesInvoiceHeader.findAll({
    where: invWhere,
    attributes: ["id", "invoice_number", "invoiceDate", "dueDate", "paymentTerms", "totalAmount", "status", "customer_id", "distributor_id"],
    raw: true,
  });

  const cnWhere = { status: "POSTED" };
  if (distributorId) cnWhere.distributor_id = distributorId;
  const creditNotes = await db.SalesCreditNote.findAll({ where: cnWhere, attributes: ["invoiceId", [fn("SUM", col("totalAmount")), "amount"]], group: ["invoiceId"], raw: true });
  const cnMap = new Map(creditNotes.map((r) => [Number(r.invoiceId), num(r.amount)]));

  const allocRows = await db.PaymentAllocation.findAll({
    attributes: ["invoice_id", [fn("SUM", col("PaymentAllocation.amount")), "amount"]],
    include: [{ model: db.Payment, as: "payment", attributes: [], required: true, where: distributorId ? { distributor_id: distributorId } : {} }],
    group: ["invoice_id"],
    raw: true,
  });
  const allocMap = new Map(allocRows.map((r) => [Number(r.invoice_id), num(r.amount)]));

  // AR ledger totals per customer (and per document type, for the "payments received" figure)
  const jWhere = { customer_id: customerId ? customerId : { [Op.ne]: null } };
  if (distributorId) {
    const d = await db.Distributor.findOne({ where: { id: distributorId }, attributes: ["distributor_code"], raw: true });
    jWhere.distributor_code = d ? d.distributor_code : "__none__";
  }
  const ledgerRows = await db.JournalEntry.findAll({
    attributes: ["customer_id", "reference_type", [fn("SUM", col("debit")), "debit"], [fn("SUM", col("credit")), "credit"]],
    include: [{ model: db.GLMaster, as: "gl", attributes: [], required: true, where: { gl_name: ACCOUNTS.RECEIVABLE } }],
    where: jWhere,
    group: ["customer_id", "reference_type"],
    raw: true,
  });
  const ledgerBy = new Map();
  for (const r of ledgerRows) {
    const id = Number(r.customer_id);
    const e = ledgerBy.get(id) || { debit: 0, credit: 0, payments: 0 };
    e.debit += num(r.debit);
    e.credit += num(r.credit);
    if (r.reference_type === "CUSTOMER_PAYMENT") e.payments += num(r.credit);
    ledgerBy.set(id, e);
  }

  const ids = new Set([...invoices.map((i) => Number(i.customer_id)), ...ledgerBy.keys()]);
  if (!ids.size) return { today, distributorId, books: [], distributors: new Map() };
  const customers = await db.Customer.findAll({ where: { id: { [Op.in]: [...ids] }, ...(distributorId ? { distributor_id: distributorId } : {}) }, attributes: ["id", "name", "customer_code", "distributor_id", "credit_limit", "status"], raw: true });
  const dists = await db.Distributor.findAll({ where: { id: { [Op.in]: [...new Set(customers.map((c) => Number(c.distributor_id)))] } }, attributes: ["id", "name", "distributor_code", "credit_limit", "payment_terms", "status"], raw: true });
  const distMap = new Map(dists.map((d) => [Number(d.id), d]));

  const byCustomer = new Map();
  for (const inv of invoices) {
    const k = Number(inv.customer_id);
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(inv);
  }

  const books = customers.map((c) => {
    const dist = distMap.get(Number(c.distributor_id));
    const ledger = ledgerBy.get(Number(c.id)) || { debit: 0, credit: 0, payments: 0 };
    return computeBook({ customer: c, distributor: dist, invoices: byCustomer.get(Number(c.id)) || [], cnMap, allocMap, ledger, today });
  });
  return { today, distributorId, books, distributors: distMap };
}

// Pure: one retailer's invoice-level and ledger-level position.
function computeBook({ customer, distributor, invoices, cnMap, allocMap, ledger, today }) {
  const todayNo = dayNumber(today);
  const rows = invoices
    .map((inv) => {
      const total = round2(num(inv.totalAmount));
      const cn = Math.min(round2(cnMap.get(Number(inv.id)) || 0), total);
      const alloc = Math.min(round2(allocMap.get(Number(inv.id)) || 0), round2(total - cn));
      let due = inv.dueDate ? dayStr(inv.dueDate) : null;
      if (!due) { const d = new Date(inv.invoiceDate); d.setUTCDate(d.getUTCDate() + parsePaymentTermsToDays(inv.paymentTerms || (distributor && distributor.payment_terms))); due = dayStr(d); }
      return { id: Number(inv.id), number: inv.invoice_number, invoiceDate: dayStr(inv.invoiceDate), dueDate: due, total, creditNotes: cn, allocated: alloc, openStrict: round2(total - cn - alloc), unappliedPaid: 0 };
    })
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id));

  const sumOpen = round2(rows.reduce((t, r) => t + r.openStrict, 0));
  const ledgerBalance = round2(ledger.debit - ledger.credit);
  const residual = round2(sumOpen - ledgerBalance);
  let remaining = residual > 0 ? residual : 0;
  const otherCharges = residual < 0 ? round2(-residual) : 0;
  for (const r of rows) {
    const take = Math.min(remaining, r.openStrict);
    r.unappliedPaid = round2(take);
    remaining = round2(remaining - take);
    r.open = round2(r.openStrict - r.unappliedPaid);
    r.paid = round2(r.allocated + r.unappliedPaid);
    r.daysPastDue = todayNo - dayNumber(r.dueDate);
    r.overdue = r.open > EPS && r.daysPastDue > 0;
    r.bucket = bucketFor(r.daysPastDue).key;
  }
  return { customer, distributor, invoices: rows, advance: round2(remaining), otherCharges, ledgerBalance, ledgerPayments: round2(ledger.payments) };
}

// A book restricted to an invoice-date window (display filter only — FIFO is always computed over the full history).
function windowed(book, from, to) {
  const inv = book.invoices.filter((i) => (!from || i.invoiceDate >= from) && (!to || i.invoiceDate <= to));
  return { ...book, invoices: inv, partial: Boolean(from || to) };
}

function summarize(book) {
  const open = book.invoices.filter((i) => i.open > EPS);
  const overdueInv = open.filter((i) => i.overdue);
  const outstanding = round2(book.invoices.reduce((t, i) => t + i.open, 0) + (book.partial ? 0 : book.otherCharges));
  const worst = overdueInv.length ? overdueInv.reduce((m, i) => (i.daysPastDue > m.daysPastDue ? i : m)) : null;
  const nextDue = open.filter((i) => !i.overdue).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0] || null;
  const oldestOpen = open.length ? open[0] : null; // rows are sorted by due date
  return {
    invoiceCount: book.invoices.length,
    invoiceAmount: round2(book.invoices.reduce((t, i) => t + i.total, 0)),
    paymentsReceived: round2(book.invoices.reduce((t, i) => t + i.paid, 0)),
    creditNotes: round2(book.invoices.reduce((t, i) => t + i.creditNotes, 0)),
    outstanding,
    overdue: round2(overdueInv.reduce((t, i) => t + i.open, 0)),
    openInvoiceCount: open.length,
    dueDate: worst ? worst.dueDate : nextDue ? nextDue.dueDate : oldestOpen ? oldestOpen.dueDate : null,
    ageingBucket: open.length ? (worst ? bucketFor(worst.daysPastDue).key : "NOT_DUE") : null,
    advance: book.partial ? 0 : book.advance,
    otherCharges: book.partial ? 0 : book.otherCharges,
    ledgerBalance: book.ledgerBalance,
  };
}

// Settled claims per distributor / retailer (informational — never netted into outstanding)
async function claimSettledMaps(distributorId) {
  const where = { settled_at: { [Op.ne]: null }, status: "APPROVED" };
  if (distributorId) where.distributor_id = distributorId;
  const rows = await db.Claim.findAll({ where, attributes: ["distributor_id", "customer_id", "claim_amount"], raw: true });
  const byDist = new Map(); const byCust = new Map();
  for (const r of rows) {
    byDist.set(Number(r.distributor_id), round2((byDist.get(Number(r.distributor_id)) || 0) + num(r.claim_amount)));
    if (r.customer_id) byCust.set(Number(r.customer_id), round2((byCust.get(Number(r.customer_id)) || 0) + num(r.claim_amount)));
  }
  return { byDist, byCust };
}

// ───────────────────────── outstanding ─────────────────────────
const SORTS = { name: "name", outstanding: "outstanding", overdue: "overdue", invoiceAmount: "invoiceAmount", invoiceCount: "invoiceCount", dueDate: "dueDate", paymentsReceived: "paymentsReceived" };

function parsePaging(query) {
  const page = Math.max(1, q.intId(query.page, "page") || 1);
  const pageSize = Math.min(100, Math.max(1, q.intId(query.pageSize, "pageSize") || 25));
  return { page, pageSize };
}

async function outstandingList(scope, query = {}) {
  const from = q.day(query.from, "from"); const to = q.day(query.to, "to");
  if (from && to && from > to) throw new QueryError("from must not be after to");
  const entityType = q.oneOf(query.entityType, ["RETAILER", "DISTRIBUTOR"], "entityType", (s) => s.toUpperCase());
  const status = q.oneOf(query.status, ["outstanding", "overdue"], "status", (s) => s.toLowerCase());
  const sortKey = SORTS[query.sort] || "outstanding";
  const dir = String(query.dir || "desc").toLowerCase() === "asc" ? 1 : -1;
  const search = (q.text(query.search, "search", 100) || "").toLowerCase();
  const { page, pageSize } = parsePaging(query);

  const { books, distributors } = await loadBooks(scope, { distributorId: q.intId(query.distributorId, "distributorId"), customerId: q.intId(query.retailerId, "retailerId") });
  const claims = await claimSettledMaps(scopeDistributorId(scope, q.intId(query.distributorId, "distributorId")));

  const retailerRows = books.map((b) => {
    const w = windowed(b, from, to);
    const s = summarize(w);
    return { key: `RETAILER:${b.customer.id}`, entityType: "RETAILER", entityId: Number(b.customer.id), name: b.customer.name, code: b.customer.customer_code, distributorId: Number(b.customer.distributor_id), distributorName: b.distributor ? b.distributor.name : null, ...s, claimSettled: claims.byCust.get(Number(b.customer.id)) || 0, _w: w };
  }).filter((r) => (from || to ? r.invoiceCount > 0 : r.invoiceCount > 0 || Math.abs(r.ledgerBalance) > EPS || r.advance > EPS)); // with a date window only retailers invoiced in it

  const distRows = [];
  for (const [id, d] of distributors) {
    const mine = retailerRows.filter((r) => r.distributorId === Number(id));
    if (!mine.length) continue;
    const all = mine.flatMap((r) => r._w.invoices.filter((i) => i.open > EPS));
    const overdueInv = all.filter((i) => i.overdue);
    const worst = overdueInv.length ? overdueInv.reduce((m, i) => (i.daysPastDue > m.daysPastDue ? i : m)) : null;
    const sum = (k) => round2(mine.reduce((t, r) => t + r[k], 0));
    distRows.push({
      key: `DISTRIBUTOR:${id}`, entityType: "DISTRIBUTOR", entityId: Number(id), name: d.name, code: d.distributor_code, distributorId: Number(id), distributorName: d.name,
      invoiceCount: sum("invoiceCount"), invoiceAmount: sum("invoiceAmount"), paymentsReceived: sum("paymentsReceived"), creditNotes: sum("creditNotes"),
      outstanding: sum("outstanding"), overdue: sum("overdue"), openInvoiceCount: sum("openInvoiceCount"), advance: sum("advance"), otherCharges: sum("otherCharges"), ledgerBalance: sum("ledgerBalance"),
      dueDate: worst ? worst.dueDate : (all.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0] || {}).dueDate || null,
      ageingBucket: all.length ? (worst ? bucketFor(worst.daysPastDue).key : "NOT_DUE") : null,
      claimSettled: claims.byDist.get(Number(id)) || 0, retailerCount: mine.length,
    });
  }

  let rows = [...(entityType === "DISTRIBUTOR" ? [] : retailerRows), ...(entityType === "RETAILER" ? [] : distRows)];
  if (search) rows = rows.filter((r) => `${r.name} ${r.code} ${r.distributorName}`.toLowerCase().includes(search));
  if (status === "outstanding") rows = rows.filter((r) => r.outstanding > EPS);
  if (status === "overdue") rows = rows.filter((r) => r.overdue > EPS);

  const totals = {
    invoiceAmount: round2(rows.filter((r) => r.entityType === "RETAILER").reduce((t, r) => t + r.invoiceAmount, 0)),
    outstanding: round2(rows.filter((r) => r.entityType === "RETAILER").reduce((t, r) => t + r.outstanding, 0)),
    overdue: round2(rows.filter((r) => r.entityType === "RETAILER").reduce((t, r) => t + r.overdue, 0)),
  };
  rows.sort((a, b) => {
    const x = a[sortKey]; const y = b[sortKey];
    if (x === y) return a.key < b.key ? -1 : 1;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const total = rows.length;
  const items = rows.slice((page - 1) * pageSize, page * pageSize).map(({ _w, ...r }) => r);
  return { items, total, page, pageSize, totals, bucketLabels: Object.fromEntries(BUCKETS.map((b) => [b.key, b.label])) };
}

// ───────────────────────── ageing ─────────────────────────
async function ageing(scope, query = {}) {
  const asOf = q.day(query.asOf, "asOf") || undefined;
  const entityType = q.oneOf(query.entityType, ["RETAILER", "DISTRIBUTOR"], "entityType", (s) => s.toUpperCase()) || "RETAILER";
  const { books, distributors, today } = await loadBooks(scope, { distributorId: q.intId(query.distributorId, "distributorId"), customerId: q.intId(query.retailerId, "retailerId"), asOf });
  const search = (q.text(query.search, "search", 100) || "").toLowerCase();
  const { page, pageSize } = parsePaging(query);

  const empty = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  const group = new Map();
  for (const b of books) {
    const gid = entityType === "DISTRIBUTOR" ? Number(b.customer.distributor_id) : Number(b.customer.id);
    if (!group.has(gid)) {
      const d = distributors.get(Number(b.customer.distributor_id));
      group.set(gid, entityType === "DISTRIBUTOR"
        ? { entityType, entityId: gid, name: d ? d.name : `#${gid}`, code: d ? d.distributor_code : null, distributorName: d ? d.name : null, buckets: empty(), invoiceCount: 0, outstanding: 0, overdue: 0, retailerCount: 0 }
        : { entityType, entityId: gid, name: b.customer.name, code: b.customer.customer_code, distributorName: d ? d.name : null, buckets: empty(), invoiceCount: 0, outstanding: 0, overdue: 0 });
    }
    const g = group.get(gid);
    if (g.retailerCount !== undefined) g.retailerCount += 1;
    for (const i of b.invoices) {
      if (i.open <= EPS) continue;
      g.buckets[i.bucket] = round2(g.buckets[i.bucket] + i.open);
      g.invoiceCount += 1;
      g.outstanding = round2(g.outstanding + i.open);
      if (i.overdue) g.overdue = round2(g.overdue + i.open);
    }
    if (b.otherCharges > EPS) { g.buckets.NOT_DUE = round2(g.buckets.NOT_DUE + b.otherCharges); g.outstanding = round2(g.outstanding + b.otherCharges); } // keeps the report equal to the ledger
  }
  let rows = [...group.values()].filter((g) => g.outstanding > EPS);
  for (const g of rows) {
    const worst = BUCKETS.slice().reverse().find((bk) => g.buckets[bk.key] > EPS);
    g.ageingBucket = worst ? worst.key : null;
  }
  if (search) rows = rows.filter((r) => `${r.name} ${r.code} ${r.distributorName}`.toLowerCase().includes(search));
  rows.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding || a.entityId - b.entityId);

  const totals = empty(); let outstanding = 0; let overdue = 0; let invoiceCount = 0;
  for (const r of rows) { for (const k of Object.keys(totals)) totals[k] = round2(totals[k] + r.buckets[k]); outstanding = round2(outstanding + r.outstanding); overdue = round2(overdue + r.overdue); invoiceCount += r.invoiceCount; }
  return { asOf: today, entityType, buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label })), totals: { buckets: totals, outstanding, overdue, invoiceCount }, items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
}

// ───────────────────────── ledger ─────────────────────────
const TYPE_LABEL = { SALES_INVOICE: "Invoice", CUSTOMER_PAYMENT: "Payment", SALES_CREDIT_NOTE: "Credit Note", SALES_DEBIT_NOTE: "Debit Note", CLAIM_SETTLEMENT: "Claim settlement" };

async function ledger(scope, query = {}) {
  const entityType = q.oneOf(query.entityType, ["RETAILER", "DISTRIBUTOR"], "entityType", (s) => s.toUpperCase()) || "RETAILER";
  const account = q.oneOf(query.account, ["RECEIVABLE", "CLAIMS"], "account", (s) => s.toUpperCase()) || "RECEIVABLE";
  const entityId = q.intId(scope.role === "distributor" && entityType === "DISTRIBUTOR" && !query.entityId ? scope.distributorId : query.entityId, "entityId");
  if (!entityId) throw new QueryError("entityId is required");
  if (account === "CLAIMS" && entityType !== "DISTRIBUTOR") throw new QueryError("The claims account is only kept per distributor");
  const from = q.day(query.from, "from"); const to = q.day(query.to, "to");
  if (from && to && from > to) throw new QueryError("from must not be after to");
  const { page, pageSize } = (() => { const p = Math.max(1, q.intId(query.page, "page") || 1); const s = Math.min(200, Math.max(1, q.intId(query.pageSize, "pageSize") || 50)); return { page: p, pageSize: s }; })();

  // Resolve the entity under the caller's scope — outside it the entity does not exist.
  let customer = null; let distributor;
  if (entityType === "RETAILER") {
    customer = await db.Customer.findOne({ where: { id: entityId, ...(scope.role === "distributor" ? { distributor_id: scope.distributorId } : {}) }, attributes: ["id", "name", "customer_code", "distributor_id"], raw: true });
    if (!customer) return null;
    distributor = await db.Distributor.findOne({ where: { id: customer.distributor_id }, attributes: ["id", "name", "distributor_code"], raw: true });
  } else {
    if (scope.role === "distributor" && Number(entityId) !== Number(scope.distributorId)) return null;
    distributor = await db.Distributor.findOne({ where: { id: entityId }, attributes: ["id", "name", "distributor_code"], raw: true });
  }
  if (!distributor) return null;

  const glName = account === "CLAIMS" ? ACCOUNTS.SCHEME_CLAIM_RECEIVABLE : ACCOUNTS.RECEIVABLE;
  const base = { distributor_code: distributor.distributor_code };
  if (account === "RECEIVABLE") base.customer_id = customer ? customer.id : { [Op.ne]: null };
  const include = [{ model: db.GLMaster, as: "gl", attributes: [], required: true, where: { gl_name: glName } }];

  const all = await db.JournalEntry.findAll({ where: base, include, attributes: ["id", "reference_type", "reference_no", "debit", "credit", "transaction_date", "customer_id", "narration"], order: [["transaction_date", "ASC"], ["id", "ASC"]], raw: true });

  const fromT = from ? new Date(`${from}T00:00:00.000Z`).getTime() : null;
  const toT = to ? new Date(`${to}T23:59:59.999Z`).getTime() : null;
  let opening = 0; const inRange = [];
  for (const e of all) {
    const t = e.transaction_date ? new Date(e.transaction_date).getTime() : 0;
    if (fromT !== null && t < fromT) { opening += num(e.debit) - num(e.credit); continue; }
    if (toT !== null && t > toT) continue;
    inRange.push(e);
  }
  opening = round2(opening);

  // Friendly references for the document ids the journal stores
  const ids = (type) => [...new Set(inRange.filter((e) => e.reference_type === type).map((e) => Number(e.reference_no)).filter(Number.isFinite))];
  const [invs, cns, custs] = await Promise.all([
    ids("SALES_INVOICE").length ? db.SalesInvoiceHeader.findAll({ where: { id: { [Op.in]: ids("SALES_INVOICE") } }, attributes: ["id", "invoice_number"], raw: true }) : [],
    ids("SALES_CREDIT_NOTE").length ? db.SalesCreditNote.findAll({ where: { id: { [Op.in]: ids("SALES_CREDIT_NOTE") } }, attributes: ["id", "credit_note_number", "sourceReturnId"], raw: true }) : [],
    entityType === "DISTRIBUTOR" && account === "RECEIVABLE" ? db.Customer.findAll({ where: { id: { [Op.in]: [...new Set(inRange.map((e) => Number(e.customer_id)).filter(Boolean))] } }, attributes: ["id", "name"], raw: true }) : [],
  ]);
  const invMap = new Map(invs.map((r) => [Number(r.id), r.invoice_number])); const cnMap = new Map(cns.map((r) => [Number(r.id), r]));
  const custMap = new Map(custs.map((r) => [Number(r.id), r.name]));

  let balance = opening;
  const entries = inRange.map((e) => {
    const debit = round2(num(e.debit)); const credit = round2(num(e.credit));
    balance = round2(balance + debit - credit);
    let type = TYPE_LABEL[e.reference_type] || e.reference_type || "Other"; let reference = e.reference_no;
    if (e.reference_type === "SALES_INVOICE") reference = invMap.get(Number(e.reference_no)) || `INV #${e.reference_no}`;
    if (e.reference_type === "SALES_CREDIT_NOTE") { const cn = cnMap.get(Number(e.reference_no)); reference = (cn && cn.credit_note_number) || `CN #${e.reference_no}`; if (cn && cn.sourceReturnId) type = "Return adjustment"; }
    return { id: Number(e.id), date: e.transaction_date, reference, type, typeCode: e.reference_type, debit, credit, balance, remarks: e.narration || null, retailer: e.customer_id ? custMap.get(Number(e.customer_id)) || null : null };
  });
  const totalDebit = round2(entries.reduce((t, e) => t + e.debit, 0)); const totalCredit = round2(entries.reduce((t, e) => t + e.credit, 0));
  return {
    entity: { type: entityType, id: Number(entityId), name: customer ? customer.name : distributor.name, code: customer ? customer.customer_code : distributor.distributor_code, distributorName: distributor.name },
    account, accountName: glName, openingBalance: opening, totalDebit, totalCredit, closingBalance: balance,
    entries: entries.slice((page - 1) * pageSize, page * pageSize), total: entries.length, page, pageSize,
  };
}

// ───────────────────────── summary ─────────────────────────
async function summary(scope) {
  const { books, distributors } = await loadBooks(scope, {});
  const distributorId = scopeDistributorId(scope, null);
  const sums = books.map((b) => ({ b, s: summarize(b) }));
  const totalReceivables = round2(sums.reduce((t, x) => t + x.s.ledgerBalance, 0));
  const overdueAmount = round2(sums.reduce((t, x) => t + x.s.overdue, 0));
  const advances = round2(sums.reduce((t, x) => t + x.s.advance, 0));

  // Collections: every CUSTOMER_PAYMENT credit on Accounts Receivable (new payments and legacy receipts alike)
  const now = new Date(); const today = todayStr(); const monthStart = `${today.slice(0, 7)}-01`;
  const tomorrow = new Date(new Date(`${today}T00:00:00.000Z`).getTime() + DAY);
  const jBase = { reference_type: "CUSTOMER_PAYMENT", customer_id: { [Op.ne]: null } };
  if (distributorId) { const d = await db.Distributor.findOne({ where: { id: distributorId }, attributes: ["distributor_code"], raw: true }); jBase.distributor_code = d ? d.distributor_code : "__none__"; }
  const collected = async (gte, lt) => {
    const [r] = await db.JournalEntry.findAll({ attributes: [[fn("SUM", col("credit")), "total"]], include: [{ model: db.GLMaster, as: "gl", attributes: [], required: true, where: { gl_name: ACCOUNTS.RECEIVABLE } }], where: { ...jBase, transaction_date: { [Op.gte]: gte, [Op.lt]: lt } }, raw: true });
    return round2(num(r && r.total));
  };
  const [todayCollections, monthCollections] = await Promise.all([collected(new Date(`${today}T00:00:00.000Z`), tomorrow), collected(new Date(`${monthStart}T00:00:00.000Z`), tomorrow)]);

  // Credit (distributor level): limit set vs. what its retailers owe
  const byDist = new Map();
  for (const x of sums) { const k = Number(x.b.customer.distributor_id); byDist.set(k, round2((byDist.get(k) || 0) + x.s.ledgerBalance)); }
  const allDist = await db.Distributor.findAll({ where: distributorId ? { id: distributorId } : {}, attributes: ["id", "credit_limit"], raw: true });
  let totalCreditLimit = 0; let utilisedOnLimited = 0;
  for (const d of allDist) { const lim = d.credit_limit === null || d.credit_limit === undefined ? null : num(d.credit_limit); if (lim && lim > 0) { totalCreditLimit = round2(totalCreditLimit + lim); utilisedOnLimited = round2(utilisedOnLimited + (byDist.get(Number(d.id)) || 0)); } }

  const cWhere = distributorId ? { distributor_id: distributorId } : {};
  const pending = await db.Claim.findAll({ where: { ...cWhere, status: "APPROVED", settled_at: null }, attributes: ["claim_amount"], raw: true });
  const settled = await db.Claim.findAll({ where: { ...cWhere, status: "APPROVED", settled_at: { [Op.ne]: null } }, attributes: ["claim_amount"], raw: true });

  return {
    asOf: now.toISOString(), hasData: books.length > 0,
    totalReceivables, retailerOutstanding: round2(sums.reduce((t, x) => t + x.s.outstanding, 0)), distributorsWithOutstanding: [...byDist.values()].filter((v) => v > EPS).length,
    overdueAmount, unappliedAdvances: advances, todayCollections, monthCollections,
    totalCreditLimit, creditUtilised: utilisedOnLimited, creditUtilisationPct: totalCreditLimit > 0 ? round2((utilisedOnLimited / totalCreditLimit) * 100) : null,
    claimsPendingSettlement: { count: pending.length, amount: round2(pending.reduce((t, r) => t + num(r.claim_amount), 0)) },
    claimsSettled: { count: settled.length, amount: round2(settled.reduce((t, r) => t + num(r.claim_amount), 0)) },
    distributorCount: distributors.size,
  };
}

// ───────────────────────── credit ─────────────────────────
async function creditList(scope, query = {}) {
  const entityType = q.oneOf(query.entityType, ["RETAILER", "DISTRIBUTOR"], "entityType", (s) => s.toUpperCase());
  const search = (q.text(query.search, "search", 100) || "").toLowerCase();
  const { page, pageSize } = parsePaging(query);
  const distributorId = scopeDistributorId(scope, q.intId(query.distributorId, "distributorId"));

  const { books } = await loadBooks(scope, { distributorId });
  const balanceOf = new Map(books.map((b) => [Number(b.customer.id), b.ledgerBalance]));
  const byDist = new Map();
  for (const b of books) byDist.set(Number(b.customer.distributor_id), round2((byDist.get(Number(b.customer.distributor_id)) || 0) + b.ledgerBalance));

  const shape = (type, id, name, code, distributorName, distributorIdOf, limitRaw, utilised, extra = {}) => {
    const limit = limitRaw === null || limitRaw === undefined ? null : round2(num(limitRaw));
    return { key: `${type}:${id}`, entityType: type, entityId: Number(id), name, code, distributorId: distributorIdOf, distributorName, creditLimit: limit, utilised: round2(utilised), availableCredit: limit === null ? null : round2(limit - utilised), utilisationPct: limit ? round2((utilised / limit) * 100) : null, overLimit: limit !== null && utilised > limit + EPS, ...extra };
  };
  let rows = [];
  if (entityType !== "RETAILER") {
    const ds = await db.Distributor.findAll({ where: distributorId ? { id: distributorId } : {}, attributes: ["id", "name", "distributor_code", "credit_limit", "payment_terms"], raw: true });
    rows.push(...ds.map((d) => shape("DISTRIBUTOR", d.id, d.name, d.distributor_code, d.name, Number(d.id), d.credit_limit, byDist.get(Number(d.id)) || 0, { paymentTerms: d.payment_terms || null })));
  }
  if (entityType !== "DISTRIBUTOR") {
    const cs = await db.Customer.findAll({ where: distributorId ? { distributor_id: distributorId } : {}, attributes: ["id", "name", "customer_code", "distributor_id", "credit_limit"], raw: true });
    const dn = new Map((await db.Distributor.findAll({ attributes: ["id", "name"], where: distributorId ? { id: distributorId } : {}, raw: true })).map((d) => [Number(d.id), d.name]));
    rows.push(...cs.map((c) => shape("RETAILER", c.id, c.name, c.customer_code, dn.get(Number(c.distributor_id)) || null, Number(c.distributor_id), c.credit_limit, balanceOf.get(Number(c.id)) || 0)));
  }
  if (search) rows = rows.filter((r) => `${r.name} ${r.code} ${r.distributorName}`.toLowerCase().includes(search));
  rows.sort((a, b) => (a.entityType === b.entityType ? 0 : a.entityType === "DISTRIBUTOR" ? -1 : 1) || b.utilised - a.utilised || a.entityId - b.entityId);
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, enforced: false };
}

// Admin only (the controller is behind requireAdmin; this re-checks). Updates the EXISTING Distributors.credit_limit or the new Customers.credit_limit.
async function updateCredit(scope, rawId, body = {}) {
  if (!scope || scope.role !== "admin") throw new accounting.AccountingError("Only an administrator can change a credit limit", 403);
  const id = q.intId(rawId, "entityId");
  if (!id) throw new QueryError("entityId is required");
  const entityType = String((body && body.entityType) || "").toUpperCase();
  if (!["RETAILER", "DISTRIBUTOR"].includes(entityType)) throw new QueryError("entityType must be RETAILER or DISTRIBUTOR");
  let limit = body.creditLimit;
  if (limit === "" || limit === undefined) throw new QueryError("creditLimit is required (use null to clear it)");
  if (limit !== null) {
    const n = Number(limit);
    if (typeof limit === "boolean" || !Number.isFinite(n) || n < 0 || n >= 1e12) throw new QueryError("creditLimit must be a number from 0 to 999999999999.99");
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new QueryError("creditLimit can have at most 2 decimal places");
    limit = round2(n);
  }
  const Model = entityType === "DISTRIBUTOR" ? db.Distributor : db.Customer;
  const row = await Model.findOne({ where: { id } });
  if (!row) return null;
  await row.update({ credit_limit: limit });
  const out = await creditList(scope, { entityType, search: undefined, pageSize: 100, distributorId: entityType === "DISTRIBUTOR" ? row.id : row.distributor_id });
  return out.items.find((r) => r.entityType === entityType && r.entityId === Number(id)) || null;
}

// ───────────────────────── lookups ─────────────────────────
async function lookups(scope, query = {}) {
  const distributorId = scopeDistributorId(scope, q.intId(query.distributorId, "distributorId"));
  const distributors = scope.role === "admin" ? await db.Distributor.findAll({ attributes: ["id", "name", "distributor_code"], order: [["name", "ASC"]], raw: true }) : [];
  const retailers = await db.Customer.findAll({ where: distributorId ? { distributor_id: distributorId } : {}, attributes: ["id", "name", "customer_code", "distributor_id"], order: [["name", "ASC"]], limit: 1000, raw: true });
  return {
    distributors: distributors.map((d) => ({ id: Number(d.id), name: d.name, code: d.distributor_code })),
    retailers: retailers.map((r) => ({ id: Number(r.id), name: r.name, code: r.customer_code, distributorId: Number(r.distributor_id) })),
    paymentModes: db.PAYMENT_MODES, ageingBuckets: BUCKETS.map((b) => ({ key: b.key, label: b.label })),
  };
}

module.exports = { BUCKETS, bucketFor, computeBook, loadBooks, outstandingList, ageing, ledger, summary, creditList, updateCredit, lookups, scopeDistributorId, EPS };
