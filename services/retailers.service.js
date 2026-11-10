// services/retailers.service.js
//
// Phase 9 — Retailer Management. A "retailer" IS a Customer row (Customer.distributor_id = owner). No Retailer table, no retailer login.
// One service backs BOTH portals; every function takes a `scope` built by the controller from the AUTHENTICATED session — never from the request body:
//     { role: "admin" }                                   → may act on any retailer
//     { role: "distributor", distributorId, distributorCode } → may act ONLY on Customer.distributor_id = distributorId
//
// Ownership rules enforced here (frontend hiding is not relied on):
//   • a distributor's list/detail/edit/status/create are pinned to scope.distributorId;
//   • distributor_id supplied in a distributor's request body is rejected (403) unless it equals its own id;
//   • only reassign() can change ownership, and only an admin controller calls it;
//   • nothing is ever deleted; history keeps pointing at the same customer id.
const q = require("./salesQuery");
const tax = require("./tax.service");

const AR_GL_NAME = "Accounts Receivable";
const SALES_INVOICE_STATUSES = "('POSTED','PARTIALLY_PAID','PAID')";
const OPEN_ORDER_STATUSES = "('DRAFT','CONFIRMED','PARTIALLY_DELIVERED')";
const STATUSES = ["active", "inactive", "pending"];
const TERRITORY = "COALESCE(NULLIF(c.territory,''), NULLIF(c.city,''), NULLIF(c.region,''))";

class RetailerError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "RetailerError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
const forbidden = (msg = "You do not have access to this retailer") => new RetailerError(403, "FORBIDDEN", msg);

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => (v === null || v === undefined ? null : tax.round2(num(v)));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const isAdmin = (scope) => scope && scope.role === "admin";

function tables(db) {
  const t = (m) => `\`${m.getTableName()}\``;
  return {
    customer: t(db.Customer), distributor: t(db.Distributor), group: t(db.CustomerGroup), order: t(db.SalesOrderHeader), invoice: t(db.SalesInvoiceHeader),
    ret: t(db.SalesReturn), creditNote: t(db.SalesCreditNote), journal: t(db.JournalEntry), gl: t(db.GLMaster),
  };
}
const runner = (db) => (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
function whereBuilder() {
  const clauses = [];
  const params = {};
  return { params, add(sql, p = {}) { clauses.push(sql); Object.assign(params, p); }, sql: () => (clauses.length ? `WHERE ${clauses.join(" AND ")}` : "") };
}

// ───────────────────────── validation ─────────────────────────
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9\s-]{7,14}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const clean = (v) => (v === undefined || v === null ? undefined : String(v).trim());
const maxLen = { name: 255, contact_person: 150, street1: 255, street2: 255, street3: 255, street4: 255, city: 255, region: 255, territory: 100, alternatePhone: 20, resignDescription: 1000 };

