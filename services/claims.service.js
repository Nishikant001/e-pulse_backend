// services/claims.service.js — Phase 11 Claims Management (SCHEME claims only).
//
// A claim asks for compensation for a scheme benefit the Distributor already gave on a POSTED invoice. Benefit maths is NOT
// repeated here: eligibility and amounts come from the Phase 10 engine (schemeEngine.evaluate) evaluated at the invoice date.
//
//  • Ownership: every Distributor call is scoped by the authenticated distributor id passed in `scope`; bodies/queries are never read for it.
//  • Amount: calculated by the server from the engine result; the client cannot set it.
//  • State machine (backend-enforced, optimistic-locked):
//      DRAFT → SUBMITTED (distributor) · SUBMITTED|RESUBMITTED → UNDER_REVIEW (admin)
//      UNDER_REVIEW → APPROVED | REJECTED | NEEDS_CORRECTION (admin) · NEEDS_CORRECTION → RESUBMITTED (distributor)
//  • Duplicates: one invoice line can be claimed once per scheme across all claims that are not REJECTED.
//  • History is append-only (ClaimStatusHistory).
const q = require("./salesQuery");
const engine = require("./schemeEngine.service");
const schemesSvc = require("./schemes.service");
const { round2 } = require("./tax.service");
const accounting = require("./accounting.service"); // Phase 12: approving a claim now posts its financial settlement

class ClaimError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "ClaimError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new ClaimError(400, "VALIDATION_FAILED", message, details);

const STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "NEEDS_CORRECTION", "RESUBMITTED"];
const TRANSITIONS = {
  DRAFT: { SUBMITTED: "DISTRIBUTOR" },
  SUBMITTED: { UNDER_REVIEW: "ADMIN" },
  RESUBMITTED: { UNDER_REVIEW: "ADMIN" },
  UNDER_REVIEW: { APPROVED: "ADMIN", REJECTED: "ADMIN", NEEDS_CORRECTION: "ADMIN" },
  NEEDS_CORRECTION: { RESUBMITTED: "DISTRIBUTOR" },
  APPROVED: {},
  REJECTED: {},
};
const EDITABLE = ["DRAFT", "NEEDS_CORRECTION"];
const CLAIMABLE_INVOICE = ["POSTED", "PARTIALLY_PAID", "PAID"];
const LIVE = STATUSES.filter((s) => s !== "REJECTED"); // statuses that "use up" an invoice line

