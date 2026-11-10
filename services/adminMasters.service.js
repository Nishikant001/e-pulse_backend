// services/adminMasters.service.js
//
// Phase 7 — Product / Batch / Pricing / Tax Masters (Admin portal). READ-ONLY, cross-distributor queries behind
// the Admin Masters screens, in the SAME shape as services/adminSales.service.js: everything is raw SQL, every
// value is bound as a named replacement, sort columns come from whitelists, LIKE terms are escaped, and
// pagination/search/sort never happen in the browser. Nothing here recomputes tax or pricing — those stay in
// tax.service.js / pricing.service.js (see getTaxDetail / getPricingDetail below, which call into them).
//
// Writes are NOT here: the Admin API reuses the EXISTING, tenant-scoped Distributor controllers (product / batch /
// pricingmaster / hsngroup) through services/distributorContext.js, exactly like services/adminSalesOrder.service.js
// already does for Sales Orders — see controllers/admin.masters.controller.js. This file only resolves which
// distributor owns a given master record so that write flow knows which tenant to impersonate.
const q = require("./salesQuery");
const tax = require("./tax.service");

const CATEGORY = "COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorised')";

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => (v === null || v === undefined ? null : tax.round2(num(v)));
const isoDay = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

function tables(db) {
  const t = (m) => `\`${m.getTableName()}\``;
  return {
    product: t(db.Product), batch: t(db.Batch), distributor: t(db.Distributor), hsn: t(db.HSNGroup),
    pricing: t(db.PricingMaster), customerGroup: t(db.CustomerGroup),
  };
}
const runner = (db) => (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

function where() {
  const clauses = [];
  const params = {};
  return {
    params,
    add(sql, p = {}) {
      clauses.push(sql);
      Object.assign(params, p);
    },
    sql: (prefix = "WHERE") => (clauses.length ? `${prefix} ${clauses.join(" AND ")}` : ""),
  };
}

async function paginate(run, { baseFrom, baseWhere, params, selectCols, sort, page, pageSize }) {
  const [{ total }] = await run(`SELECT COUNT(*) AS total FROM ${baseFrom} ${baseWhere}`, params);
  const rows = await run(
    `SELECT ${selectCols} FROM ${baseFrom} ${baseWhere} ORDER BY ${sort.column} ${sort.dir}, x_id ASC LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset: (page - 1) * pageSize }
  );
  return { rows, total: num(total) };
}

// ══════════════════════════════════ lookups ══════════════════════════════════

async function getMastersLookups(db, { distributorId } = {}) {
  const t = tables(db);
  const run = runner(db);
  const scoped = distributorId != null;
  const dist = scoped ? { d: Number(distributorId) } : {};
  // Distributors are ALWAYS returned (even when a distributor filter is active) — the Add/Edit modals on every Masters
  // screen build their Distributor dropdown from this list. Products = active products only, for the Batch / Pricing pickers
  // (not paginated, so a distributor with >100 products is never silently truncated).
  const [distributors, categories, hsnOptions, customerGroups, products] = await Promise.all([
    run(`SELECT id, name, distributor_code AS code FROM ${t.distributor} ORDER BY name ASC LIMIT 1000`),
    run(`SELECT DISTINCT ${CATEGORY} AS category FROM ${t.product} p ${scoped ? "WHERE p.distributor_id = :d" : ""} ORDER BY category ASC LIMIT 200`, dist),
    run(
      `SELECT h.id, h.hsn_code, h.description, h.gst_rate, h.distributor_id FROM ${t.hsn} h ${scoped ? "WHERE h.distributor_id = :d" : ""} ORDER BY h.hsn_code ASC LIMIT 1000`,
      dist
    ),
    run(
      `SELECT g.id, g.code, g.name, g.distributor_id FROM ${t.customerGroup} g ${scoped ? "WHERE g.distributor_id = :d" : ""} ORDER BY g.name ASC LIMIT 1000`,
      dist
    ),
    run(
      `SELECT p.id, p.name, p.material_code AS sku, p.distributor_id FROM ${t.product} p WHERE p.status = 'active' ${scoped ? "AND p.distributor_id = :d" : ""} ORDER BY p.name ASC LIMIT 5000`,
      dist
    ),
  ]);
  return {
    products: products.map((p) => ({ id: Number(p.id), name: p.name, sku: p.sku, distributorId: Number(p.distributor_id) })),
    distributors: distributors.map((d) => ({ id: Number(d.id), name: d.name, code: d.code })),
    categories: categories.map((c) => c.category),
    hsnOptions: hsnOptions.map((h) => ({ id: Number(h.id), hsnCode: h.hsn_code, description: h.description, gstRate: num(h.gst_rate), distributorId: Number(h.distributor_id) })),
    customerGroups: customerGroups.map((g) => ({ id: Number(g.id), code: g.code, name: g.name, distributorId: Number(g.distributor_id) })),
    dosageForms: ["Tablet", "Capsule", "Syrup", "Injection", "Ointment", "Drops", "Powder", "Inhaler", "Cream", "Suspension"],
  };
}

// ══════════════════════════════════ Product Master ══════════════════════════════════

const PRODUCT_SORT = {
  name: "p.name", material_code: "p.material_code", category: "p.category", mrp: "p.mrp",
  sale_price: "p.sale_price", status: "p.status", createdAt: "p.createdAt",
};

async function listProducts(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, PRODUCT_SORT, { key: "name", dir: "asc" });
  const distributorId = q.intId(query.distributorId, "distributorId");
  const category = q.text(query.category, "category");
  const status = q.oneOf(query.status, ["active", "inactive"], "status");
  const hsnId = q.intId(query.hsnId, "hsnId");
  const search = q.text(query.q, "q");

  const t = tables(db);
  const run = runner(db);
  const w = where();
  if (distributorId) w.add("p.distributor_id = :distributorId", { distributorId });
  if (category) w.add(`${CATEGORY} = :category`, { category });
  if (status) w.add("p.status = :status", { status });
  if (hsnId) w.add("p.hsn_id = :hsnId", { hsnId });
  if (search) {
    w.add(
      "(LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!' OR LOWER(COALESCE(p.generic_name,'')) LIKE :s ESCAPE '!' OR LOWER(COALESCE(p.brand,'')) LIKE :s ESCAPE '!')",
      { s: q.likeTerm(search) }
    );
  }

  const baseFrom = `${t.product} p LEFT JOIN ${t.distributor} d ON d.id = p.distributor_id LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id
     LEFT JOIN (SELECT productId, COUNT(*) AS cnt FROM ${t.batch} GROUP BY productId) bc ON bc.productId = p.id`;
  const { rows, total } = await paginate(run, {
    baseFrom,
    baseWhere: w.sql(),
    params: w.params,
    selectCols: `p.id AS x_id, p.id, p.material_code AS sku, p.name, p.generic_name, p.brand, p.category, p.dosage_form, p.strength, p.pack_size,
                 p.unit, p.mfg_by AS manufacturer, p.mrp, p.sale_price, p.gst, p.cgst, p.sgst, p.igst, p.status, p.reorder_level, p.createdAt,
                 d.id AS distributor_id, d.name AS distributor_name, d.distributor_code, h.hsn_code, h.gst_rate AS hsn_gst_rate,
                 COALESCE(bc.cnt, 0) AS batch_count`,
    sort,
    page,
    pageSize,
  });

  return {
    items: rows.map((r) => ({
      id: Number(r.id), sku: r.sku, name: r.name, genericName: r.generic_name || null, brand: r.brand || null,
      category: r.category || "Uncategorised", dosageForm: r.dosage_form || null, strength: r.strength || null,
      packSize: r.pack_size || null, unit: r.unit || null, manufacturer: r.manufacturer || null,
      mrp: money(r.mrp), salePrice: money(r.sale_price),
      gstRate: r.gst !== null && r.gst !== undefined ? num(r.gst) : r.hsn_gst_rate !== null ? num(r.hsn_gst_rate) : null,
      hsnCode: r.hsn_code || null, status: r.status, reorderLevel: num(r.reorder_level), batchCount: num(r.batch_count),
      distributor: { id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code },
      createdAt: r.createdAt,
    })),
    total, page, pageSize,
  };
}

async function getProductDetail(db, id) {
  const productId = q.intId(id, "product id");
  if (!productId) throw new q.QueryError("product id is required");
  const t = tables(db);
  const run = runner(db);
  const [head] = await run(
    `SELECT p.*, d.name AS distributor_name, d.distributor_code, h.hsn_code, h.gst_rate AS hsn_gst_rate, h.description AS hsn_description
     FROM ${t.product} p LEFT JOIN ${t.distributor} d ON d.id = p.distributor_id LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id
     WHERE p.id = :productId`,
    { productId }
  );
  if (!head) return null;

  const [batches, pricing] = await Promise.all([
    run(
      `SELECT id, batch_no, mfg_date, exp_date, mrp, purchase_price, status FROM ${t.batch}
       WHERE productId = :productId ORDER BY exp_date ASC LIMIT 200`,
      { productId }
    ),
    run(
      `SELECT pm.id, pm.customer_group_id, g.name AS group_name, pm.base_price, pm.discount_percent, pm.valid_from, pm.valid_to
       FROM ${t.pricing} pm LEFT JOIN ${t.customerGroup} g ON g.id = pm.customer_group_id
       WHERE pm.productId = :productId ORDER BY pm.valid_from DESC LIMIT 200`,
      { productId }
    ),
  ]);

  const split = tax.splitGstRate(head.gst !== null && head.gst !== undefined ? head.gst : head.hsn_gst_rate);

  return {
    id: Number(head.id), sku: head.material_code, name: head.name, description: head.description || null,
    genericName: head.generic_name || null, brand: head.brand || null, category: head.category || "Uncategorised",
    dosageForm: head.dosage_form || null, strength: head.strength || null, packSize: head.pack_size || null,
    unit: head.unit || null, manufacturer: head.mfg_by || null, plant: head.plant || null,
    drugLicenceNumber: head.drug_licence_number || null, countryOfOrigin: head.country_of_origin || null,
    mrp: money(head.mrp), salePrice: money(head.sale_price), reorderLevel: num(head.reorder_level), status: head.status,
    hsn: head.hsn_id ? { id: Number(head.hsn_id), code: head.hsn_code, description: head.hsn_description, gstRate: num(head.hsn_gst_rate) } : null,
    gst: { rate: split.gstRate, cgstRate: split.cgstRate, sgstRate: split.sgstRate, igstRate: split.igstRate },
    distributor: { id: Number(head.distributor_id), name: head.distributor_name, code: head.distributor_code },
    batches: batches.map((b) => ({
      id: Number(b.id), batchNo: b.batch_no, mfgDate: isoDay(b.mfg_date), expDate: isoDay(b.exp_date),
      mrp: money(b.mrp), purchasePrice: money(b.purchase_price), status: b.status,
    })),
    pricing: pricing.map((p) => ({
      id: Number(p.id), customerGroup: { id: Number(p.customer_group_id), name: p.group_name },
      basePrice: money(p.base_price), discountPercent: num(p.discount_percent),
      validFrom: isoDay(p.valid_from), validTo: isoDay(p.valid_to),
      active: !p.valid_to || new Date(p.valid_to) >= new Date(),
    })),
    createdAt: head.createdAt, updatedAt: head.updatedAt,
  };
}

async function resolveProductDistributor(db, id) {
  const row = await db.Product.findOne({ where: { id }, attributes: ["id", "distributor_id"] });
  if (!row) throw Object.assign(new q.QueryError("Product not found"), { statusCode: 404 });
  return Number(row.distributor_id);
}

// ══════════════════════════════════ Batch Master ══════════════════════════════════

const BATCH_SORT = {
  batch_no: "b.batch_no", exp_date: "b.exp_date", mfg_date: "b.mfg_date", mrp: "b.mrp",
  status: "b.status", product: "p.name", createdAt: "b.createdAt",
};

async function listBatches(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, BATCH_SORT, { key: "exp_date", dir: "asc" });
  const distributorId = q.intId(query.distributorId, "distributorId");
  const productId = q.intId(query.productId, "productId");
  const status = q.oneOf(query.status, ["active", "inactive"], "status");
  const search = q.text(query.q, "q");

  const t = tables(db);
  const run = runner(db);
  const w = where();
  if (distributorId) w.add("b.distributor_id = :distributorId", { distributorId });
  if (productId) w.add("b.productId = :productId", { productId });
  if (status) w.add("b.status = :status", { status });
  if (search) {
    w.add(
      "(LOWER(b.batch_no) LIKE :s ESCAPE '!' OR LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!')",
      { s: q.likeTerm(search) }
    );
  }

  const baseFrom = `${t.batch} b JOIN ${t.product} p ON p.id = b.productId LEFT JOIN ${t.distributor} d ON d.id = b.distributor_id`;
  const { rows, total } = await paginate(run, {
    baseFrom,
    baseWhere: w.sql(),
    params: w.params,
    selectCols: `b.id AS x_id, b.id, b.batch_no, b.mfg_date, b.exp_date, b.mrp, b.purchase_price, b.status, b.createdAt,
                 p.id AS product_id, p.name AS product_name, p.material_code AS sku, p.category,
                 d.id AS distributor_id, d.name AS distributor_name, d.distributor_code`,
    sort,
    page,
    pageSize,
  });

  const now = new Date();
  return {
    items: rows.map((r) => {
      const expired = r.exp_date ? new Date(r.exp_date) < now : false;
      return {
        id: Number(r.id), batchNo: r.batch_no, mfgDate: isoDay(r.mfg_date), expDate: isoDay(r.exp_date),
        mrp: money(r.mrp), purchasePrice: money(r.purchase_price), status: r.status, expired,
        product: { id: Number(r.product_id), name: r.product_name, sku: r.sku, category: r.category || "Uncategorised" },
        distributor: { id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code },
        createdAt: r.createdAt,
      };
    }),
    total, page, pageSize,
  };
}

async function resolveBatchDistributor(db, id) {
  const row = await db.Batch.findOne({ where: { id }, attributes: ["id", "distributor_id", "productId"] });
  if (!row) throw Object.assign(new q.QueryError("Batch not found"), { statusCode: 404 });
  return { distributorId: Number(row.distributor_id), productId: Number(row.productId) };
}

// ══════════════════════════════════ Pricing Master ══════════════════════════════════

const PRICING_SORT = {
  product: "p.name", customerGroup: "g.name", base_price: "pm.base_price",
  valid_from: "pm.valid_from", valid_to: "pm.valid_to", createdAt: "pm.createdAt",
};

async function listPricing(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, PRICING_SORT, { key: "createdAt", dir: "desc" });
  const distributorId = q.intId(query.distributorId, "distributorId");
  const productId = q.intId(query.productId, "productId");
  const customerGroupId = q.intId(query.customerGroupId, "customerGroupId");
  const search = q.text(query.q, "q");
  const activeOnly = query.status === "active";
  const inactiveOnly = query.status === "inactive";

  const t = tables(db);
  const run = runner(db);
  const w = where();
  if (distributorId) w.add("pm.distributor_id = :distributorId", { distributorId });
  if (productId) w.add("pm.productId = :productId", { productId });
  if (customerGroupId) w.add("pm.customer_group_id = :customerGroupId", { customerGroupId });
  if (search) w.add("(LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!')", { s: q.likeTerm(search) });
  if (activeOnly) w.add("(pm.valid_to IS NULL OR pm.valid_to >= :now)", { now: new Date() });
  if (inactiveOnly) w.add("pm.valid_to IS NOT NULL AND pm.valid_to < :now", { now: new Date() });

  const baseFrom = `${t.pricing} pm JOIN ${t.product} p ON p.id = pm.productId LEFT JOIN ${t.customerGroup} g ON g.id = pm.customer_group_id
     LEFT JOIN ${t.distributor} d ON d.id = pm.distributor_id`;
  const { rows, total } = await paginate(run, {
    baseFrom,
    baseWhere: w.sql(),
    params: w.params,
    selectCols: `pm.id AS x_id, pm.id, pm.base_price, pm.discount_percent, pm.valid_from, pm.valid_to, pm.createdAt,
                 p.id AS product_id, p.name AS product_name, p.material_code AS sku,
                 g.id AS group_id, g.name AS group_name, g.code AS group_code,
                 d.id AS distributor_id, d.name AS distributor_name, d.distributor_code`,
    sort,
    page,
    pageSize,
  });

  const now = new Date();
  return {
    items: rows.map((r) => {
      const active = !r.valid_to || new Date(r.valid_to) >= now;
      const unitPrice = money(num(r.base_price) - (num(r.base_price) * num(r.discount_percent)) / 100);
      return {
        id: Number(r.id), basePrice: money(r.base_price), discountPercent: num(r.discount_percent), unitPrice,
        validFrom: isoDay(r.valid_from), validTo: isoDay(r.valid_to), active,
        product: { id: Number(r.product_id), name: r.product_name, sku: r.sku },
        customerGroup: { id: Number(r.group_id), name: r.group_name, code: r.group_code },
        distributor: { id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code },
        createdAt: r.createdAt,
      };
    }),
    total, page, pageSize,
  };
}

async function getPricingDetail(db, id) {
  const pricingId = q.intId(id, "pricing id");
  if (!pricingId) throw new q.QueryError("pricing id is required");
  const t = tables(db);
  const run = runner(db);
  const [head] = await run(
    `SELECT pm.*, p.name AS product_name, p.material_code AS sku, g.name AS group_name, g.code AS group_code,
            d.name AS distributor_name, d.distributor_code
     FROM ${t.pricing} pm JOIN ${t.product} p ON p.id = pm.productId LEFT JOIN ${t.customerGroup} g ON g.id = pm.customer_group_id
     LEFT JOIN ${t.distributor} d ON d.id = pm.distributor_id WHERE pm.id = :pricingId`,
    { pricingId }
  );
  if (!head) return null;

  // "Price history": PricingMaster has a hard unique index on (productId, customer_group_id, distributor_id) —
  // see models/pricingmaster.model.js — so only ONE row can ever exist per combination; editing a price updates
  // that row in place rather than superseding it. This query therefore always returns exactly the current row
  // (never more), which is the accurate answer given the existing schema — see docs, known limitations.
  const history = await run(
    `SELECT id, base_price, discount_percent, valid_from, valid_to FROM ${t.pricing}
     WHERE productId = :productId AND customer_group_id = :groupId AND distributor_id = :distId
     ORDER BY valid_from DESC LIMIT 100`,
    { productId: head.productId, groupId: head.customer_group_id, distId: head.distributor_id }
  );

  const now = new Date();
  return {
    id: Number(head.id), basePrice: money(head.base_price), discountPercent: num(head.discount_percent),
    unitPrice: money(num(head.base_price) - (num(head.base_price) * num(head.discount_percent)) / 100),
    validFrom: isoDay(head.valid_from), validTo: isoDay(head.valid_to), active: !head.valid_to || new Date(head.valid_to) >= now,
    product: { id: Number(head.productId), name: head.product_name, sku: head.sku },
    customerGroup: { id: Number(head.customer_group_id), name: head.group_name, code: head.group_code },
    distributor: { id: Number(head.distributor_id), name: head.distributor_name, code: head.distributor_code },
    history: history.map((h) => ({
      id: Number(h.id), basePrice: money(h.base_price), discountPercent: num(h.discount_percent),
      validFrom: isoDay(h.valid_from), validTo: isoDay(h.valid_to), current: Number(h.id) === Number(head.id),
    })),
  };
}

async function resolvePricingDistributor(db, id) {
  const row = await db.PricingMaster.findOne({ where: { id }, attributes: ["id", "distributor_id"] });
  if (!row) throw Object.assign(new q.QueryError("Pricing record not found"), { statusCode: 404 });
  return Number(row.distributor_id);
}

// ══════════════════════════════════ Tax Master (HSN) ══════════════════════════════════

const TAX_SORT = { hsn_code: "h.hsn_code", gst_rate: "h.gst_rate", createdAt: "h.createdAt" };

async function listTaxes(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, TAX_SORT, { key: "hsn_code", dir: "asc" });
  const distributorId = q.intId(query.distributorId, "distributorId");
  const search = q.text(query.q, "q");

  const t = tables(db);
  const run = runner(db);
  const w = where();
  if (distributorId) w.add("h.distributor_id = :distributorId", { distributorId });
  if (search) w.add("(LOWER(h.hsn_code) LIKE :s ESCAPE '!' OR LOWER(h.description) LIKE :s ESCAPE '!')", { s: q.likeTerm(search) });

  const baseFrom = `${t.hsn} h LEFT JOIN ${t.distributor} d ON d.id = h.distributor_id
     LEFT JOIN (SELECT hsn_id, COUNT(*) AS cnt FROM ${t.product} GROUP BY hsn_id) pc ON pc.hsn_id = h.id`;
  const { rows, total } = await paginate(run, {
    baseFrom,
    baseWhere: w.sql(),
    params: w.params,
    selectCols: `h.id AS x_id, h.id, h.hsn_code, h.description, h.gst_rate, h.createdAt,
                 d.id AS distributor_id, d.name AS distributor_name, d.distributor_code, COALESCE(pc.cnt, 0) AS product_count`,
    sort,
    page,
    pageSize,
  });

  return {
    items: rows.map((r) => {
      const split = tax.splitGstRate(r.gst_rate);
      return {
        id: Number(r.id), hsnCode: r.hsn_code, description: r.description, gstRate: split.gstRate,
        cgstRate: split.cgstRate, sgstRate: split.sgstRate, igstRate: split.igstRate, productCount: num(r.product_count),
        distributor: { id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code },
        createdAt: r.createdAt,
      };
    }),
    total, page, pageSize,
  };
}

async function getTaxDetail(db, id) {
  const hsnId = q.intId(id, "tax id");
  if (!hsnId) throw new q.QueryError("tax id is required");
  const t = tables(db);
  const run = runner(db);
  const [head] = await run(
    `SELECT h.*, d.name AS distributor_name, d.distributor_code FROM ${t.hsn} h LEFT JOIN ${t.distributor} d ON d.id = h.distributor_id
     WHERE h.id = :hsnId`,
    { hsnId }
  );
  if (!head) return null;
  const products = await run(
    `SELECT id, name, material_code AS sku, status FROM ${t.product} WHERE hsn_id = :hsnId ORDER BY name ASC LIMIT 200`,
    { hsnId }
  );
  const split = tax.splitGstRate(head.gst_rate);
  return {
    id: Number(head.id), hsnCode: head.hsn_code, description: head.description, gstRate: split.gstRate,
    cgstRate: split.cgstRate, sgstRate: split.sgstRate, igstRate: split.igstRate,
    distributor: { id: Number(head.distributor_id), name: head.distributor_name, code: head.distributor_code },
    products: products.map((p) => ({ id: Number(p.id), name: p.name, sku: p.sku, status: p.status })),
    createdAt: head.createdAt, updatedAt: head.updatedAt,
  };
}

async function resolveTaxDistributor(db, id) {
  const row = await db.HSNGroup.findOne({ where: { id }, attributes: ["id", "distributor_id"] });
  if (!row) throw Object.assign(new q.QueryError("Tax (HSN) record not found"), { statusCode: 404 });
  return Number(row.distributor_id);
}

// ══════════════════════════════════ Customer Group Master ══════════════════════════════════

const GROUP_SORT = { code: "g.code", name: "g.name", createdAt: "g.createdAt" };

async function listCustomerGroups(db, query) {
  const { page, pageSize } = q.paging(query, { defaultSize: 25, maxSize: 100 });
  const sort = q.sorting(query, GROUP_SORT, { key: "code", dir: "asc" });
  const distributorId = q.intId(query.distributorId, "distributorId");
  const search = q.text(query.q, "q");

  const t = tables(db);
  const run = runner(db);
  const w = where();
  if (distributorId) w.add("g.distributor_id = :distributorId", { distributorId });
  if (search) w.add("(LOWER(g.code) LIKE :s ESCAPE '!' OR LOWER(g.name) LIKE :s ESCAPE '!')", { s: q.likeTerm(search) });

  const customerTable = `\`${db.Customer.getTableName()}\``;
  const baseFrom = `${t.customerGroup} g LEFT JOIN ${t.distributor} d ON d.id = g.distributor_id
     LEFT JOIN (SELECT customer_group_id, COUNT(*) AS cnt FROM ${customerTable} GROUP BY customer_group_id) cc ON cc.customer_group_id = g.id
     LEFT JOIN (SELECT customer_group_id, COUNT(*) AS cnt FROM ${t.pricing} GROUP BY customer_group_id) pc ON pc.customer_group_id = g.id`;
  const { rows, total } = await paginate(run, {
    baseFrom,
    baseWhere: w.sql(),
    params: w.params,
    selectCols: `g.id AS x_id, g.id, g.code, g.name, g.createdAt,
                 d.id AS distributor_id, d.name AS distributor_name, d.distributor_code,
                 COALESCE(cc.cnt, 0) AS customer_count, COALESCE(pc.cnt, 0) AS pricing_count`,
    sort,
    page,
    pageSize,
  });

  return {
    items: rows.map((r) => ({
      id: Number(r.id), code: r.code, name: r.name, customerCount: num(r.customer_count), pricingCount: num(r.pricing_count),
      distributor: { id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code },
      createdAt: r.createdAt,
    })),
    total, page, pageSize,
  };
}

async function getCustomerGroupDetail(db, id) {
  const groupId = q.intId(id, "customer group id");
  if (!groupId) throw new q.QueryError("customer group id is required");
  const t = tables(db);
  const run = runner(db);
  const [head] = await run(
    `SELECT g.*, d.name AS distributor_name, d.distributor_code FROM ${t.customerGroup} g LEFT JOIN ${t.distributor} d ON d.id = g.distributor_id
     WHERE g.id = :groupId`,
    { groupId }
  );
  if (!head) return null;
  const customerTable = `\`${db.Customer.getTableName()}\``;
  const customers = await run(`SELECT id, name FROM ${customerTable} WHERE customer_group_id = :groupId ORDER BY name ASC LIMIT 200`, { groupId });
  return {
    id: Number(head.id), code: head.code, name: head.name,
    distributor: { id: Number(head.distributor_id), name: head.distributor_name, code: head.distributor_code },
    customers: customers.map((c) => ({ id: Number(c.id), name: c.name })),
    createdAt: head.createdAt, updatedAt: head.updatedAt,
  };
}

async function resolveCustomerGroupDistributor(db, id) {
  const row = await db.CustomerGroup.findOne({ where: { id }, attributes: ["id", "distributor_id"] });
  if (!row) throw Object.assign(new q.QueryError("Customer group not found"), { statusCode: 404 });
  return Number(row.distributor_id);
}

module.exports = {
  getMastersLookups,
  listCustomerGroups, getCustomerGroupDetail, resolveCustomerGroupDistributor,
  listProducts, getProductDetail, resolveProductDistributor,
  listBatches, resolveBatchDistributor,
  listPricing, getPricingDetail, resolvePricingDistributor,
  listTaxes, getTaxDetail, resolveTaxDistributor,
};