function validateInput(body = {}, { partial = false } = {}) {
  const errors = {};
  const values = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const text = (k, { required = false, label = k } = {}) => {
    if (!has(k)) {
      if (required && !partial) errors[k] = `${label} is required`;
      return;
    }
    const v = clean(body[k]);
    if (!v) {
      if (required) errors[k] = `${label} is required`;
      else values[k] = null;
      return;
    }
    if (v.length > maxLen[k]) errors[k] = `${label} must be at most ${maxLen[k]} characters`;
    else values[k] = v;
  };
  text("name", { required: true, label: "Business name" });
  text("contact_person", { label: "Contact person" });
  text("street1", { required: true, label: "Address line 1" });
  text("street2"); text("street3"); text("street4");
  text("city", { required: true, label: "City" });
  text("region", { required: true, label: "State" });
  text("territory", { label: "Territory" });

  if (has("phone_number") || !partial) {
    const v = clean(body.phone_number);
    if (!v) errors.phone_number = "Phone number is required";
    else if (!PHONE.test(v)) errors.phone_number = "Enter a valid phone number (8–15 digits)";
    else values.phone_number = v;
  }
  if (has("alternatePhone")) {
    const v = clean(body.alternatePhone);
    if (!v) values.alternatePhone = null;
    else if (!PHONE.test(v)) errors.alternatePhone = "Enter a valid phone number (8–15 digits)";
    else values.alternatePhone = v;
  }
  if (has("email")) {
    const v = (clean(body.email) || "").toLowerCase();
    if (!v) values.email = null;
    else if (v.length > 255 || !EMAIL.test(v)) errors.email = "Enter a valid email address";
    else values.email = v;
  }
  if (has("pincode") || !partial) {
    const v = clean(body.pincode !== undefined ? body.pincode : body.postalCode);
    if (!v) errors.pincode = "PIN code is required";
    else if (!PINCODE.test(v)) errors.pincode = "Enter a valid 6-digit PIN code";
    else {
      values.pincode = v;
      values.postalCode = v; // the table carries both columns; keep them in step
    }
  }
  if (has("taxNumber")) {
    const v = (clean(body.taxNumber) || "").toUpperCase();
    if (!v) values.taxNumber = null;
    else if (!GSTIN.test(v)) errors.taxNumber = "Enter a valid 15-character GSTIN (e.g. 27ABCDE1234F1Z5)";
    else values.taxNumber = v;
  }
  if (has("pan")) {
    const v = (clean(body.pan) || "").toUpperCase();
    if (!v) values.pan = null;
    else if (!PAN.test(v)) errors.pan = "Enter a valid 10-character PAN (e.g. ABCDE1234F)";
    else values.pan = v;
  }
  if (has("customer_group_id")) {
    const n = Number(body.customer_group_id);
    if (!Number.isInteger(n) || n <= 0) errors.customer_group_id = "Select a customer group";
    else values.customer_group_id = n;
  } else if (!partial) errors.customer_group_id = "Select a customer group";

  // Optional separate shipping address (stored as an existing Address row of type ship_to_party).
  let shipping;
  if (has("shipping")) {
    const s = body.shipping;
    if (s === null || (typeof s === "object" && !Object.values(s).some((x) => clean(x)))) shipping = null;
    else if (typeof s === "object") {
      const sv = { street1: clean(s.street1), street2: clean(s.street2), city: clean(s.city), region: clean(s.region), pincode: clean(s.pincode) };
      const se = {};
      if (!sv.street1) se.street1 = "Shipping address line 1 is required";
      if (!sv.city) se.city = "Shipping city is required";
      if (!sv.region) se.region = "Shipping state is required";
      if (!sv.pincode || !PINCODE.test(sv.pincode)) se.pincode = "Enter a valid 6-digit PIN code";
      if (Object.keys(se).length) Object.entries(se).forEach(([k, m]) => (errors[`shipping.${k}`] = m));
      else shipping = sv;
    }
  }
  return { values, errors, shipping };
}
const failValidation = (errors) => new RetailerError(400, "VALIDATION_FAILED", Object.values(errors)[0], errors);

// ───────────────────────── projections ─────────────────────────
const EDITABLE = ["name", "contact_person", "phone_number", "alternatePhone", "email", "taxNumber", "pan", "street1", "street2", "street3", "city", "region", "pincode", "postalCode", "territory", "customer_group_id"];

function shape(c, extra = {}) {
  return {
    id: Number(c.id), code: c.customer_code, name: c.name, contactPerson: c.contact_person || null, phone: c.phone_number || null, alternatePhone: c.alternatePhone || null,
    email: c.email || null, gstin: c.taxNumber || null, pan: c.pan || null,
    address: { street1: c.street1 || null, street2: c.street2 || null, street3: c.street3 || null, street4: c.street4 || null, city: c.city || null, state: c.region || null, pincode: c.pincode || c.postalCode || null },
    territory: c.territory || null, effectiveTerritory: c.territory || c.city || c.region || null,
    status: c.status || "active", statusReason: c.status_reason || null, statusChangedAt: iso(c.status_changed_at),
    createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt), ...extra,
  };
}

