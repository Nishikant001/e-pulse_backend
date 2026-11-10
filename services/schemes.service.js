// services/schemes.service.js — Phase 10 Admin scheme management (validation + CRUD + list). Admin-only: nothing here is
// reachable from a Distributor route. Products / distributors / retailers are referenced by ID; every reference is verified
// on write. Discount MATHS is not here — it lives in schemeEngine.service.js (single implementation).
const q = require("./salesQuery");

class SchemeError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "SchemeError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new SchemeError(400, "VALIDATION_FAILED", message, details);

const TYPES = ["QUANTITY_FREE", "PERCENT_DISCOUNT", "FIXED_DISCOUNT"];
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
const today = () => new Date().toISOString().slice(0, 10);
const isoDay = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ── effective status: what the engine will actually do today (stored status + validity window) ──
function effectiveStatus(s, asOf = today()) {
  if (s.status !== "active") return "inactive";
  const from = isoDay(s.valid_from);
  const to = isoDay(s.valid_to);
  if (from > asOf) return "scheduled";
  if (to && to < asOf) return "expired";
  return "active";
}

// ── input parsing ──
function intOrNull(v, name, { min = 1, max = 1_000_000 } = {}) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`, { field: name });
  return n;
}
function moneyOrNull(v, name, max = 99_999_999) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw bad(`${name} must be a positive amount`, { field: name });
  return Math.round(n * 100) / 100;
}
function idList(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${name} must be a list of ids`, { field: name });
  if (v.length > 500) throw bad(`${name} has too many entries (max 500)`, { field: name });
  return [...new Set(v.map((x) => q.intId(x, name)).filter(Boolean))];
}
function reqDay(v, name) {
  if (v === undefined || v === null || v === "") return null;
  return q.day(String(v).slice(0, 10), name);
}