const isoDay = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const t = (m) => `\`${m.getTableName()}\``;
const run = (db, sql, r) => db.sequelize.query(sql, { replacements: r, type: db.Sequelize.QueryTypes.SELECT });
const cleanText = (v, name, max, { required = false, min = 0 } = {}) => {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (required && s.length < Math.max(min, 1)) throw bad(min > 1 ? `${name} is required (at least ${min} characters)` : `${name} is required`, { field: name });
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`, { field: name });
  return s || null;
};

// ───────────────────────── input ─────────────────────────
function parseInput(body) {
  if (!body || typeof body !== "object") throw bad("Request body is required");
  // distributor_id / customer_id / claim_amount / status in the body are deliberately never read.
  const invoiceId = q.intId(body.invoice_id, "invoice_id");
  const schemeId = q.intId(body.scheme_id, "scheme_id");
  if (!invoiceId) throw bad("Select an invoice", { field: "invoice_id" });
  if (!schemeId) throw bad("Select a scheme", { field: "scheme_id" });
  const from = q.day(body.period_from, "period_from");
  const to = q.day(body.period_to, "period_to");
  if (!from) throw bad("Period start is required", { field: "period_from" });
  if (!to) throw bad("Period end is required", { field: "period_to" });
  if (to < from) throw bad("Period end cannot be before period start", { field: "period_to" });
  if (!Array.isArray(body.items) || body.items.length === 0) throw bad("Add at least one invoice line", { field: "items" });
  if (body.items.length > 100) throw bad("At most 100 lines per claim", { field: "items" });
  const seen = new Set();
  const items = body.items.map((it, i) => {
    const lineId = q.intId(it && it.invoice_line_id, "invoice_line_id");
    const qty = Number(it && it.quantity);
    if (!lineId) throw bad(`Line ${i + 1}: choose an invoice line`, { field: "items" });
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) throw bad(`Line ${i + 1}: quantity must be a whole number above zero`, { field: "items" });
    if (seen.has(lineId)) throw bad(`Line ${i + 1}: the same invoice line is listed twice`, { field: "items" });
    seen.add(lineId);
    return { invoice_line_id: lineId, quantity: qty };
  });
  return { invoiceId, schemeId, from, to, items, description: cleanText(body.description, "description", 2000) };
}

// ───────────────────────── assessment (the only place claim eligibility is decided) ─────────────────────────
async function loadInvoice(db, distributorId, invoiceId, transaction) {
  const inv = await db.SalesInvoiceHeader.findOne({ where: { id: invoiceId, distributor_id: distributorId }, transaction });
  if (!inv) throw new ClaimError(400, "INVOICE_NOT_FOUND", "Invoice not found for this distributor", { field: "invoice_id" });
  if (!CLAIMABLE_INVOICE.includes(inv.status)) throw new ClaimError(400, "INVOICE_NOT_CLAIMABLE", `Only posted invoices can be claimed (this one is ${inv.status})`, { field: "invoice_id" });
  return inv;
}

/**
 * Evaluates a claim definition against the live engine, duplicates and period. Returns { items, issues, amount, scheme }.
 * `issues` empty ⇒ the claim is eligible. Hard structural errors (foreign invoice/line/scheme) throw.
 */
async function assess(db, { distributorId, invoice, schemeId, from, to, items, excludeClaimId = null, transaction }) {
  const scheme = await db.Scheme.findByPk(schemeId, { transaction });
  if (!scheme) throw new ClaimError(400, "SCHEME_NOT_FOUND", "Scheme not found", { field: "scheme_id" });
  const { Op } = db.Sequelize;
  const lines = await db.SalesInvoiceLine.findAll({ where: { id: { [Op.in]: items.map((i) => i.invoice_line_id) }, invoiceId: invoice.id }, transaction });
  const byId = new Map(lines.map((l) => [Number(l.id), l]));
  const issues = [];
  const invDay = isoDay(invoice.invoiceDate);
  if (invDay < from || invDay > to) issues.push({ code: "OUTSIDE_PERIOD", message: `The invoice date (${invDay}) is outside the claim period` });

  const rows = items.map((it) => {
    const line = byId.get(it.invoice_line_id);
    if (!line) throw new ClaimError(400, "LINE_NOT_ON_INVOICE", "An invoice line does not belong to the selected invoice", { field: "items" });
    if (it.quantity > Number(line.quantity)) throw bad(`Quantity ${it.quantity} exceeds the invoiced quantity ${line.quantity}`, { field: "items" });
    return { invoice_line_id: Number(line.id), product_id: Number(line.productId), quantity: it.quantity, unit_price: num(line.pricePerUnit), benefit_type: null, free_quantity: 0, eligible_amount: 0 };
  });

  // duplicates: same invoice line + same scheme in any other claim that is not REJECTED
  const dup = await db.ClaimItem.findAll({
    where: { invoice_line_id: { [Op.in]: rows.map((r) => r.invoice_line_id) } },
    transaction, raw: true,
  });
  if (dup.length) {
    const claims = await db.Claim.findAll({
      where: { id: { [Op.in]: [...new Set(dup.map((d) => d.claim_id))] }, scheme_id: schemeId, status: { [Op.in]: LIVE } },
      attributes: ["id", "claim_number", "status"], transaction,
    });
    const live = new Map(claims.map((c) => [Number(c.id), c]));
    for (const d of dup) {
      const c = live.get(Number(d.claim_id));
      if (c && Number(c.id) !== Number(excludeClaimId)) issues.push({ code: "DUPLICATE_CLAIM", invoice_line_id: Number(d.invoice_line_id), message: `Invoice line ${d.invoice_line_id} is already claimed under this scheme in ${c.claim_number} (${c.status})` });
    }
  }

  // eligibility + amount from the Phase 10 engine, evaluated at the invoice date for the invoice's retailer
  const ev = await engine.evaluate({
    distributorId, customerId: invoice.customer_id, asOf: invDay, transaction,
    lines: rows.map((r) => ({ productId: r.product_id, quantity: r.quantity, unitPrice: r.unit_price })),
  });
  ev.lines.forEach((r, i) => {
    const row = rows[i];
    if (r.errors.length) { issues.push({ code: r.errors[0].code, invoice_line_id: row.invoice_line_id, message: r.errors[0].message }); return; }
    if (r.conflict) { issues.push({ code: "SCHEME_CONFLICT", invoice_line_id: row.invoice_line_id, message: `Schemes ${r.conflictSchemes.map((c) => c.schemeCode).join(", ")} share the same priority on this product, so no scheme applied` }); return; }
    if (!r.applied) { issues.push({ code: "SCHEME_NOT_ELIGIBLE", invoice_line_id: row.invoice_line_id, message: `${scheme.scheme_code} was not applicable to this line on ${invDay} (inactive, outside validity, not applicable to the product/distributor/retailer, or quantity below the minimum)` }); return; }
    if (r.applied.schemeId !== Number(scheme.id)) { issues.push({ code: "OTHER_SCHEME_APPLIES", invoice_line_id: row.invoice_line_id, message: `${r.applied.schemeCode} (higher priority) applied to this line, not ${scheme.scheme_code}` }); return; }
    row.benefit_type = r.applied.benefitType;
    if (r.applied.benefitType === "FREE_QUANTITY") {
      row.free_quantity = r.applied.freeQuantity;
      row.eligible_amount = round2(r.applied.freeQuantity * (row.unit_price || 0));
    } else {
      row.eligible_amount = r.applied.discountAmount === null ? 0 : round2(r.applied.discountAmount);
    }
    if (row.eligible_amount <= 0 && row.free_quantity <= 0) issues.push({ code: "NO_BENEFIT", invoice_line_id: row.invoice_line_id, message: "The scheme gives no benefit on this line" });
  });

  const amount = round2(rows.reduce((s, r) => s + r.eligible_amount, 0));
  return { items: rows, issues, amount, scheme };
}

const snapshotOf = (s) => JSON.stringify({ code: s.scheme_code, name: s.name, type: s.scheme_type, ruleSummary: schemesSvc.ruleSummary(s), priority: s.priority, validFrom: isoDay(s.valid_from), validTo: isoDay(s.valid_to), capturedAt: new Date().toISOString() });

async function nextNumber(db, transaction) {
  const last = await db.Claim.findOne({ order: [["id", "DESC"]], attributes: ["id"], transaction });
  let n = last ? Number(last.id) + 1 : 1;
  for (let i = 0; i < 50; i += 1, n += 1) {
    const c = `CLM${new Date().getFullYear()}${String(n).padStart(6, "0")}`;
    if (!(await db.Claim.findOne({ where: { claim_number: c }, attributes: ["id"], transaction }))) return c;
  }
  throw new ClaimError(500, "NUMBER_GENERATION_FAILED", "Unable to generate a claim number");
}

async function addHistory(db, claimId, from, to, actor, comment, transaction) {
  await db.ClaimStatusHistory.create({ claim_id: claimId, from_status: from, to_status: to, actor_type: actor.type, actor_id: actor.id, comment: comment || null }, { transaction });
}

/** The ONLY way a status changes. Validates the edge and who may take it, and refuses stale updates (optimistic lock). */
function assertTransition(claim, to, actorType) {
  const allowed = TRANSITIONS[claim.status] || {};
  if (!Object.prototype.hasOwnProperty.call(allowed, to)) throw new ClaimError(409, "INVALID_TRANSITION", `A claim in ${claim.status} cannot move to ${to}`);
  if (allowed[to] !== actorType) throw new ClaimError(403, "FORBIDDEN_TRANSITION", `Only ${allowed[to].toLowerCase()} users can move a claim to ${to}`);
}
async function transition(db, claim, to, actor, { comment, set = {}, transaction }) {
  assertTransition(claim, to, actor.type);
  const [affected] = await db.Claim.update({ status: to, ...set }, { where: { id: claim.id, status: claim.status }, transaction });
  if (affected !== 1) throw new ClaimError(409, "CONFLICT", "The claim was changed by someone else. Reload and try again.");
  await addHistory(db, claim.id, claim.status, to, actor, comment, transaction);
}

// ───────────────────────── serialisation ─────────────────────────
function serialize(c, extra = {}) {
  return {
    id: Number(c.id), number: c.claim_number, type: c.claim_type, status: c.status, distributorId: Number(c.distributor_id), customerId: c.customer_id ? Number(c.customer_id) : null,
    schemeId: Number(c.scheme_id), invoiceId: Number(c.invoice_id), claimDate: isoDay(c.claim_date), periodFrom: isoDay(c.period_from), periodTo: isoDay(c.period_to),
    amount: num(c.claim_amount), description: c.description || null, submittedAt: c.submitted_at || null, reviewedAt: c.reviewed_at || null, decidedAt: c.decided_at || null,
    decisionReason: c.decision_reason || null, correctionReason: c.correction_reason || null, requiredInformation: c.required_information || null,
    // Phase 12 — financial state. Only an APPROVED claim has one; null for every other status (they never create accounting entries).
    financialStatus: c.status === "APPROVED" ? (c.settled_at ? "SETTLED" : "PENDING_SETTLEMENT") : null,
    settlementReference: c.settlement_reference || null, settledAt: c.settled_at || null,
    createdAt: c.createdAt, updatedAt: c.updatedAt, editable: EDITABLE.includes(c.status), ...extra,
  };
}

// Run the accounting settlement inside the caller's transaction; accounting failures surface as ClaimErrors so the HTTP layer maps them.
async function settleInTx(claim, adminId, transaction) {
  try {
    return await accounting.settleClaim({ claim, adminId, transaction });
  } catch (err) {
    if (err instanceof accounting.AccountingError) {
      throw new ClaimError(err.statusCode, err.statusCode === 409 ? "ALREADY_SETTLED" : "SETTLEMENT_FAILED", err.message);
    }
    throw err;
  }
}

function actorFor(role, id) { return { type: role, id: Number(id) }; }

async function findOwned(db, scope, id, transaction) {
  const cid = q.intId(id, "id");
  if (!cid) throw bad("id is required");
  const where = { id: cid };
  if (scope.role === "distributor") where.distributor_id = scope.distributorId; // another distributor's claim simply does not exist
  return db.Claim.findOne({ where, transaction });
}

// ───────────────────────── list ─────────────────────────
const SORT = { number: "c.claim_number", type: "c.claim_type", distributor: "d.name", retailer: "cu.name", scheme: "s.scheme_code", amount: "c.claim_amount", claimDate: "c.claim_date", period: "c.period_from", status: "c.status", submittedAt: "c.submitted_at", reviewedAt: "c.reviewed_at", createdAt: "c.createdAt" };

async function listClaims(db, scope, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, SORT, { key: "createdAt", dir: "desc" });
  const status = q.oneOf(query.status, STATUSES, "status", (x) => String(x).toUpperCase());
  const type = q.oneOf(query.type, ["SCHEME"], "type", (x) => String(x).toUpperCase());
  const schemeId = q.intId(query.schemeId, "schemeId");
  const customerId = q.intId(query.customerId, "customerId");
  const from = q.day(query.from, "from");
  const to = q.day(query.to, "to");
  if (from && to && to < from) throw new q.QueryError("to cannot be before from");
  const search = q.text(query.q, "q");
  const params = {};
  const cl = [];
  if (scope.role === "distributor") { cl.push("c.distributor_id = :scopeDist"); params.scopeDist = scope.distributorId; }
  else { const d = q.intId(query.distributorId, "distributorId"); if (d) { cl.push("c.distributor_id = :d"); params.d = d; } }
  if (status) { cl.push("c.status = :status"); params.status = status; }
  if (type) { cl.push("c.claim_type = :type"); params.type = type; }
  if (schemeId) { cl.push("c.scheme_id = :schemeId"); params.schemeId = schemeId; }
  if (customerId) { cl.push("c.customer_id = :customerId"); params.customerId = customerId; }
  if (from) { cl.push("c.claim_date >= :from"); params.from = from; }
  if (to) { cl.push("c.claim_date <= :to"); params.to = to; }
  if (search) {
    cl.push(`(LOWER(c.claim_number) LIKE :s ESCAPE '!' OR LOWER(s.scheme_code) LIKE :s ESCAPE '!' OR LOWER(s.name) LIKE :s ESCAPE '!' OR LOWER(i.invoice_number) LIKE :s ESCAPE '!'${scope.role === "admin" ? " OR LOWER(d.name) LIKE :s ESCAPE '!' OR LOWER(d.distributor_code) LIKE :s ESCAPE '!'" : ""})`);
    params.s = q.likeTerm(search);
  }
  const where = cl.length ? `WHERE ${cl.join(" AND ")}` : "";
  const from_ = `${t(db.Claim)} c JOIN ${t(db.Distributor)} d ON d.id = c.distributor_id JOIN ${t(db.Scheme)} s ON s.id = c.scheme_id LEFT JOIN ${t(db.Customer)} cu ON cu.id = c.customer_id LEFT JOIN ${t(db.SalesInvoiceHeader)} i ON i.id = c.invoice_id`;
  const [{ total }] = await run(db, `SELECT COUNT(*) AS total FROM ${from_} ${where}`, params);
  const rows = await run(db, `SELECT c.*, d.name AS d_name, d.distributor_code AS d_code, s.scheme_code AS s_code, s.name AS s_name, cu.name AS cu_name, cu.customer_code AS cu_code, i.invoice_number AS inv_no
     FROM ${from_} ${where} ORDER BY ${sort.column} ${sort.dir}, c.id DESC LIMIT :limit OFFSET :offset`, { ...params, limit: pageSize, offset: (page - 1) * pageSize });
  const items = rows.map((r) => serialize(r, {
    distributor: scope.role === "admin" ? { id: Number(r.distributor_id), name: r.d_name, code: r.d_code } : undefined,
    retailer: r.customer_id ? { id: Number(r.customer_id), name: r.cu_name, code: r.cu_code } : null,
    scheme: { id: Number(r.scheme_id), name: r.s_name, code: r.s_code }, invoiceNumber: r.inv_no || null,
  }));
  return { items, page, pageSize, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)) };
}

// ───────────────────────── detail ─────────────────────────
async function getClaim(db, scope, id) {
  const c = await findOwned(db, scope, id);
  if (!c) return null;
  const { Op } = db.Sequelize;
  const [items, history, dist, cust, scheme, inv] = await Promise.all([
    db.ClaimItem.findAll({ where: { claim_id: c.id }, order: [["id", "ASC"]] }),
    db.ClaimStatusHistory.findAll({ where: { claim_id: c.id }, order: [["id", "ASC"]] }),
    db.Distributor.findOne({ where: { id: c.distributor_id }, attributes: ["id", "name", "distributor_code", "email", "status"] }),
    c.customer_id ? db.Customer.findOne({ where: { id: c.customer_id }, attributes: ["id", "name", "customer_code", "distributor_id"] }) : null,
    db.Scheme.findByPk(c.scheme_id),
    db.SalesInvoiceHeader.findOne({ where: { id: c.invoice_id }, attributes: ["id", "invoice_number", "invoiceDate", "status", "totalAmount"] }),
  ]);
  const products = items.length ? await db.Product.findAll({ where: { id: { [Op.in]: items.map((i) => i.product_id) } }, attributes: ["id", "name", "material_code"] }) : [];
  const pMap = new Map(products.map((p) => [Number(p.id), p]));
  const admins = scope.role === "admin" ? await db.AdminUser.findAll({ where: { id: { [Op.in]: [...new Set(history.filter((h) => h.actor_type === "ADMIN").map((h) => h.actor_id))] } }, attributes: ["id", "name"] }) : [];
  const aMap = new Map(admins.map((a) => [Number(a.id), a.name]));
  let snapshot = null;
  try { snapshot = c.scheme_snapshot ? JSON.parse(c.scheme_snapshot) : null; } catch { snapshot = null; }
  const isAdmin = scope.role === "admin";
  return serialize(c, {
    distributor: dist ? { id: Number(dist.id), name: dist.name, code: dist.distributor_code, ...(isAdmin ? { email: dist.email, status: dist.status } : {}) } : null,
    retailer: cust ? { id: Number(cust.id), name: cust.name, code: cust.customer_code } : null,
    scheme: scheme ? { id: Number(scheme.id), name: scheme.name, code: scheme.scheme_code, type: scheme.scheme_type, ruleSummary: schemesSvc.ruleSummary(scheme), validFrom: isoDay(scheme.valid_from), validTo: isoDay(scheme.valid_to), currentStatus: schemesSvc.effectiveStatus(scheme) } : null,
    schemeSnapshot: snapshot, // the rule as it was when the claim was submitted
    invoice: inv ? { id: Number(inv.id), number: inv.invoice_number, date: isoDay(inv.invoiceDate), status: inv.status, total: num(inv.totalAmount) } : null,
    items: items.map((i) => ({ id: Number(i.id), invoiceLineId: Number(i.invoice_line_id), productId: Number(i.product_id), productName: (pMap.get(Number(i.product_id)) || {}).name || null, productCode: (pMap.get(Number(i.product_id)) || {}).material_code || null, quantity: i.quantity, unitPrice: num(i.unit_price), benefitType: i.benefit_type, freeQuantity: i.free_quantity, eligibleAmount: num(i.eligible_amount) })),
    history: history.map((h) => ({ id: Number(h.id), from: h.from_status, to: h.to_status, actorType: h.actor_type, actor: h.actor_type === "ADMIN" ? (isAdmin ? aMap.get(Number(h.actor_id)) || "Admin" : "Administrator") : "Distributor", comment: h.comment, at: h.createdAt })),
    ...(isAdmin ? { decidedByAdminId: c.decided_by_admin_id || null } : {}),
  });
}

// ───────────────────────── distributor writes ─────────────────────────
async function persistItems(db, claimId, assessed, transaction) {
  await db.ClaimItem.destroy({ where: { claim_id: claimId }, transaction });
  await db.ClaimItem.bulkCreate(assessed.items.map((r) => ({ ...r, claim_id: claimId })), { transaction });
}

async function createClaim(db, scope, body) {
  const p = parseInput(body);
  const tx = await db.sequelize.transaction();
  try {
    const invoice = await loadInvoice(db, scope.distributorId, p.invoiceId, tx);
    const a = await assess(db, { distributorId: scope.distributorId, invoice, schemeId: p.schemeId, from: p.from, to: p.to, items: p.items, transaction: tx });
    const claim = await db.Claim.create({
      claim_number: await nextNumber(db, tx), claim_type: "SCHEME", distributor_id: scope.distributorId, customer_id: invoice.customer_id, scheme_id: p.schemeId, invoice_id: invoice.id,
      claim_date: today(), period_from: p.from, period_to: p.to, claim_amount: a.amount, description: p.description, status: "DRAFT",
    }, { transaction: tx });
    await persistItems(db, claim.id, a, tx);
    await addHistory(db, claim.id, null, "DRAFT", actorFor("DISTRIBUTOR", scope.distributorId), "Claim created", tx);
    await tx.commit();
    return { ...(await getClaim(db, scope, claim.id)), issues: a.issues };
  } catch (err) { await tx.rollback(); throw err; }
}

async function updateClaim(db, scope, id, body) {
  const p = parseInput(body);
  const tx = await db.sequelize.transaction();
  try {
    const claim = await findOwned(db, scope, id, tx);
    if (!claim) { await tx.rollback(); return null; }
    if (!EDITABLE.includes(claim.status)) throw new ClaimError(409, "NOT_EDITABLE", `A claim in ${claim.status} cannot be edited`);
    if (p.invoiceId !== Number(claim.invoice_id) || p.schemeId !== Number(claim.scheme_id)) throw bad("The invoice and scheme of a claim cannot be changed — create a new claim instead", { field: "invoice_id" });
    const invoice = await loadInvoice(db, scope.distributorId, p.invoiceId, tx);
    const a = await assess(db, { distributorId: scope.distributorId, invoice, schemeId: p.schemeId, from: p.from, to: p.to, items: p.items, excludeClaimId: claim.id, transaction: tx });
    await claim.update({ period_from: p.from, period_to: p.to, description: p.description, claim_amount: a.amount }, { transaction: tx });
    await persistItems(db, claim.id, a, tx);
    await tx.commit();
    return { ...(await getClaim(db, scope, claim.id)), issues: a.issues };
  } catch (err) { await tx.rollback(); throw err; }
}

async function submitClaim(db, scope, id, to) {
  const tx = await db.sequelize.transaction();
  try {
    const claim = await findOwned(db, scope, id, tx);
    if (!claim) { await tx.rollback(); return null; }
    const target = to; // SUBMITTED for submit, RESUBMITTED for resubmit
    const expectFrom = target === "SUBMITTED" ? "DRAFT" : "NEEDS_CORRECTION";
    if (claim.status !== expectFrom) throw new ClaimError(409, "INVALID_TRANSITION", `A claim in ${claim.status} cannot be ${target === "SUBMITTED" ? "submitted" : "resubmitted"}`);
    const invoice = await loadInvoice(db, scope.distributorId, claim.invoice_id, tx);
    const stored = await db.ClaimItem.findAll({ where: { claim_id: claim.id }, transaction: tx });
    const a = await assess(db, { distributorId: scope.distributorId, invoice, schemeId: claim.scheme_id, from: isoDay(claim.period_from), to: isoDay(claim.period_to), items: stored.map((i) => ({ invoice_line_id: Number(i.invoice_line_id), quantity: i.quantity })), excludeClaimId: claim.id, transaction: tx });
    if (a.issues.length) throw new ClaimError(422, "CLAIM_NOT_ELIGIBLE", "This claim cannot be submitted until the listed problems are fixed", { issues: a.issues });
    await persistItems(db, claim.id, a, tx);
    await transition(db, claim, target, actorFor("DISTRIBUTOR", scope.distributorId), {
      comment: target === "SUBMITTED" ? "Submitted for review" : "Resubmitted after correction", transaction: tx,
      set: { claim_amount: a.amount, submitted_at: new Date(), scheme_snapshot: snapshotOf(a.scheme), ...(target === "RESUBMITTED" ? { reviewed_at: null } : {}) },
    });
    await tx.commit();
    return getClaim(db, scope, claim.id);
  } catch (err) { await tx.rollback(); throw err; }
}

// ───────────────────────── admin decisions ─────────────────────────
const ADMIN_SCOPE = { role: "admin" };

async function adminAction(db, adminId, id, to, { comment, set, requireValid = false, requireComment = null } = {}) {
  const tx = await db.sequelize.transaction();
  try {
    const claim = await findOwned(db, ADMIN_SCOPE, id, tx);
    if (!claim) { await tx.rollback(); return null; }
    assertTransition(claim, to, "ADMIN"); // wrong state → 409 before any eligibility work
    if (requireComment) comment = cleanText(comment, requireComment.field, 1000, { required: true, min: 5 });
    else comment = cleanText(comment, "comment", 1000);
    if (requireValid) {
      // The decision is taken on the CURRENT truth, not on what was true at submission.
      const invoice = await db.SalesInvoiceHeader.findByPk(claim.invoice_id, { transaction: tx });
      const stored = await db.ClaimItem.findAll({ where: { claim_id: claim.id }, transaction: tx });
      if (!invoice || !stored.length) throw new ClaimError(422, "CLAIM_NOT_ELIGIBLE", "The claim has no valid invoice lines", { issues: [{ code: "NO_ITEMS", message: "The claim has no valid invoice lines" }] });
      if (!claim.description || !String(claim.description).trim()) throw new ClaimError(422, "CLAIM_NOT_ELIGIBLE", "A description is required before approval", { issues: [{ code: "NO_DESCRIPTION", message: "The distributor has not provided a description" }] });
      const a = await assess(db, { distributorId: Number(claim.distributor_id), invoice, schemeId: claim.scheme_id, from: isoDay(claim.period_from), to: isoDay(claim.period_to), items: stored.map((i) => ({ invoice_line_id: Number(i.invoice_line_id), quantity: i.quantity })), excludeClaimId: claim.id, transaction: tx });
      if (a.issues.length) throw new ClaimError(422, "CLAIM_NOT_ELIGIBLE", "The claim is not eligible for approval", { issues: a.issues });
      if (Math.abs(a.amount - Number(claim.claim_amount)) > 0.009) throw new ClaimError(422, "AMOUNT_CHANGED", `The permitted benefit is now ${a.amount}, not ${Number(claim.claim_amount)} — ask the distributor to resubmit`, { issues: [{ code: "AMOUNT_CHANGED", message: `Permitted benefit is now ${a.amount}` }] });
    }
    await transition(db, claim, to, actorFor("ADMIN", adminId), { comment, set: set ? set(comment) : {}, transaction: tx });
    // Phase 12: approval and its accounting are ONE unit. If the settlement cannot be posted the approval is rolled back too.
    // Only APPROVED ever reaches this line with an accounting effect — reject / needs-correction / review never settle.
    if (to === "APPROVED") await settleInTx(claim, adminId, tx);
    await tx.commit();
    return getClaim(db, ADMIN_SCOPE, claim.id);
  } catch (err) { await tx.rollback(); throw err; }
}

// Settles a claim that was APPROVED before Phase 12 (so it has no accounting yet). It is not an approval and changes no status.
// Safe to call repeatedly: a claim that is already settled is rejected (409) and nothing is posted.
async function settle(db, adminId, id) {
  const tx = await db.sequelize.transaction();
  try {
    const claim = await findOwned(db, ADMIN_SCOPE, id, tx);
    if (!claim) { await tx.rollback(); return null; }
    if (claim.status !== "APPROVED") throw new ClaimError(409, "CLAIM_NOT_APPROVED", `Only an approved claim can be settled (this claim is ${claim.status})`);
    if (claim.settled_at) throw new ClaimError(409, "ALREADY_SETTLED", "This claim is already financially settled");
    await settleInTx(claim, adminId, tx);
    await tx.commit();
    return getClaim(db, ADMIN_SCOPE, claim.id);
  } catch (err) { await tx.rollback(); throw err; }
}

const review = (db, adminId, id, body) => adminAction(db, adminId, id, "UNDER_REVIEW", { comment: body && body.comment, set: () => ({ reviewed_at: new Date() }) });
const approve = (db, adminId, id, body) => adminAction(db, adminId, id, "APPROVED", { comment: body && body.comment, requireValid: true, set: (c) => ({ decided_at: new Date(), decided_by_admin_id: adminId, decision_reason: c }) });
const reject = (db, adminId, id, body) => adminAction(db, adminId, id, "REJECTED", { comment: body && body.reason, requireComment: { field: "reason" }, set: (c) => ({ decided_at: new Date(), decided_by_admin_id: adminId, decision_reason: c }) });
async function needsCorrection(db, adminId, id, body) {
  const info = cleanText(body && body.required_information, "required_information", 1000);
  return adminAction(db, adminId, id, "NEEDS_CORRECTION", { comment: body && body.reason, requireComment: { field: "reason" }, set: (c) => ({ correction_reason: c, required_information: info }) });
}

// ───────────────────────── lookups ─────────────────────────
async function getLookups(db, scope) {
  const base = { statuses: STATUSES, types: [{ value: "SCHEME", label: "Scheme claim" }] };
  if (scope.role === "admin") {
    const [distributors, schemes, retailers] = await Promise.all([
      run(db, `SELECT id, name, distributor_code AS code FROM ${t(db.Distributor)} ORDER BY name ASC LIMIT 1000`, {}),
      run(db, `SELECT id, name, scheme_code AS code FROM ${t(db.Scheme)} ORDER BY name ASC LIMIT 1000`, {}),
      run(db, `SELECT id, name, customer_code AS code, distributor_id FROM ${t(db.Customer)} ORDER BY name ASC LIMIT 500`, {}),
    ]);
    return { ...base, distributors: distributors.map((d) => ({ id: Number(d.id), name: d.name, code: d.code })), schemes: schemes.map((s) => ({ id: Number(s.id), name: s.name, code: s.code })), retailers: retailers.map((r) => ({ id: Number(r.id), name: r.name, code: r.code, distributorId: Number(r.distributor_id) })) };
  }
  const [schemes, invoices, retailers] = await Promise.all([
    engine.listApplicableForDistributor(scope.distributorId),
    run(db, `SELECT i.id, i.invoice_number AS number, i.invoiceDate AS date, i.status, i.totalAmount AS total, cu.name AS customer
       FROM ${t(db.SalesInvoiceHeader)} i LEFT JOIN ${t(db.Customer)} cu ON cu.id = i.customer_id
       WHERE i.distributor_id = :d AND i.status IN ('POSTED','PARTIALLY_PAID','PAID') ORDER BY i.invoiceDate DESC, i.id DESC LIMIT 200`, { d: scope.distributorId }),
    run(db, `SELECT id, name, customer_code AS code FROM ${t(db.Customer)} WHERE distributor_id = :d ORDER BY name ASC LIMIT 500`, { d: scope.distributorId }),
  ]);
  return {
    ...base,
    schemes: schemes.map((s) => ({ id: s.id, name: s.name, code: s.code, ruleSummary: s.ruleSummary })),
    invoices: invoices.map((i) => ({ id: Number(i.id), number: i.number, date: isoDay(i.date), status: i.status, total: num(i.total), customer: i.customer || null })),
    retailers: retailers.map((r) => ({ id: Number(r.id), name: r.name, code: r.code })),
  };
}

/** Distributor helper for the claim form: the invoice's lines, whether the chosen scheme applies to each, and what is already claimed. */
async function previewInvoiceLines(db, scope, invoiceId, schemeId) {
  const id = q.intId(invoiceId, "invoiceId");
  const sid = q.intId(schemeId, "schemeId");
  if (!id) throw bad("invoiceId is required");
  const invoice = await loadInvoice(db, scope.distributorId, id);
  const lines = await db.SalesInvoiceLine.findAll({ where: { invoiceId: id }, order: [["id", "ASC"]] });
  const { Op } = db.Sequelize;
  const products = lines.length ? await db.Product.findAll({ where: { id: { [Op.in]: lines.map((l) => l.productId) } }, attributes: ["id", "name", "material_code"] }) : [];
  const pMap = new Map(products.map((p) => [Number(p.id), p]));
  let ev = null;
  if (lines.length) {
    ev = await engine.evaluate({ distributorId: scope.distributorId, customerId: invoice.customer_id, asOf: isoDay(invoice.invoiceDate), lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.pricePerUnit })) });
  }
  const taken = lines.length && sid ? await db.ClaimItem.findAll({ where: { invoice_line_id: { [Op.in]: lines.map((l) => l.id) } }, raw: true }) : [];
  const liveClaims = taken.length ? await db.Claim.findAll({ where: { id: { [Op.in]: [...new Set(taken.map((x) => x.claim_id))] }, scheme_id: sid, status: { [Op.in]: LIVE } }, attributes: ["id", "claim_number"] }) : [];
  const claimOf = new Map(liveClaims.map((c) => [Number(c.id), c.claim_number]));
  return {
    invoice: { id: Number(invoice.id), number: invoice.invoice_number, date: isoDay(invoice.invoiceDate) },
    lines: lines.map((l, i) => {
      const r = ev ? ev.lines[i] : null;
      const applied = r && r.applied && (!sid || r.applied.schemeId === sid) ? r.applied : null;
      const hit = taken.find((x) => Number(x.invoice_line_id) === Number(l.id) && claimOf.has(Number(x.claim_id)));
      return {
        id: Number(l.id), productId: Number(l.productId), productName: (pMap.get(Number(l.productId)) || {}).name || null, productCode: (pMap.get(Number(l.productId)) || {}).material_code || null,
        quantity: l.quantity, unitPrice: num(l.pricePerUnit), eligible: Boolean(applied), benefitType: applied ? applied.benefitType : null,
        freeQuantity: applied && applied.freeQuantity ? applied.freeQuantity : 0, benefitAmount: applied ? (applied.benefitType === "FREE_QUANTITY" ? round2(applied.freeQuantity * Number(l.pricePerUnit || 0)) : applied.discountAmount) : 0,
        alreadyClaimedIn: hit ? claimOf.get(Number(hit.claim_id)) : null,
      };
    }),
  };
}

module.exports = { _transition: transition, ClaimError, STATUSES, TRANSITIONS, listClaims, getClaim, createClaim, updateClaim, submitClaim, review, approve, reject, needsCorrection, settle, getLookups, previewInvoiceLines };