// Loads a retailer AND enforces ownership. null → 404 (does not exist); wrong owner → 403 (no data from the row is returned).
async function loadOwned(db, scope, rawId, { transaction, lock } = {}) {
  const id = q.intId(rawId, "id");
  if (!id) throw new q.QueryError("id must be a positive integer");
  const c = await db.Customer.findOne({ where: { id }, transaction, lock });
  if (!c) return null;
  if (!isAdmin(scope) && Number(c.distributor_id) !== Number(scope.distributorId)) throw forbidden();
  return c;
}

async function ownerInfo(db, distributorId, transaction) {
  return db.Distributor.findOne({ where: { id: distributorId }, attributes: ["id", "distributor_code", "name", "status"], transaction });
}

// ───────────────────────── lookups ─────────────────────────
async function getLookups(db, scope) {
  const t = tables(db);
  const run = runner(db);
  const w = whereBuilder();
  if (!isAdmin(scope)) w.add("c.distributor_id = :did", { did: scope.distributorId });
  const distinct = (col) => run(`SELECT DISTINCT ${col} AS v FROM ${t.customer} c ${w.sql()}${w.sql() ? " AND" : " WHERE"} ${col} IS NOT NULL AND ${col} <> '' ORDER BY v ASC LIMIT 500`, w.params);
  const groupWhere = isAdmin(scope) ? "" : "WHERE g.distributor_id = :did";
  const [states, cities, territories, groups] = await Promise.all([
    distinct("c.region"), distinct("c.city"), distinct(TERRITORY),
    run(`SELECT g.id, g.code, g.name, g.distributor_id FROM ${t.group} g ${groupWhere} ORDER BY g.name ASC LIMIT 1000`, { did: scope.distributorId }),
  ]);
  const out = {
    statuses: STATUSES, states: states.map((r) => r.v), cities: cities.map((r) => r.v), territories: territories.map((r) => r.v),
    customerGroups: groups.map((g) => ({ id: Number(g.id), code: g.code, name: g.name, distributorId: Number(g.distributor_id) })),
  };
  if (isAdmin(scope)) {
    const ds = await run(`SELECT id, distributor_code, name, status FROM ${t.distributor} ORDER BY name ASC LIMIT 1000`);
    out.distributors = ds.map((d) => ({ id: Number(d.id), code: d.distributor_code, name: d.name, status: d.status || "active" }));
  }
  return out;
}

// ───────────────────────── list ─────────────────────────
const SORT = { name: "c.name", code: "c.customer_code", city: "c.city", state: "c.region", territory: TERRITORY, status: "c.status", distributor: "d.name", createdAt: "c.createdAt" };