/** Whitelist + validate a create/update body → plain values. `existing` (plain row) makes partial updates possible. */
function parseScheme(body, existing = null) {
  if (!body || typeof body !== "object") throw bad("Request body is required");
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const pick = (k, fallback) => (has(k) ? body[k] : fallback);
  const e = existing || {};

  const name = String(pick("name", e.name) ?? "").trim();
  if (!name) throw bad("Scheme name is required", { field: "name" });
  if (name.length > 150) throw bad("Scheme name is too long", { field: "name" });

  let code = has("scheme_code") ? String(body.scheme_code ?? "").trim().toUpperCase() : e.scheme_code || "";
  if (existing && has("scheme_code") && code !== e.scheme_code) throw bad("Scheme code cannot be changed once created", { field: "scheme_code" });
  if (code && !CODE_RE.test(code)) throw bad("Scheme code must be 3–30 characters: letters, digits, '-' or '_'", { field: "scheme_code" });

  const schemeType = pick("scheme_type", e.scheme_type);
  if (!TYPES.includes(schemeType)) throw bad(`Scheme type must be one of ${TYPES.join(", ")}`, { field: "scheme_type" });
  if (existing && schemeType !== e.scheme_type) throw bad("Scheme type cannot be changed once created; create a new scheme instead", { field: "scheme_type" });

  const description = has("description") ? (String(body.description ?? "").trim() || null) : e.description || null;
  if (description && description.length > 500) throw bad("Description is too long", { field: "description" });

  const productScope = pick("product_scope", e.product_scope || "PRODUCTS");
  if (!["PRODUCTS", "CATEGORY"].includes(productScope)) throw bad("product_scope must be PRODUCTS or CATEGORY", { field: "product_scope" });
  const category = productScope === "CATEGORY" ? String(pick("category", e.category) ?? "").trim() || null : null;
  if (productScope === "CATEGORY" && !category) throw bad("Choose a product category", { field: "category" });
  const productIds = productScope === "PRODUCTS" ? idList(pick("product_ids", e.product_ids), "product_ids") : [];
  if (productScope === "PRODUCTS" && productIds.length === 0) throw bad("Select at least one product", { field: "product_ids" });

  const distScope = pick("distributor_scope", e.distributor_scope || "ALL");
  const retScope = pick("retailer_scope", e.retailer_scope || "ALL");
  if (!["ALL", "SPECIFIC"].includes(distScope)) throw bad("distributor_scope must be ALL or SPECIFIC", { field: "distributor_scope" });
  if (!["ALL", "SPECIFIC"].includes(retScope)) throw bad("retailer_scope must be ALL or SPECIFIC", { field: "retailer_scope" });
  const distributorIds = distScope === "SPECIFIC" ? idList(pick("distributor_ids", e.distributor_ids), "distributor_ids") : [];
  const retailerIds = retScope === "SPECIFIC" ? idList(pick("retailer_ids", e.retailer_ids), "retailer_ids") : [];
  if (distScope === "SPECIFIC" && distributorIds.length === 0) throw bad("Select at least one distributor", { field: "distributor_ids" });
  if (retScope === "SPECIFIC" && retailerIds.length === 0) throw bad("Select at least one retailer", { field: "retailer_ids" });

  // rule fields — only those that belong to the chosen type are kept; the others are stored as NULL
  const min = intOrNull(pick("min_quantity", e.min_quantity), "min_quantity");
  const max = intOrNull(pick("max_quantity", e.max_quantity), "max_quantity");
  let rule = { min_quantity: min, max_quantity: max, buy_quantity: null, free_quantity: null, discount_percent: null, discount_amount: null, max_discount: null };
  if (schemeType === "QUANTITY_FREE") {
    rule.buy_quantity = intOrNull(pick("buy_quantity", e.buy_quantity), "buy_quantity");
    rule.free_quantity = intOrNull(pick("free_quantity", e.free_quantity), "free_quantity");
    if (!rule.buy_quantity) throw bad("Buy quantity is required and must be greater than zero", { field: "buy_quantity" });
    if (!rule.free_quantity) throw bad("Free quantity is required and must be greater than zero", { field: "free_quantity" });
    rule.min_quantity = null; // the buy quantity IS the threshold
    if (max && max < rule.buy_quantity) throw bad("Maximum quantity cannot be below the buy quantity", { field: "max_quantity" });
  } else if (schemeType === "PERCENT_DISCOUNT") {
    const p = pick("discount_percent", e.discount_percent);
    const pn = p === undefined || p === null || p === "" ? NaN : Number(p);
    if (!Number.isFinite(pn) || pn <= 0 || pn > 100) throw bad("Discount percentage must be greater than 0 and at most 100", { field: "discount_percent" });
    rule.discount_percent = Math.round(pn * 100) / 100;
    rule.max_discount = moneyOrNull(pick("max_discount", e.max_discount), "max_discount");
  } else {
    rule.discount_amount = moneyOrNull(pick("discount_amount", e.discount_amount), "discount_amount");
    if (!rule.discount_amount) throw bad("Discount amount is required and must be greater than zero", { field: "discount_amount" });
    rule.max_discount = moneyOrNull(pick("max_discount", e.max_discount), "max_discount");
  }
  if (schemeType !== "QUANTITY_FREE" && min && max && max < min) throw bad("Maximum quantity cannot be below the minimum quantity", { field: "max_quantity" });

  const validFrom = reqDay(pick("valid_from", isoDay(e.valid_from)), "valid_from");
  const validTo = reqDay(pick("valid_to", isoDay(e.valid_to)), "valid_to");
  if (!validFrom) throw bad("Valid from date is required", { field: "valid_from" });
  if (validTo && validTo < validFrom) throw bad("Valid to cannot be before valid from", { field: "valid_to" });

  const priority = has("priority") || e.priority !== undefined ? intOrNull(pick("priority", e.priority), "priority", { min: 1, max: 9999 }) : 100;
  const status = pick("status", e.status || "active");
  if (!["active", "inactive"].includes(status)) throw bad("status must be active or inactive", { field: "status" });

  return {
    row: { scheme_code: code, name, description, scheme_type: schemeType, product_scope: productScope, category, distributor_scope: distScope, retailer_scope: retScope, ...rule, valid_from: validFrom, valid_to: validTo, priority: priority || 100, status },
    productIds, distributorIds, retailerIds,
  };
}