async function listRetailers(db, scope, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, SORT, { key: "name", dir: "asc" });
  const status = q.oneOf(query.status, STATUSES, "status");
  const state = q.text(query.state, "state");
  const city = q.text(query.city, "city");
  const territory = q.text(query.territory, "territory");
  const search = q.text(query.q, "q");
  const distributorFilter = isAdmin(scope) ? q.intId(query.distributorId, "distributorId") : null;

  const t = tables(db);
  const run = runner(db);
  const w = whereBuilder();
  // Ownership pin: for a distributor this clause is unconditional and comes from the session, never from the query string.
  if (!isAdmin(scope)) w.add("c.distributor_id = :scopeDid", { scopeDid: scope.distributorId });
  else if (distributorFilter) w.add("c.distributor_id = :fdid", { fdid: distributorFilter });
  if (status) w.add("c.status = :status", { status });
  if (state) w.add("c.region = :state", { state });
  if (city) w.add("c.city = :city", { city });
  if (territory) w.add(`${TERRITORY} = :territory`, { territory });
  if (search) {
    w.add(
      `(LOWER(c.name) LIKE :s ESCAPE '!' OR LOWER(COALESCE(c.customer_code,'')) LIKE :s ESCAPE '!' OR LOWER(COALESCE(c.contact_person,'')) LIKE :s ESCAPE '!'
        OR LOWER(COALESCE(c.email,'')) LIKE :s ESCAPE '!' OR COALESCE(c.phone_number,'') LIKE :s ESCAPE '!' OR LOWER(COALESCE(c.taxNumber,'')) LIKE :s ESCAPE '!')`,
      { s: q.likeTerm(search) }
    );
  }
  const from = `${t.customer} c LEFT JOIN ${t.distributor} d ON d.id = c.distributor_id`;
  const [{ total }] = await run(`SELECT COUNT(*) AS total FROM ${from} ${w.sql()}`, w.params);
  const rows = await run(
    `SELECT c.id, c.customer_code, c.name, c.contact_person, c.phone_number, c.email, c.taxNumber, c.pan, c.city, c.region, c.territory, c.status, c.createdAt,
            c.distributor_id, d.distributor_code, d.name AS distributor_name
     FROM ${from} ${w.sql()} ORDER BY ${sort.column} ${sort.dir}, c.id ASC LIMIT :limit OFFSET :offset`,
    { ...w.params, limit: pageSize, offset: (page - 1) * pageSize }
  );
  return {
    items: rows.map((r) => ({
      id: Number(r.id), code: r.customer_code, name: r.name, contactPerson: r.contact_person || null, phone: r.phone_number || null, email: r.email || null,
      gstin: r.taxNumber || null, pan: r.pan || null, city: r.city || null, state: r.region || null, territory: r.territory || r.city || r.region || null,
      status: r.status || "active", createdAt: iso(r.createdAt),
      // Admin sees the owning distributor; the distributor portal does not need (and does not get) it.
      ...(isAdmin(scope) ? { distributor: { id: Number(r.distributor_id), code: r.distributor_code || null, name: r.distributor_name || null } } : {}),
    })),
    total: num(total), page, pageSize,
  };
}

// ───────────────────────── detail ─────────────────────────
async function getRetailerDetail(db, scope, rawId) {
  const c = await loadOwned(db, scope, rawId);
  if (!c) return null;
  const t = tables(db);
  const run = runner(db);
  const owner = await ownerInfo(db, c.distributor_id);
  const group = await db.CustomerGroup.findOne({ where: { id: c.customer_group_id }, attributes: ["id", "code", "name"] });
  const ship = await db.Address.findOne({ where: { customer_id: c.id, type: "ship_to_party" } });

  // Documents are scoped to the retailer. A distributor additionally only sees documents issued under ITS OWN id,
  // so after an admin reassignment the new owner never sees the previous distributor's paperwork.
  const docScope = isAdmin(scope) ? "" : " AND x.distributor_id = :did";
  const jScope = isAdmin(scope) ? "" : " AND j.distributor_code = :dcode";
  const p = { cid: Number(c.id), did: scope.distributorId, dcode: scope.distributorCode };
  const arJoin = `${t.journal} j JOIN ${t.gl} g ON g.id = j.gl_id`;
  const arWhere = `g.gl_name = '${AR_GL_NAME}' AND j.customer_id = :cid${jScope}`;
  const payWhere = `${arWhere} AND j.reference_type = 'CUSTOMER_PAYMENT'`;

  const [sales, orderAgg, ar, orders, invoices, payments, paymentAgg, returns, returnAgg] = await Promise.all([
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(x.totalAmount),0) AS gross FROM ${t.invoice} x WHERE x.customer_id = :cid AND x.status IN ${SALES_INVOICE_STATUSES}${docScope}`, p),
    run(`SELECT COUNT(*) AS n FROM ${t.order} x WHERE x.customerId = :cid AND x.status NOT IN ('DRAFT','CANCELLED')${docScope}`, p),
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(j.debit),0) - COALESCE(SUM(j.credit),0) AS outstanding FROM ${arJoin} WHERE ${arWhere}`, p),
    run(`SELECT x.id, x.order_number, x.orderDate, x.status, x.totalAmount FROM ${t.order} x WHERE x.customerId = :cid${docScope} ORDER BY x.orderDate DESC, x.id DESC LIMIT 8`, p),
    run(`SELECT x.id, x.invoice_number, x.invoiceDate, x.status, x.totalAmount, x.outstandingAmount FROM ${t.invoice} x WHERE x.customer_id = :cid${docScope} ORDER BY x.invoiceDate DESC, x.id DESC LIMIT 8`, p),
    run(`SELECT j.id, j.reference_no, j.credit AS amount, j.transaction_date FROM ${arJoin} WHERE ${payWhere} ORDER BY j.transaction_date DESC, j.id DESC LIMIT 8`, p),
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(j.credit),0) AS total FROM ${arJoin} WHERE ${payWhere}`, p),
    run(`SELECT x.id, x.return_number, x.returnDate, x.status, cn.totalAmount AS credit_amount FROM ${t.ret} x LEFT JOIN ${t.creditNote} cn ON cn.id = x.creditNoteId WHERE x.customerId = :cid${docScope} ORDER BY x.returnDate DESC, x.id DESC LIMIT 8`, p),
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(cn.totalAmount),0) AS total FROM ${t.ret} x LEFT JOIN ${t.creditNote} cn ON cn.id = x.creditNoteId WHERE x.customerId = :cid AND x.status = 'POSTED'${docScope}`, p),
  ]);

  return shape(c, {
    distributor: { id: Number(owner.id), code: owner.distributor_code, name: owner.name, status: owner.status || "active" },
    customerGroup: group ? { id: Number(group.id), code: group.code, name: group.name } : null,
    shipping: ship ? { street1: ship.street1 || null, street2: ship.street2 || null, city: ship.city || null, state: ship.region || null, pincode: ship.pincode || ship.postalCode || null } : null,
    summary: {
      salesInvoiced: money(sales[0].gross), invoiceCount: num(sales[0].n), orderCount: num(orderAgg[0].n),
      outstanding: num(ar[0] && ar[0].n) > 0 ? money(ar[0].outstanding) : null, // null = no receivable ledger yet — never invented
      paymentsReceived: money(paymentAgg[0].total), paymentCount: num(paymentAgg[0].n),
      returnCount: num(returnAgg[0].n), returnValue: money(returnAgg[0].total),
      creditLimit: null, // the Customer model has no credit-limit field; credit enforcement is out of scope for this phase
    },
    recentOrders: orders.map((o) => ({ id: Number(o.id), number: o.order_number, date: iso(o.orderDate), status: o.status, total: money(o.totalAmount) })),
    recentInvoices: invoices.map((i) => ({ id: Number(i.id), number: i.invoice_number, date: iso(i.invoiceDate), status: i.status, total: money(i.totalAmount), outstanding: money(i.outstandingAmount) })),
    recentPayments: payments.map((x) => ({ id: Number(x.id), reference: x.reference_no || null, date: iso(x.transaction_date), amount: money(x.amount) })),
    recentReturns: returns.map((r) => ({ id: Number(r.id), number: r.return_number, date: iso(r.returnDate), status: r.status, creditAmount: money(r.credit_amount) })),
  });
}

// ───────────────────────── writes ─────────────────────────
async function assertGroupBelongsTo(db, groupId, distributorId, transaction) {
  const g = await db.CustomerGroup.findOne({ where: { id: groupId, distributor_id: distributorId }, attributes: ["id"], transaction });
  if (!g) throw new RetailerError(400, "VALIDATION_FAILED", "Select a customer group that belongs to this distributor", { customer_group_id: "Select a customer group that belongs to this distributor" });
}