/** Verify every referenced id exists and that the applicability is internally consistent (tenant safety). */
async function verifyReferences(db, { row, productIds, distributorIds, retailerIds }, transaction) {
  const { Op } = db.Sequelize;
  let products = [];
  if (productIds.length) {
    products = await db.Product.findAll({ where: { id: { [Op.in]: productIds } }, attributes: ["id", "distributor_id"], transaction });
    if (products.length !== productIds.length) throw bad("One or more selected products do not exist", { field: "product_ids" });
  }
  if (distributorIds.length) {
    const n = await db.Distributor.count({ where: { id: { [Op.in]: distributorIds } }, transaction });
    if (n !== distributorIds.length) throw bad("One or more selected distributors do not exist", { field: "distributor_ids" });
    const wrong = products.filter((p) => !distributorIds.includes(Number(p.distributor_id)));
    if (wrong.length) throw bad("Some selected products belong to a distributor that is not in the applicable distributor list", { field: "product_ids" });
  }
  if (retailerIds.length) {
    const rs = await db.Customer.findAll({ where: { id: { [Op.in]: retailerIds } }, attributes: ["id", "distributor_id"], transaction });
    if (rs.length !== retailerIds.length) throw bad("One or more selected retailers do not exist", { field: "retailer_ids" });
    if (distributorIds.length && rs.some((r) => !distributorIds.includes(Number(r.distributor_id)))) {
      throw bad("Some selected retailers belong to a distributor that is not in the applicable distributor list", { field: "retailer_ids" });
    }
  }
  return row;
}

async function nextCode(db, transaction) {
  const last = await db.Scheme.findOne({ order: [["id", "DESC"]], attributes: ["id"], transaction });
  let n = last ? Number(last.id) + 1 : 1;
  for (let i = 0; i < 50; i += 1, n += 1) {
    const c = `SCH${String(n).padStart(4, "0")}`;
    if (!(await db.Scheme.findOne({ where: { scheme_code: c }, attributes: ["id"], transaction }))) return c;
  }
  throw new SchemeError(500, "CODE_GENERATION_FAILED", "Unable to generate a scheme code");
}

async function replaceLinks(db, schemeId, parsed, transaction) {
  await Promise.all([
    db.SchemeProduct.destroy({ where: { scheme_id: schemeId }, transaction }),
    db.SchemeDistributor.destroy({ where: { scheme_id: schemeId }, transaction }),
    db.SchemeRetailer.destroy({ where: { scheme_id: schemeId }, transaction }),
  ]);
  if (parsed.productIds.length) await db.SchemeProduct.bulkCreate(parsed.productIds.map((product_id) => ({ scheme_id: schemeId, product_id })), { transaction });
  if (parsed.distributorIds.length) await db.SchemeDistributor.bulkCreate(parsed.distributorIds.map((distributor_id) => ({ scheme_id: schemeId, distributor_id })), { transaction });
  if (parsed.retailerIds.length) await db.SchemeRetailer.bulkCreate(parsed.retailerIds.map((customer_id) => ({ scheme_id: schemeId, customer_id })), { transaction });
}