async function assertUnique(db, { taxNumber }, distributorId, excludeId, transaction) {
  // Customers are per-distributor rows, so the same pharmacy may legitimately buy from two distributors.
  // A GSTIN can therefore only be a duplicate WITHIN one distributor's retailer list.
  if (!taxNumber) return;
  const { Op } = db.Sequelize;
  const clash = await db.Customer.findOne({ where: { distributor_id: distributorId, taxNumber, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) }, attributes: ["id"], transaction });
  if (clash) throw new RetailerError(409, "DUPLICATE", "A retailer with this GSTIN already exists for this distributor", { taxNumber: "A retailer with this GSTIN already exists for this distributor" });
}

async function saveShipping(db, customerId, shipping, transaction) {
  if (shipping === undefined) return;
  await db.Address.destroy({ where: { customer_id: customerId, type: "ship_to_party" }, transaction }); // only the shipping row is touched
  if (shipping) await db.Address.create({ customer_id: customerId, type: "ship_to_party", street1: shipping.street1, street2: shipping.street2 || null, city: shipping.city, region: shipping.region, pincode: shipping.pincode, postalCode: shipping.pincode, country: "India" }, { transaction });
}

// A distributor may not smuggle an ownership change into a request body.
function rejectOwnershipTampering(scope, body = {}) {
  if (isAdmin(scope)) return;
  for (const k of ["distributor_id", "distributorId", "distributor_code"]) {
    if (body[k] === undefined || body[k] === null || body[k] === "") continue;
    const same = k === "distributor_code" ? String(body[k]) === String(scope.distributorCode) : Number(body[k]) === Number(scope.distributorId);
    if (!same) throw new RetailerError(403, "FORBIDDEN", "You cannot assign or move retailers to another distributor");
  }
}

async function createRetailer(db, scope, body = {}) {
  rejectOwnershipTampering(scope, body);
  const { values, errors, shipping } = validateInput(body, { partial: false });

  // Owner comes from the session for a distributor; an admin must choose one explicitly.
  let distributorId;
  if (isAdmin(scope)) {
    const n = Number(body.distributor_id ?? body.distributorId);
    if (!Number.isInteger(n) || n <= 0) errors.distributor_id = "Select a distributor";
    else distributorId = n;
  } else distributorId = Number(scope.distributorId);

  let status = "active"; // distributor-created retailers are active; an admin may also create pending / inactive ones
  if (isAdmin(scope) && body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.status = "Status must be active, inactive or pending";
    else status = body.status;
  }
  if (Object.keys(errors).length) throw failValidation(errors);

  const t = await db.sequelize.transaction();
  try {
    const owner = await ownerInfo(db, distributorId, t);
    if (!owner) throw new RetailerError(400, "VALIDATION_FAILED", "The selected distributor does not exist", { distributor_id: "The selected distributor does not exist" });
    if (isAdmin(scope) && owner.status === "inactive") throw new RetailerError(409, "DISTRIBUTOR_INACTIVE", "This distributor is inactive — activate it before assigning new retailers", { distributor_id: "This distributor is inactive" });
    await assertGroupBelongsTo(db, values.customer_group_id, distributorId, t);
    await assertUnique(db, values, distributorId, null, t);
    // customer_code is generated by the model's beforeCreate hook. distributor_id is set last, from the trusted value above.
    const created = await db.Customer.create({ ...values, status, status_changed_at: new Date(), distributor_id: distributorId }, { transaction: t });
    await saveShipping(db, created.id, shipping, t);
    await t.commit();
    return { id: Number(created.id), code: created.customer_code, distributorId, status };
  } catch (err) {
    if (!t.finished) await t.rollback();
    if (err && err.name === "SequelizeUniqueConstraintError") throw new RetailerError(409, "DUPLICATE", "A retailer with this code already exists — please retry");
    throw err;
  }
}