// ── serialisation ──
function ruleSummary(s) {
  if (s.scheme_type === "QUANTITY_FREE") return `Buy ${s.buy_quantity} get ${s.free_quantity} free`;
  if (s.scheme_type === "PERCENT_DISCOUNT") return `${Number(s.discount_percent)}% discount${s.min_quantity ? ` on ${s.min_quantity}+ units` : ""}`;
  return `₹${Number(s.discount_amount)} off${s.min_quantity ? ` on ${s.min_quantity}+ units` : ""}`;
}
function serialize(s, extra = {}) {
  return {
    id: Number(s.id), code: s.scheme_code, name: s.name, description: s.description || null, type: s.scheme_type, ruleSummary: ruleSummary(s),
    productScope: s.product_scope, category: s.category || null, distributorScope: s.distributor_scope, retailerScope: s.retailer_scope,
    minQuantity: s.min_quantity, maxQuantity: s.max_quantity, buyQuantity: s.buy_quantity, freeQuantity: s.free_quantity,
    discountPercent: num(s.discount_percent), discountAmount: num(s.discount_amount), maxDiscount: num(s.max_discount),
    validFrom: isoDay(s.valid_from), validTo: isoDay(s.valid_to), status: s.status, effectiveStatus: effectiveStatus(s), priority: s.priority,
    createdAt: s.createdAt, updatedAt: s.updatedAt, statusChangedAt: s.status_changed_at || null, ...extra,
  };
}

// ── list ──
const SORT = { name: "s.name", code: "s.scheme_code", type: "s.scheme_type", validFrom: "s.valid_from", validTo: "s.valid_to", status: "s.status", priority: "s.priority", createdAt: "s.createdAt" };

async function listSchemes(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, SORT, { key: "createdAt", dir: "desc" });
  const status = q.oneOf(query.status, ["active", "inactive"], "status");
  const type = q.oneOf(query.type, TYPES, "type", (x) => x.toUpperCase());
  const validity = q.oneOf(query.validity, ["current", "upcoming", "expired"], "validity");
  const productId = q.intId(query.productId, "productId");
  const distributorId = q.intId(query.distributorId, "distributorId");
  const search = q.text(query.q, "q");
  const t = (m) => `\`${m.getTableName()}\``;
  const clauses = [];
  const params = { today: today() };
  if (status) { clauses.push("s.status = :status"); params.status = status; }
  if (type) { clauses.push("s.scheme_type = :type"); params.type = type; }
  if (validity === "current") clauses.push("s.valid_from <= :today AND (s.valid_to IS NULL OR s.valid_to >= :today)");
  if (validity === "upcoming") clauses.push("s.valid_from > :today");
  if (validity === "expired") clauses.push("s.valid_to IS NOT NULL AND s.valid_to < :today");
  if (productId) {
    clauses.push(`(EXISTS (SELECT 1 FROM ${t(db.SchemeProduct)} sp WHERE sp.scheme_id = s.id AND sp.product_id = :productId)
      OR (s.product_scope = 'CATEGORY' AND s.category = (SELECT p.category FROM ${t(db.Product)} p WHERE p.id = :productId)))`);
    params.productId = productId;
  }
  if (distributorId) {
    clauses.push(`(s.distributor_scope = 'ALL' OR EXISTS (SELECT 1 FROM ${t(db.SchemeDistributor)} sd WHERE sd.scheme_id = s.id AND sd.distributor_id = :distributorId))`);
    params.distributorId = distributorId;
  }
  if (search) {
    clauses.push("(LOWER(s.name) LIKE :s ESCAPE '!' OR LOWER(s.scheme_code) LIKE :s ESCAPE '!')");
    params.s = q.likeTerm(search);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const run = (sql, r) => db.sequelize.query(sql, { replacements: r, type: db.Sequelize.QueryTypes.SELECT });
  const from = `${t(db.Scheme)} s`;
  const [{ total }] = await run(`SELECT COUNT(*) AS total FROM ${from} ${where}`, params);
  const rows = await run(
    `SELECT s.*,
       (SELECT COUNT(*) FROM ${t(db.SchemeProduct)} sp WHERE sp.scheme_id = s.id) AS product_count,
       (SELECT COUNT(*) FROM ${t(db.SchemeDistributor)} sd WHERE sd.scheme_id = s.id) AS distributor_count,
       (SELECT COUNT(*) FROM ${t(db.SchemeRetailer)} sr WHERE sr.scheme_id = s.id) AS retailer_count
     FROM ${from} ${where} ORDER BY ${sort.column} ${sort.dir}, s.id ASC LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset: (page - 1) * pageSize }
  );
  const items = rows.map((r) => {
      const applicability = [
        r.product_scope === "CATEGORY" ? `Category: ${r.category}` : `${Number(r.product_count)} product(s)`,
        r.distributor_scope === "ALL" ? "All distributors" : `${Number(r.distributor_count)} distributor(s)`,
        r.retailer_scope === "ALL" ? "All retailers" : `${Number(r.retailer_count)} retailer(s)`,
      ];
      return serialize(r, { applicability, productSummary: r.product_scope === "CATEGORY" ? `Category: ${r.category}` : `${Number(r.product_count)} product(s)` });
  });
  return {
    items, rows: items,
    page, pageSize, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
  };
}

// ── detail ──
async function getScheme(db, id) {
  const sid = q.intId(id, "id");
  if (!sid) throw bad("id is required");
  const s = await db.Scheme.findByPk(sid);
  if (!s) return null;
  const { Op } = db.Sequelize;
  const [pl, dl, rl] = await Promise.all([
    db.SchemeProduct.findAll({ where: { scheme_id: sid }, attributes: ["product_id"] }),
    db.SchemeDistributor.findAll({ where: { scheme_id: sid }, attributes: ["distributor_id"] }),
    db.SchemeRetailer.findAll({ where: { scheme_id: sid }, attributes: ["customer_id"] }),
  ]);
  const pids = pl.map((x) => Number(x.product_id));
  const dids = dl.map((x) => Number(x.distributor_id));
  const rids = rl.map((x) => Number(x.customer_id));
  const [products, distributors, retailers] = await Promise.all([
    pids.length ? db.Product.findAll({ where: { id: { [Op.in]: pids } }, attributes: ["id", "name", "material_code", "category", "distributor_id", "status"], order: [["name", "ASC"]] }) : [],
    dids.length ? db.Distributor.findAll({ where: { id: { [Op.in]: dids } }, attributes: ["id", "name", "distributor_code"], order: [["name", "ASC"]] }) : [],
    rids.length ? db.Customer.findAll({ where: { id: { [Op.in]: rids } }, attributes: ["id", "name", "customer_code", "distributor_id"], order: [["name", "ASC"]] }) : [],
  ]);
  return serialize(s, {
    productIds: pids, distributorIds: dids, retailerIds: rids,
    products: products.map((p) => ({ id: Number(p.id), name: p.name, code: p.material_code, category: p.category || null, distributorId: Number(p.distributor_id), status: p.status })),
    distributors: distributors.map((d) => ({ id: Number(d.id), name: d.name, code: d.distributor_code })),
    retailers: retailers.map((r) => ({ id: Number(r.id), name: r.name, code: r.customer_code, distributorId: Number(r.distributor_id) })),
  });
}

// ── create / update / status ──
async function createScheme(db, adminId, body) {
  const parsed = parseScheme(body);
  const t = await db.sequelize.transaction();
  try {
    await verifyReferences(db, parsed, t);
    let code = parsed.row.scheme_code;
    if (!code) code = await nextCode(db, t);
    else if (await db.Scheme.findOne({ where: { scheme_code: code }, attributes: ["id"], transaction: t })) {
      throw new SchemeError(409, "DUPLICATE_CODE", `Scheme code ${code} already exists`, { field: "scheme_code" });
    }
    const created = await db.Scheme.create({ ...parsed.row, scheme_code: code, created_by_admin_id: adminId || null, updated_by_admin_id: adminId || null, status_changed_at: new Date() }, { transaction: t });
    await replaceLinks(db, created.id, parsed, t);
    await t.commit();
    return getScheme(db, created.id);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function updateScheme(db, adminId, id, body) {
  const sid = q.intId(id, "id");
  const existing = await db.Scheme.findByPk(sid);
  if (!existing) return null;
  const detail = await getScheme(db, sid);
  const plain = { ...existing.get({ plain: true }), product_ids: detail.productIds, distributor_ids: detail.distributorIds, retailer_ids: detail.retailerIds };
  // Editing changes FUTURE evaluations only: nothing has been persisted into orders/invoices by this phase, and any later
  // transaction must store its own snapshot, so history is never recalculated from an edited scheme.
  const parsed = parseScheme(body, plain);
  const t = await db.sequelize.transaction();
  try {
    await verifyReferences(db, parsed, t);
    const changed = Object.keys(parsed.row).filter((k) => String(parsed.row[k] ?? "") !== String(k === "valid_from" || k === "valid_to" ? isoDay(existing[k]) ?? "" : existing[k] ?? ""));
    await existing.update({ ...parsed.row, scheme_code: existing.scheme_code, updated_by_admin_id: adminId || null, ...(parsed.row.status !== existing.status ? { status_changed_at: new Date() } : {}) }, { transaction: t });
    await replaceLinks(db, sid, parsed, t);
    await t.commit();
    return { ...(await getScheme(db, sid)), updated: changed };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function setSchemeStatus(db, adminId, id, body) {
  const sid = q.intId(id, "id");
  const s = await db.Scheme.findByPk(sid);
  if (!s) return null;
  const status = body && body.status;
  if (!["active", "inactive"].includes(status)) throw bad("status must be active or inactive", { field: "status" });
  const previous = s.status;
  if (previous !== status) await s.update({ status, status_changed_at: new Date(), updated_by_admin_id: adminId || null });
  return { ...(await getScheme(db, sid)), previousStatus: previous };
}

// ── lookups (Admin form / filters) ──
async function getLookups(db, query = {}) {
  const run = (sql, r = {}) => db.sequelize.query(sql, { replacements: r, type: db.Sequelize.QueryTypes.SELECT });
  const t = (m) => `\`${m.getTableName()}\``;
  const distributorId = q.intId(query.distributorId, "distributorId");
  const search = q.text(query.q, "q");
  const pw = [];
  const params = {};
  if (distributorId) { pw.push("p.distributor_id = :d"); params.d = distributorId; }
  if (search) { pw.push("(LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!')"); params.s = q.likeTerm(search); }
  const rw = distributorId ? "WHERE c.distributor_id = :d" : "";
  const [distributors, categories, products, retailers] = await Promise.all([
    run(`SELECT id, name, distributor_code AS code FROM ${t(db.Distributor)} ORDER BY name ASC LIMIT 1000`),
    run(`SELECT DISTINCT p.category AS category FROM ${t(db.Product)} p WHERE p.category IS NOT NULL AND TRIM(p.category) <> '' ORDER BY category ASC LIMIT 200`),
    run(`SELECT p.id, p.name, p.material_code AS code, p.category, p.distributor_id FROM ${t(db.Product)} p ${pw.length ? `WHERE ${pw.join(" AND ")}` : ""} ORDER BY p.name ASC LIMIT 300`, params),
    run(`SELECT c.id, c.name, c.customer_code AS code, c.distributor_id FROM ${t(db.Customer)} c ${rw} ORDER BY c.name ASC LIMIT 300`, distributorId ? { d: distributorId } : {}),
  ]);
  return {
    types: [
      { value: "QUANTITY_FREE", label: "Quantity (Buy X get Y free)" },
      { value: "PERCENT_DISCOUNT", label: "Percentage discount" },
      { value: "FIXED_DISCOUNT", label: "Fixed discount amount" },
    ],
    distributors: distributors.map((d) => ({ id: Number(d.id), name: d.name, code: d.code })),
    categories: categories.map((c) => c.category),
    products: products.map((p) => ({ id: Number(p.id), name: p.name, code: p.code, category: p.category || null, distributorId: Number(p.distributor_id) })),
    retailers: retailers.map((r) => ({ id: Number(r.id), name: r.name, code: r.code, distributorId: Number(r.distributor_id) })),
  };
}

module.exports = { SchemeError, effectiveStatus, ruleSummary, serialize, listSchemes, getScheme, createScheme, updateScheme, setSchemeStatus, getLookups, TYPES };