async function updateRetailer(db, scope, rawId, body = {}) {
  rejectOwnershipTampering(scope, body);
  // Ownership can never change through update — even for an admin (reassign() is the only path).
  if (isAdmin(scope) && body.distributor_id !== undefined && body.distributor_id !== null) {
    const t0 = await db.Customer.findOne({ where: { id: q.intId(rawId, "id") }, attributes: ["distributor_id"] });
    if (t0 && Number(body.distributor_id) !== Number(t0.distributor_id)) throw new RetailerError(400, "USE_REASSIGN", "Use “Change distributor” to move a retailer to another distributor");
  }
  const { values, errors, shipping } = validateInput(body, { partial: true });
  if (Object.keys(errors).length) throw failValidation(errors);
  const changes = Object.fromEntries(Object.entries(values).filter(([k]) => EDITABLE.includes(k))); // id, code, distributor_id, status can never be set here

  const t = await db.sequelize.transaction();
  try {
    const c = await loadOwned(db, scope, rawId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) {
      await t.rollback();
      return null;
    }
    if (changes.customer_group_id) await assertGroupBelongsTo(db, changes.customer_group_id, c.distributor_id, t);
    await assertUnique(db, changes, c.distributor_id, c.id, t);
    await c.update(changes, { transaction: t });
    await saveShipping(db, c.id, shipping, t);
    await t.commit();
    return { id: Number(c.id), code: c.customer_code, updated: Object.keys(changes).concat(shipping !== undefined ? ["shipping"] : []) };
  } catch (err) {
    if (!t.finished) await t.rollback();
    throw err;
  }
}

async function setRetailerStatus(db, scope, rawId, body = {}) {
  const next = clean(body.status);
  if (next !== "active" && next !== "inactive") throw new RetailerError(400, "VALIDATION_FAILED", "Status must be active or inactive", { status: "Status must be active or inactive" });
  const reason = clean(body.reason) || null;
  if (reason && reason.length > 255) throw new RetailerError(400, "VALIDATION_FAILED", "Reason must be at most 255 characters", { reason: "Reason must be at most 255 characters" });

  const t = await db.sequelize.transaction();
  try {
    const c = await loadOwned(db, scope, rawId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) {
      await t.rollback();
      return null;
    }
    const current = c.status || "active";
    if (current === next) throw new RetailerError(409, "NO_CHANGE", `Retailer is already ${current}`);
    // Business rule (documented): a PENDING retailer is approved by Admin only.
    if (current === "pending" && !isAdmin(scope)) throw new RetailerError(403, "FORBIDDEN", "Pending retailers can only be activated by an administrator");
    await c.update({ status: next, status_reason: next === "inactive" ? reason : null, status_changed_at: new Date() }, { transaction: t });
    await t.commit();
    return { id: Number(c.id), code: c.customer_code, previousStatus: current, status: next };
  } catch (err) {
    if (!t.finished) await t.rollback();
    throw err;
  }
}

// ADMIN ONLY (the distributor controller has no route to this function). Moves ownership atomically.
async function reassignRetailer(db, scope, rawId, body = {}) {
  if (!isAdmin(scope)) throw forbidden("Only an administrator can change a retailer's distributor");
  const targetId = Number(body.distributor_id ?? body.distributorId);
  const groupId = Number(body.customer_group_id);
  const errors = {};
  if (!Number.isInteger(targetId) || targetId <= 0) errors.distributor_id = "Select a distributor";
  if (!Number.isInteger(groupId) || groupId <= 0) errors.customer_group_id = "Select a customer group of the new distributor";
  if (Object.keys(errors).length) throw failValidation(errors);

  const t = await db.sequelize.transaction();
  try {
    const c = await loadOwned(db, scope, rawId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c) {
      await t.rollback();
      return null;
    }
    if (Number(c.distributor_id) === targetId) throw new RetailerError(409, "NO_CHANGE", "The retailer already belongs to this distributor");
    const target = await ownerInfo(db, targetId, t);
    if (!target) throw new RetailerError(400, "VALIDATION_FAILED", "The selected distributor does not exist", { distributor_id: "The selected distributor does not exist" });
    if (target.status === "inactive") throw new RetailerError(409, "DISTRIBUTOR_INACTIVE", "The selected distributor is inactive", { distributor_id: "This distributor is inactive" });
    await assertGroupBelongsTo(db, groupId, targetId, t);
    await assertUnique(db, { taxNumber: c.taxNumber }, targetId, c.id, t);

    // Safety: an in-flight order or an unsettled balance is tied to the CURRENT distributor's ledger and payment screens. Moving the
    // retailer mid-flight would strand that money, so it is refused (with the reason) until those are completed / settled.
    const tb = tables(db);
    const run = (sql, r) => db.sequelize.query(sql, { replacements: r, type: db.Sequelize.QueryTypes.SELECT, transaction: t });
    const [open] = await run(`SELECT COUNT(*) AS n FROM ${tb.order} WHERE customerId = :cid AND status IN ${OPEN_ORDER_STATUSES}`, { cid: c.id });
    const [inv] = await run(`SELECT COUNT(*) AS n FROM ${tb.invoice} WHERE customer_id = :cid AND status IN ('POSTED','PARTIALLY_PAID') AND COALESCE(outstandingAmount,0) > 0`, { cid: c.id });
    const [bal] = await run(`SELECT COUNT(*) AS n, COALESCE(SUM(j.debit),0) - COALESCE(SUM(j.credit),0) AS outstanding FROM ${tb.journal} j JOIN ${tb.gl} g ON g.id = j.gl_id WHERE g.gl_name = '${AR_GL_NAME}' AND j.customer_id = :cid`, { cid: c.id });
    const blockers = [];
    if (num(open.n) > 0) blockers.push(`${num(open.n)} open order(s)`);
    if (num(inv.n) > 0) blockers.push(`${num(inv.n)} unpaid invoice(s)`);
    if (Math.abs(num(bal.outstanding)) > 0.005) blockers.push(`an outstanding balance of ₹${tax.round2(num(bal.outstanding))}`);
    if (blockers.length) throw new RetailerError(409, "REASSIGN_BLOCKED", `Cannot change distributor while the retailer has ${blockers.join(", ")}. Complete or settle these first.`, { blockers });

    const previousDistributorId = Number(c.distributor_id);
    // Only ownership + its group change. Historical orders / invoices / payments / returns keep their own distributor_id and customer id.
    await c.update({ distributor_id: targetId, customer_group_id: groupId }, { transaction: t });
    await t.commit();
    return { id: Number(c.id), code: c.customer_code, previousDistributorId, distributorId: targetId };
  } catch (err) {
    if (!t.finished) await t.rollback();
    throw err;
  }
}

// Used by the legacy DELETE /customer/:id guard: a retailer with ANY business history must never be hard-deleted.
async function hasBusinessHistory(db, customerId) {
  const t = tables(db);
  const run = runner(db);
  const rows = await Promise.all([
    run(`SELECT COUNT(*) AS n FROM ${t.order} WHERE customerId = :cid`, { cid: customerId }),
    run(`SELECT COUNT(*) AS n FROM ${t.invoice} WHERE customer_id = :cid`, { cid: customerId }),
    run(`SELECT COUNT(*) AS n FROM ${t.ret} WHERE customerId = :cid`, { cid: customerId }),
    run(`SELECT COUNT(*) AS n FROM ${t.journal} WHERE customer_id = :cid`, { cid: customerId }),
  ]);
  return rows.some((r) => num(r[0].n) > 0);
}

module.exports = {
  RetailerError, STATUSES, validateInput, assertGroupBelongsTo, assertUnique, getLookups, listRetailers, getRetailerDetail, createRetailer, updateRetailer, setRetailerStatus, reassignRetailer, hasBusinessHistory,
};
