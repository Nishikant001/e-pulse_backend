// services/inventoryQuery.service.js
//
// READ-ONLY queries behind the Inventory screens: Current Stock, Batch Stock, Batch detail, Stock Ledger, Stock Movement and
// the summary KPIs. Nothing here writes and nothing here keeps a counter: every quantity is DERIVED from StockLedger — the same
// source of truth inventory.service uses — so there is no second inventory engine.
//
// Tenancy: every function takes `scope = { distributorId }`. The Distributor API always passes its own id (taken from the
// verified session, never from the request); the Admin API passes the optional `distributorId` filter (Admin sees all tenants).
// A row of another tenant can therefore never be returned by changing an id: every table access is constrained by the scope.
//
// All filtering, searching, sorting and pagination happen in SQL. Values are bound as named replacements; sort columns come
// from whitelists; LIKE terms are escaped. SQL is portable (MySQL + SQLite).
const rules = require("./inventoryRules.service");
const q = require("./salesQuery");
// Read-only lookup only (getDispatchWarehouseId issues a single SELECT, never writes) — reused here so "which
// warehouse does a plain sale draw from" is answered in exactly one place, not reimplemented for batch detail's
// FEFO-priority calculation (Phase 6, item 20).
const { getDispatchWarehouseId } = require("./inventory.service");

const SIGNED = "CASE WHEN l.movement_type = 'OUT' THEN -l.quantity ELSE l.quantity END";
const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => Math.round(num(v) * 100) / 100;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const isoDay = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const NOT_FOUND = (m) => Object.assign(new q.QueryError(m), { statusCode: 404, code: "NOT_FOUND" });

function tables(db) {
  const t = (m) => `\`${m.getTableName()}\``;
  return {
    ledger: t(db.StockLedger), batch: t(db.Batch), product: t(db.Product), distributor: t(db.Distributor), warehouse: t(db.Warehouse),
    hsn: t(db.HSNGroup), salesReturn: t(db.SalesReturn), purchaseReturn: t(db.PurchaseReturn), orderLine: t(db.SalesOrderLine),
    order: t(db.SalesOrderHeader), deliveryLine: t(db.SalesDeliveryLine), delivery: t(db.SalesDeliveryHeader), transfer: t(db.StockTransfer),
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

const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
const dayEndExclusive = (s) => new Date(dayStart(s).getTime() + DAY_MS);
const clock = (now = new Date()) => ({
  now,
  near: rules.expiryLimit(now, rules.getNearExpiryDays()),
  // Phase 6 — the same 30/60/90-day cutoffs as rules.expiryBucket(), as bind-able Date values for SQL WHERE clauses.
  critD: rules.expiryLimit(now, rules.EXPIRY_BUCKET_THRESHOLDS_DAYS.critical),
  highD: rules.expiryLimit(now, rules.EXPIRY_BUCKET_THRESHOLDS_DAYS.high),
  medD: rules.expiryLimit(now, rules.EXPIRY_BUCKET_THRESHOLDS_DAYS.medium),
});

// SQL for one expiry bucket, matching rules.expiryBucket() exactly (parity asserted in tests). Requires the clock() bind
// params (:now, :critD, :highD, :medD) to be present on the query.
function bucketPredicate(bucket) {
  switch (bucket) {
    case "expired": return "(x.exp_date IS NOT NULL AND x.exp_date < :now)";
    case "critical": return "(x.exp_date IS NOT NULL AND x.exp_date >= :now AND x.exp_date < :critD)";
    case "high": return "(x.exp_date IS NOT NULL AND x.exp_date >= :critD AND x.exp_date < :highD)";
    case "medium": return "(x.exp_date IS NOT NULL AND x.exp_date >= :highD AND x.exp_date < :medD)";
    case "healthy": return "(x.exp_date IS NULL OR x.exp_date >= :medD)";
    default: throw new q.QueryError("bucket is not a valid value");
  }
}

// Canonical FEFO tie-break as a SQL predicate: "a sorts before b" — a recorded expiry date before one with none, then
// ascending expiry, then ascending batch id. Mirrors the Sequelize `order` in inventory.service.getAvailableBatches
// exactly, so a row's precomputed `priority` always matches the order allocateStock would actually consume it in.
const FEFO_SENTINEL = "'9999-12-31 00:00:00.000'";
const fefoBefore = (a, b) => `(COALESCE(${a}.exp_date, ${FEFO_SENTINEL}) < COALESCE(${b}.exp_date, ${FEFO_SENTINEL})
     OR (COALESCE(${a}.exp_date, ${FEFO_SENTINEL}) = COALESCE(${b}.exp_date, ${FEFO_SENTINEL}) AND ${a}.batch_id < ${b}.batch_id))`;

// ───────────────────────────── filter parsing ─────────────────────────────
/**
 * Validate the query string into filters. `scope.distributorId` (when set) is authoritative; `query.distributorId` is only
 * consulted for an unscoped (Admin) caller. An unknown / foreign warehouse for a scoped caller is a 404, never a leak.
 */
async function parseFilters(db, query, scope) {
  const scoped = scope && scope.distributorId != null;
  const f = {
    distributorId: scoped ? Number(scope.distributorId) : q.intId(query.distributorId, "distributorId"),
    warehouseId: q.intId(query.warehouseId, "warehouseId"),
    productId: q.intId(query.productId, "productId"),
    batchId: q.intId(query.batchId, "batchId"),
    product: q.text(query.product, "product", 100),
    category: q.text(query.category, "category", 100),
    batch: q.text(query.batch, "batch", 100),
    q: q.text(query.q, "q", 100),
    from: q.day(query.from, "from"),
    to: q.day(query.to, "to"),
    includeEmpty: query.includeEmpty === "1" || query.includeEmpty === "true",
    // Phase 6 — Batch Stock / Near Expiry / FEFO Monitor only. Distinct from from/to above (which filter ledger
    // posting dates on the Stock Ledger); these filter a batch's own expiry date.
    expFrom: q.day(query.expFrom, "expFrom"),
    expTo: q.day(query.expTo, "expTo"),
    bucket: q.oneOf(query.bucket, rules.EXPIRY_BUCKET_KEYS, "bucket"),
    fefoEligible: query.fefoEligible === "1" || query.fefoEligible === "true",
  };
  if (f.from && f.to && f.from > f.to) throw new q.QueryError("from must not be after to");
  if (f.expFrom && f.expTo && f.expFrom > f.expTo) throw new q.QueryError("expFrom must not be after expTo");
  if (f.warehouseId) {
    const wh = await db.Warehouse.findOne({ where: { id: f.warehouseId, ...(f.distributorId ? { distributor_id: f.distributorId } : {}) }, attributes: ["id"] });
    if (!wh) throw NOT_FOUND("Warehouse not found");
  }
  return f;
}

// ───────────────────────────── SQL building blocks ─────────────────────────────
/**
 * Per (distributor, warehouse, batch) rows with the two ledger balances and every derived quantity / flag / status.
 * "wid" is the effective warehouse: the row's own warehouse, or the distributor's default for legacy (NULL) rows.
 * Mirrors inventoryRules.service (splitBatchQuantities / batchStatus) — parity is asserted in the tests.
 */
function batchLevel(t, f, { ignoreWarehouse = false } = {}) {
  const w = where();
  w.add("l.batchId IS NOT NULL");
  if (f.distributorId) w.add("l.distributor_id = :distId", { distId: f.distributorId });
  if (f.productId) w.add("l.productId = :prodId", { prodId: f.productId });
  if (f.batchId) w.add("l.batchId = :batchIdF", { batchIdF: f.batchId });
  if (f.warehouseId && !ignoreWarehouse) w.add("COALESCE(l.warehouse_id, dw.id) = :whId", { whId: f.warehouseId });

  const sql = `
    SELECT z.*,
      CASE WHEN z.on_hand <= 0 THEN 'out_of_stock'
           WHEN z.is_expired = 1 THEN 'expired'
           WHEN z.is_blocked = 1 OR z.saleable_qty <= 0 THEN 'non_saleable'
           WHEN z.is_near = 1 THEN 'near_expiry'
           ELSE 'healthy' END AS status
    FROM (
      SELECT y.*,
        CASE WHEN y.is_blocked = 1 THEN 0 ELSE y.s_qty END AS saleable_qty,
        y.n_qty + CASE WHEN y.is_blocked = 1 THEN y.s_qty ELSE 0 END AS non_saleable_qty,
        y.on_hand * y.unit_cost AS stock_value
      FROM (
        SELECT s.distributor_id AS distributor_id, s.product_id AS product_id, s.batch_id AS batch_id, s.wid AS wid, s.s_qty AS s_qty, s.n_qty AS n_qty,
               (s.s_qty + s.n_qty) AS on_hand,
               b.batch_no AS batch_no, b.mfg_date AS mfg_date, b.exp_date AS exp_date, b.status AS batch_state, b.mrp AS mrp,
               COALESCE(b.purchase_price, 0) AS unit_cost,
               p.name AS product_name, p.material_code AS sku, p.category AS category, p.unit AS unit, p.reorder_level AS reorder_level,
               d.name AS distributor_name, d.distributor_code AS distributor_code,
               w.name AS warehouse_name, w.code AS warehouse_code,
               CASE WHEN b.exp_date IS NOT NULL AND b.exp_date < :now THEN 1 ELSE 0 END AS is_expired,
               CASE WHEN b.exp_date IS NOT NULL AND b.exp_date >= :now AND b.exp_date < :near THEN 1 ELSE 0 END AS is_near,
               CASE WHEN b.status <> 'active' OR (b.exp_date IS NOT NULL AND b.exp_date < :now) THEN 1 ELSE 0 END AS is_blocked
        FROM (
          SELECT l.distributor_id AS distributor_id, l.productId AS product_id, l.batchId AS batch_id, COALESCE(l.warehouse_id, dw.id) AS wid,
                 SUM(CASE WHEN l.stock_state = 'NON_SALEABLE' THEN 0 ELSE ${SIGNED} END) AS s_qty,
                 SUM(CASE WHEN l.stock_state = 'NON_SALEABLE' THEN ${SIGNED} ELSE 0 END) AS n_qty
          FROM ${t.ledger} l
          LEFT JOIN ${t.warehouse} dw ON dw.distributor_id = l.distributor_id AND dw.is_default = 1
          ${w.sql()}
          GROUP BY l.distributor_id, l.productId, l.batchId, COALESCE(l.warehouse_id, dw.id)
        ) s
        JOIN ${t.batch} b ON b.id = s.batch_id AND b.distributor_id = s.distributor_id
        JOIN ${t.product} p ON p.id = s.product_id
        JOIN ${t.distributor} d ON d.id = s.distributor_id
        LEFT JOIN ${t.warehouse} w ON w.id = s.wid
      ) y
    ) z`;
  return { sql, params: w.params };
}

// Units on confirmed / partially delivered sales orders that are not delivered yet (informational; see docs → Reserved).
function reservedSql(t, f) {
  const w = where();
  w.add("o.status IN ('CONFIRMED','PARTIALLY_DELIVERED')");
  if (f.distributorId) w.add("o.distributor_id = :distId", { distId: f.distributorId });
  const sql = `
    SELECT o.distributor_id AS distributor_id, ol.productId AS product_id,
           SUM(CASE WHEN ol.quantity - COALESCE(dv.delivered, 0) > 0 THEN ol.quantity - COALESCE(dv.delivered, 0) ELSE 0 END) AS reserved
    FROM ${t.orderLine} ol
    JOIN ${t.order} o ON o.id = ol.orderId
    LEFT JOIN (
      SELECT dl.orderLineId AS order_line_id, SUM(dl.quantityDelivered) AS delivered
      FROM ${t.deliveryLine} dl JOIN ${t.delivery} dh ON dh.id = dl.deliveryId
      WHERE dh.status <> 'Cancelled' GROUP BY dl.orderLineId
    ) dv ON dv.order_line_id = ol.id
    ${w.sql()}
    GROUP BY o.distributor_id, ol.productId`;
  return { sql, params: w.params };
}

const BATCH_EXISTS = (t) =>
  `EXISTS (SELECT 1 FROM ${t.batch} bb WHERE bb.productId = g.product_id AND bb.distributor_id = g.distributor_id AND LOWER(bb.batch_no) LIKE :batchLike ESCAPE '!')`;

/**
 * Product-level stock. Grain: (distributor, warehouse, product) — or (distributor, product) when byWarehouse is false (KPIs).
 * `status` follows rules.productStatus: expired stock → Expired; the PRODUCT's saleable total across warehouses at/below its
 * reorder level → Low stock; near-expiry saleable stock → Near expiry; else Healthy.
 */
function currentStockSql(t, f, { byWarehouse = true } = {}) {
  const base = batchLevel(t, f);
  const all = batchLevel(t, f, { ignoreWarehouse: true });
  const res = reservedSql(t, f);
  const grp = byWarehouse ? "t.distributor_id, t.wid, t.product_id" : "t.distributor_id, t.product_id";
  const sql = `
    SELECT g.*, COALESCE(pt.p_saleable, 0) AS p_saleable,
      CASE WHEN g.expired_qty > 0 THEN 'expired'
           WHEN g.reorder_level IS NOT NULL AND g.reorder_level > 0 AND COALESCE(pt.p_saleable, 0) <= g.reorder_level THEN 'low_stock'
           WHEN g.near_expiry_qty > 0 THEN 'near_expiry'
           ELSE 'healthy' END AS status
    FROM (
      SELECT t.distributor_id AS distributor_id, ${byWarehouse ? "t.wid AS wid," : "NULL AS wid,"} t.product_id AS product_id,
             MAX(t.product_name) AS product_name, MAX(t.sku) AS sku, MAX(t.category) AS category, MAX(t.unit) AS unit,
             MAX(t.reorder_level) AS reorder_level, MAX(t.distributor_name) AS distributor_name, MAX(t.distributor_code) AS distributor_code,
             ${byWarehouse ? "MAX(t.warehouse_name) AS warehouse_name, MAX(t.warehouse_code) AS warehouse_code," : "NULL AS warehouse_name, NULL AS warehouse_code,"}
             SUM(t.on_hand) AS available_qty, SUM(t.saleable_qty) AS saleable_qty, SUM(t.non_saleable_qty) AS non_saleable_qty,
             SUM(CASE WHEN t.is_expired = 1 AND t.on_hand > 0 THEN t.on_hand ELSE 0 END) AS expired_qty,
             SUM(CASE WHEN t.is_near = 1 AND t.is_blocked = 0 THEN t.saleable_qty ELSE 0 END) AS near_expiry_qty,
             SUM(t.stock_value) AS stock_value,
             SUM(CASE WHEN t.on_hand > 0 THEN 1 ELSE 0 END) AS batch_count,
             ${byWarehouse ? "MAX(CASE WHEN tw.id IS NULL OR tw.is_default = 1 THEN COALESCE(rs.reserved, 0) ELSE 0 END)" : "MAX(COALESCE(rs.reserved, 0))"} AS reserved_qty
      FROM (${base.sql}) t
      ${byWarehouse ? `LEFT JOIN ${t.warehouse} tw ON tw.id = t.wid` : ""}
      LEFT JOIN (${res.sql}) rs ON rs.distributor_id = t.distributor_id AND rs.product_id = t.product_id
      GROUP BY ${grp}
    ) g
    LEFT JOIN (SELECT a.distributor_id AS distributor_id, a.product_id AS product_id, SUM(a.saleable_qty) AS p_saleable
               FROM (${all.sql}) a GROUP BY a.distributor_id, a.product_id) pt
           ON pt.distributor_id = g.distributor_id AND pt.product_id = g.product_id`;
  return { sql, params: { ...base.params, ...all.params, ...res.params } };
}

function currentStockFilters(t, f, query, w) {
  if (f.product) w.add("(LOWER(x.product_name) LIKE :prodLike ESCAPE '!' OR LOWER(x.sku) LIKE :prodLike ESCAPE '!')", { prodLike: q.likeTerm(f.product) });
  if (f.category) w.add("x.category = :cat", { cat: f.category });
  if (f.batch) w.add(BATCH_EXISTS(t).replace(/g\./g, "x."), { batchLike: q.likeTerm(f.batch) });
  if (f.q) {
    w.add(
      `(LOWER(x.sku) LIKE :qLike ESCAPE '!' OR LOWER(x.product_name) LIKE :qLike ESCAPE '!' OR LOWER(x.distributor_name) LIKE :qLike ESCAPE '!'
        OR LOWER(x.distributor_code) LIKE :qLike ESCAPE '!' OR LOWER(COALESCE(x.warehouse_name, '')) LIKE :qLike ESCAPE '!'
        OR ${BATCH_EXISTS(t).replace(/g\./g, "x.").replace(":batchLike", ":qLike")})`,
      { qLike: q.likeTerm(f.q) }
    );
  }
  const status = q.oneOf(query.status, rules.PRODUCT_STATUSES, "status");
  return status;
}

// ───────────────────────────── row mappers ─────────────────────────────
const warehouseOf = (r) => ({
  id: r.wid != null ? Number(r.wid) : null,
  name: r.warehouse_name || "Main Warehouse",
  code: r.warehouse_code || "MAIN",
  implicit: r.wid == null, // no Warehouse row exists yet: legacy stock is attributed to the (implicit) default warehouse
});
const distributorOf = (r) => ({ id: Number(r.distributor_id), name: r.distributor_name, code: r.distributor_code });

function mapCurrent(r) {
  return {
    key: `${r.distributor_id}-${r.wid ?? "d"}-${r.product_id}`,
    productId: Number(r.product_id), sku: r.sku, product: r.product_name, category: r.category || "Uncategorised", unit: r.unit || null,
    distributor: distributorOf(r), warehouse: warehouseOf(r),
    availableQty: num(r.available_qty), reservedQty: num(r.reserved_qty), saleableQty: num(r.saleable_qty), nonSaleableQty: num(r.non_saleable_qty),
    expiredQty: num(r.expired_qty), nearExpiryQty: num(r.near_expiry_qty), batchCount: num(r.batch_count),
    reorderLevel: r.reorder_level != null ? num(r.reorder_level) : null,
    stockValue: money(r.stock_value), status: r.status,
  };
}
function mapBatch(r, now) {
  return {
    key: `${r.distributor_id}-${r.batch_id}-${r.wid ?? "d"}`,
    batchId: Number(r.batch_id), productId: Number(r.product_id), sku: r.sku, product: r.product_name, category: r.category || "Uncategorised",
    batchNo: r.batch_no, distributor: distributorOf(r), warehouse: warehouseOf(r),
    mfgDate: isoDay(r.mfg_date), expDate: isoDay(r.exp_date), daysToExpiry: rules.daysToExpiry(r.exp_date, now),
    availableQty: num(r.on_hand), saleableQty: num(r.saleable_qty), nonSaleableQty: num(r.non_saleable_qty),
    mrp: r.mrp != null ? money(r.mrp) : null, unitCost: money(r.unit_cost), stockValue: money(r.stock_value), status: r.status,
    batchActive: r.batch_state === "active",
    // Phase 6 — pure functions of exp_date/now already selected above; expiryBucket needs no extra SQL. priority is
    // only present (non-null) when the query asked for it (fefoEligible=1) — see listBatchStock / getBatchDetail.
    expiryBucket: rules.expiryBucket(r.exp_date, now),
    priority: r.priority != null ? num(r.priority) : null,
  };
}

// ───────────────────────────── Current Stock ─────────────────────────────
const CURRENT_SORT = {
  sku: "x.sku", product: "x.product_name", category: "x.category", distributor: "x.distributor_name", warehouse: "x.warehouse_name",
  available: "x.available_qty", reserved: "x.reserved_qty", saleable: "x.saleable_qty", non_saleable: "x.non_saleable_qty", value: "x.stock_value",
};

async function listCurrentStock(db, query, scope, { now = new Date() } = {}) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  const { page, pageSize, offset } = q.paging(query);
  const sort = q.sorting(query, CURRENT_SORT, { key: "product", dir: "asc" });
  const status = q.oneOf(query.status, rules.PRODUCT_STATUSES, "status");
  const c = clock(now);

  const base = currentStockSql(t, f);
  const w = where();
  currentStockFilters(t, f, query, w);
  if (status) w.add("x.status = :status", { status });
  const params = { ...base.params, ...w.params, ...c };
  const from = `FROM (${base.sql}) x ${w.sql()}`;

  const [totalRow] = await run(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await run(
    `SELECT x.* ${from} ORDER BY ${sort.column} ${sort.dir}, x.product_name ASC, x.product_id ASC LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset }
  );
  return { items: rows.map(mapCurrent), total: num(totalRow.n), page, pageSize };
}

async function getSummary(db, query, scope, { now = new Date() } = {}) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  const c = clock(now);
  const base = currentStockSql(t, f, { byWarehouse: false });
  const w = where();
  currentStockFilters(t, f, query, w);
  const [r] = await run(
    `SELECT COALESCE(SUM(x.stock_value), 0) AS value, COALESCE(SUM(x.available_qty), 0) AS on_hand,
            COALESCE(SUM(x.saleable_qty), 0) AS saleable, COALESCE(SUM(x.non_saleable_qty), 0) AS non_saleable,
            SUM(CASE WHEN x.available_qty > 0 THEN 1 ELSE 0 END) AS skus, COALESCE(SUM(x.batch_count), 0) AS batches,
            SUM(CASE WHEN x.status = 'low_stock' THEN 1 ELSE 0 END) AS low_stock,
            SUM(CASE WHEN x.near_expiry_qty > 0 THEN 1 ELSE 0 END) AS near_expiry,
            SUM(CASE WHEN x.expired_qty > 0 THEN 1 ELSE 0 END) AS expired
     FROM (${base.sql}) x ${w.sql()}`,
    { ...base.params, ...w.params, ...c }
  );
  return {
    totalStockValue: money(r.value), onHandQty: num(r.on_hand), saleableQty: num(r.saleable), nonSaleableQty: num(r.non_saleable),
    totalSkus: num(r.skus), totalBatches: num(r.batches), lowStockItems: num(r.low_stock), nearExpiryItems: num(r.near_expiry), expiredItems: num(r.expired),
    valuation: rules.VALUATION, nearExpiryDays: rules.getNearExpiryDays(),
  };
}

/**
 * Phase 6 — expiry-bucket rollup: batches / distinct products / units / stock value in each of the five buckets
 * (expired, critical, high, medium, healthy), aggregated across all of a distributor's warehouses (or, with
 * distributorId omitted, across every distributor — the Admin Dashboard's cross-tenant use case).
 *
 * This is the SINGLE place that computes these totals. It replaces the ad-hoc SQL the Phase 3 Admin Dashboard used to
 * compute the same numbers (services/adminDashboard.service.js), which — written before Phase 5 introduced warehouses
 * and the saleable/non-saleable stock state — summed a batch's whole ledger balance regardless of stock_state. That
 * would double-count stock that had already been marked non-saleable for an unrelated reason (say, damage) inside the
 * critical/high/medium totals, even though it is not part of "stock nearing expiry that still needs a decision" (it
 * already had one). Here, and everywhere else in Phase 5/6, critical/high/medium only count SALEABLE, active,
 * not-yet-expired stock — exactly the units near_expiry_qty already counted in Current Stock/Batch Stock (Phase 5);
 * "expired" counts the full on-hand quantity (both stock states), matching Phase 5's expiredQty, because once a batch
 * is past its expiry date the whole quantity is effectively non-saleable regardless of how it was flagged before.
 */
async function getExpiryBucketSummary(db, { distributorId = null } = {}, { now = new Date() } = {}) {
  const t = tables(db);
  const run = runner(db);
  const c = clock(now);
  const base = batchLevel(t, { distributorId });
  const rows = await run(
    `SELECT b.bucket AS bucket, COUNT(DISTINCT b.batch_id) AS batches, COUNT(DISTINCT b.product_id) AS products,
            COALESCE(SUM(b.qty), 0) AS units, COALESCE(SUM(b.qty * b.unit_cost), 0) AS value
     FROM (
       SELECT
         CASE WHEN x.exp_date IS NOT NULL AND x.exp_date < :now THEN 'expired'
              WHEN x.is_blocked = 1 OR x.saleable_qty <= 0 THEN NULL
              WHEN x.exp_date IS NOT NULL AND x.exp_date < :critD THEN 'critical'
              WHEN x.exp_date IS NOT NULL AND x.exp_date < :highD THEN 'high'
              WHEN x.exp_date IS NOT NULL AND x.exp_date < :medD THEN 'medium'
              ELSE 'healthy' END AS bucket,
         CASE WHEN x.exp_date IS NOT NULL AND x.exp_date < :now THEN x.on_hand ELSE x.saleable_qty END AS qty,
         x.batch_id AS batch_id, x.product_id AS product_id, x.unit_cost AS unit_cost
       FROM (${base.sql}) x WHERE x.on_hand > 0
     ) b
     WHERE b.bucket IS NOT NULL
     GROUP BY b.bucket`,
    { ...base.params, ...c }
  );
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  const empty = { batches: 0, products: 0, units: 0, value: 0 };
  const shape = (key) => {
    const r = byKey.get(key);
    return r ? { batches: num(r.batches), products: num(r.products), units: num(r.units), value: money(r.value) } : { ...empty };
  };
  return { critical: shape("critical"), high: shape("high"), medium: shape("medium"), healthy: shape("healthy"), expired: shape("expired") };
}

// ───────────────────────────── Batch Stock ─────────────────────────────
const BATCH_SORT = {
  product: "x.product_name", sku: "x.sku", batch_no: "x.batch_no", distributor: "x.distributor_name", warehouse: "x.warehouse_name",
  mfg_date: "x.mfg_date", exp_date: "x.exp_date", available: "x.on_hand", saleable: "x.saleable_qty", non_saleable: "x.non_saleable_qty",
  mrp: "x.mrp", value: "x.stock_value",
  // Phase 6: only meaningful (and only selected — see below) when fefoEligible=1; listBatchStock rejects it otherwise.
  // Unqualified (not "x.priority"): it is a computed alias on the OUTER select, not a column of the `x` subquery.
  priority: "priority",
};

/**
 * Batch Stock (unchanged default behaviour) — and, since Phase 6, the same query powers the FEFO Monitor, the Near
 * Expiry page and the Expired Stock page, via the additional optional filters below. This is intentional reuse: those
 * pages are exactly "Batch Stock, filtered and sorted differently", not a second batch-listing engine.
 *   fefoEligible=1   → restrict to batches a normal sale could currently draw from (status healthy or near_expiry —
 *                       i.e. not expired, not non-saleable, not out of stock) and compute each row's `priority`: its
 *                       1-based rank in the SAME earliest-expiry-first order inventory.service.allocateStock would
 *                       actually consume it in for that (distributor, warehouse, product) — see fefoBefore() above.
 *                       Used by the FEFO Monitor. Priority is only computed when this flag is set (it costs an extra
 *                       correlated subquery per row), so plain Batch Stock / Near Expiry / Expired Stock stay cheap.
 *   bucket           → one of rules.EXPIRY_BUCKET_KEYS (expired/critical/high/medium/healthy). Used by the Near
 *                       Expiry page (critical/high/medium) and, less usefully but not disallowed, the others.
 *   expFrom/expTo    → filter on the batch's own expiry date (distinct from from/to, which filter ledger dates
 *                       elsewhere). Used by the Near Expiry page's date-range filter.
 */
async function listBatchStock(db, query, scope, { now = new Date() } = {}) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  const { page, pageSize, offset } = q.paging(query);
  const sort = q.sorting(query, BATCH_SORT, { key: "exp_date", dir: "asc" });
  if (sort.key === "priority" && !f.fefoEligible) throw new q.QueryError("sort=priority requires fefoEligible=1");
  const status = q.oneOf(query.status, rules.BATCH_STATUSES, "status");
  const c = clock(now);

  const base = batchLevel(t, f);
  const w = where();
  if (!f.includeEmpty && status !== "out_of_stock") w.add("x.on_hand <> 0");
  if (f.product) w.add("(LOWER(x.product_name) LIKE :prodLike ESCAPE '!' OR LOWER(x.sku) LIKE :prodLike ESCAPE '!')", { prodLike: q.likeTerm(f.product) });
  if (f.category) w.add("x.category = :cat", { cat: f.category });
  if (f.batch) w.add("LOWER(x.batch_no) LIKE :batchLike ESCAPE '!'", { batchLike: q.likeTerm(f.batch) });
  if (f.q) {
    w.add(
      `(LOWER(x.sku) LIKE :qLike ESCAPE '!' OR LOWER(x.product_name) LIKE :qLike ESCAPE '!' OR LOWER(x.batch_no) LIKE :qLike ESCAPE '!'
        OR LOWER(x.distributor_name) LIKE :qLike ESCAPE '!' OR LOWER(x.distributor_code) LIKE :qLike ESCAPE '!'
        OR LOWER(COALESCE(x.warehouse_name, '')) LIKE :qLike ESCAPE '!')`,
      { qLike: q.likeTerm(f.q) }
    );
  }
  if (status) w.add("x.status = :status", { status });
  if (f.bucket) w.add(bucketPredicate(f.bucket));
  if (f.fefoEligible) w.add("x.status IN ('healthy', 'near_expiry')");
  if (f.expFrom) w.add("x.exp_date >= :expFromD", { expFromD: dayStart(f.expFrom) });
  if (f.expTo) w.add("x.exp_date < :expToD", { expToD: dayEndExclusive(f.expTo) });
  const params = { ...base.params, ...w.params, ...c };
  const from = `FROM (${base.sql}) x ${w.sql()}`;

  // Priority: 1 + how many OTHER eligible batches of the same (distributor, warehouse, product) are earlier in FEFO
  // order. Scoped to the eligible set only (status healthy/near_expiry) — the same universe getAvailableBatches draws
  // from for that scope — so priority=1 always means "this is what a plain sale would take from first".
  const priorityCol = f.fefoEligible
    ? `, (1 + (SELECT COUNT(*) FROM (${base.sql}) y
                WHERE y.status IN ('healthy', 'near_expiry') AND y.distributor_id = x.distributor_id
                  AND y.wid = x.wid AND y.product_id = x.product_id AND ${fefoBefore("y", "x")})) AS priority`
    : "";

  const [totalRow] = await run(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await run(
    `SELECT x.*${priorityCol} ${from} ORDER BY ${sort.column} ${sort.dir}, x.batch_id ASC, x.wid ASC LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset }
  );
  return { items: rows.map((r) => mapBatch(r, now)), total: num(totalRow.n), page, pageSize };
}

// Phase 6 — a single batch's FEFO priority within ONE (distributor, warehouse, product) group: 1-based rank among
// currently-eligible batches (status healthy/near_expiry) in the SAME earliest-expiry-first order
// inventory.service.allocateStock actually consumes them in. null when the batch itself is not eligible there (no
// stock in that warehouse, expired, or non-saleable) — "not applicable", not "last place".
// Reads the small set of eligible batches (one product, one warehouse) via the same batchLevel() SQL listBatchStock
// uses, then ranks in JS; a parity test asserts this agrees with listBatchStock's SQL-computed `priority` for the
// same data, so the two are kept honest without forcing an artificial single implementation across both contexts.
async function computeBatchFefoPriority(t, run, { distributorId, productId, warehouseId, batchId, now = new Date() }) {
  const lvl = batchLevel(t, { distributorId, productId, warehouseId });
  const rows = await run(
    `SELECT x.status AS status, x.exp_date AS exp_date, x.batch_id AS batch_id FROM (${lvl.sql}) x WHERE x.status IN ('healthy', 'near_expiry')`,
    { ...lvl.params, ...clock(now) }
  );
  const own = rows.find((r) => Number(r.batch_id) === Number(batchId));
  if (!own) return null;
  const key = (r) => (r.exp_date == null ? [1, 0, Number(r.batch_id)] : [0, new Date(r.exp_date).getTime(), Number(r.batch_id)]);
  const before = (a, b) => {
    const [an, at, aid] = key(a);
    const [bn, bt, bid] = key(b);
    return an !== bn ? an < bn : at !== bt ? at < bt : aid < bid;
  };
  return 1 + rows.filter((r) => before(r, own)).length;
}

// ───────────────────────────── Batch detail ─────────────────────────────
async function getBatchDetail(db, batchId, scope, { now = new Date() } = {}) {
  const id = q.intId(batchId, "batch id");
  if (!id) throw new q.QueryError("batch id is required");
  const t = tables(db);
  const run = runner(db);
  const c = clock(now);

  // Tenant boundary: the batch must belong to the scope's distributor. Foreign id → 404 (indistinguishable from "missing").
  const w = where();
  w.add("b.id = :id", { id });
  if (scope && scope.distributorId != null) w.add("b.distributor_id = :scopeDist", { scopeDist: Number(scope.distributorId) });
  const [head] = await run(
    `SELECT b.id, b.batch_no, b.mfg_date, b.exp_date, b.status AS batch_state, b.mrp, b.purchase_price, b.distributor_id, b.productId AS product_id,
            p.name AS product_name, p.material_code AS sku, p.category, p.unit, p.mfg_by, p.reorder_level, p.gst, p.cgst, p.sgst, p.igst,
            h.hsn_code, h.gst_rate, d.name AS distributor_name, d.distributor_code
     FROM ${t.batch} b JOIN ${t.product} p ON p.id = b.productId JOIN ${t.distributor} d ON d.id = b.distributor_id
     LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id ${w.sql()}`,
    w.params
  );
  if (!head) return null;

  const f = { distributorId: Number(head.distributor_id), batchId: id };
  const lvl = batchLevel(t, f);
  const locations = await run(`SELECT x.* FROM (${lvl.sql}) x ORDER BY x.warehouse_name ASC, x.wid ASC`, { ...lvl.params, ...c });
  const [res] = await run(
    `SELECT COALESCE(SUM(CASE WHEN ol.quantity - COALESCE(dv.delivered, 0) > 0 THEN ol.quantity - COALESCE(dv.delivered, 0) ELSE 0 END), 0) AS reserved
     FROM ${t.orderLine} ol JOIN ${t.order} o ON o.id = ol.orderId
     LEFT JOIN (SELECT dl.orderLineId AS order_line_id, SUM(dl.quantityDelivered) AS delivered FROM ${t.deliveryLine} dl
                JOIN ${t.delivery} dh ON dh.id = dl.deliveryId WHERE dh.status <> 'Cancelled' GROUP BY dl.orderLineId) dv ON dv.order_line_id = ol.id
     WHERE ol.batchId = :id AND o.distributor_id = :dist AND o.status IN ('CONFIRMED','PARTIALLY_DELIVERED')`,
    { id, dist: f.distributorId }
  );
  const reasons = await run(
    `SELECT l.non_saleable_reason AS reason, SUM(${SIGNED}) AS qty FROM ${t.ledger} l
     WHERE l.batchId = :id AND l.distributor_id = :dist AND l.stock_state = 'NON_SALEABLE' GROUP BY l.non_saleable_reason`,
    { id, dist: f.distributorId }
  );

  const sum = (k) => locations.reduce((a, r) => a + num(r[k]), 0);
  const saleable = sum("saleable_qty");
  const nonSaleable = sum("non_saleable_qty");
  const onHand = sum("on_hand");
  const expired = rules.isExpired(head.exp_date, now);
  const inactive = head.batch_state !== "active";
  const status = rules.batchStatus({ expDate: head.exp_date, batchActive: !inactive, saleableState: sum("s_qty"), nonSaleableState: sum("n_qty") }, now);

  // Non-saleable breakdown: recorded reasons (ledger) + stock made non-saleable by expiry / inactivity (derived, never stored).
  const breakdown = reasons.filter((r) => num(r.qty) !== 0).map((r) => ({ reason: r.reason, label: rules.NON_SALEABLE_REASONS[r.reason] || r.reason, qty: num(r.qty) }));
  const derived = nonSaleable - breakdown.reduce((a, r) => a + r.qty, 0);
  if (derived > 0) breakdown.push({ reason: expired ? "EXPIRED" : "BLOCKED", label: expired ? "Expired batch" : "Batch inactive", qty: derived });

  // Phase 6 (item 20) — extend, do not duplicate: FEFO priority and expiry bucket added to the existing Batch Detail.
  // Priority is computed for the distributor's DEFAULT (dispatch) warehouse specifically, because that is where a
  // plain sale actually allocates from (inventory.service.postSalesOut); if this batch has no eligible stock there
  // (none delivered to that warehouse, or already expired/non-saleable there) priority is null — not applicable —
  // with `fefoWarehouse` explaining which warehouse the (missing) ranking would apply to.
  const dispatchWarehouseId = await getDispatchWarehouseId({ distributorId: f.distributorId });
  const dispatchLocation = dispatchWarehouseId ? locations.find((r) => Number(r.wid) === Number(dispatchWarehouseId)) : null;
  const fefoPriority = dispatchWarehouseId
    ? await computeBatchFefoPriority(t, run, { distributorId: f.distributorId, productId: Number(head.product_id), warehouseId: dispatchWarehouseId, batchId: id, now })
    : null;

  return {
    batchId: Number(head.id), batchNo: head.batch_no, status, batchActive: !inactive,
    product: { id: Number(head.product_id), name: head.product_name, sku: head.sku, category: head.category || "Uncategorised", unit: head.unit || null, manufacturer: head.mfg_by || null },
    mfgDate: isoDay(head.mfg_date), expDate: isoDay(head.exp_date), daysToExpiry: rules.daysToExpiry(head.exp_date, now),
    expiryBucket: rules.expiryBucket(head.exp_date, now),
    mrp: head.mrp != null ? money(head.mrp) : null, unitCost: money(head.purchase_price),
    hsn: head.hsn_code || null,
    gstRate: head.gst != null ? num(head.gst) : head.gst_rate != null ? num(head.gst_rate) : head.cgst != null || head.sgst != null ? num(head.cgst) + num(head.sgst) : null,
    stock: {
      totalQty: onHand, saleableQty: saleable, nonSaleableQty: nonSaleable, reservedQty: num(res && res.reserved),
      stockValue: money(onHand * num(head.purchase_price)), nonSaleableBreakdown: breakdown,
    },
    fefo: {
      priority: fefoPriority,
      warehouse: dispatchLocation ? warehouseOf(dispatchLocation) : null,
      note: fefoPriority != null ? null : "Not currently eligible for automatic FEFO allocation in the dispatch warehouse (no saleable stock there, expired, or marked non-saleable).",
    },
    distributor: { id: Number(head.distributor_id), name: head.distributor_name, code: head.distributor_code },
    locations: locations.map((r) => ({ warehouse: warehouseOf(r), totalQty: num(r.on_hand), saleableQty: num(r.saleable_qty), nonSaleableQty: num(r.non_saleable_qty) })),
    valuation: rules.VALUATION,
  };
}

// ───────────────────────────── Stock Ledger ─────────────────────────────
function txnPredicate(type) {
  const spec = rules.TXN_TYPES[type];
  const parts = spec.match.map((m) => {
    const refs = m.refs.map((r) => `'${r}'`).join(",");
    return `(l.reference_type IN (${refs})${m.dir ? ` AND l.movement_type ${m.dir === "OUT" ? "= 'OUT'" : "<> 'OUT'"}` : ""})`;
  });
  return `(${parts.join(" OR ")})`;
}

function ledgerFrom(t) {
  return `FROM ${t.ledger} l
    JOIN ${t.product} p ON p.id = l.productId
    JOIN ${t.distributor} d ON d.id = l.distributor_id
    LEFT JOIN ${t.batch} b ON b.id = l.batchId
    LEFT JOIN ${t.warehouse} dw ON dw.distributor_id = l.distributor_id AND dw.is_default = 1
    LEFT JOIN ${t.warehouse} ww ON ww.id = COALESCE(l.warehouse_id, dw.id)
    LEFT JOIN ${t.salesReturn} sr ON l.reference_type = 'RETURN' AND l.movement_type <> 'OUT' AND sr.id = l.reference_id AND sr.distributor_id = l.distributor_id
    LEFT JOIN ${t.purchaseReturn} pr ON l.reference_type = 'RETURN' AND l.movement_type = 'OUT' AND pr.id = l.reference_id AND pr.distributor_id = l.distributor_id`;
}

function ledgerWhere(f, txn) {
  const w = where();
  if (f.distributorId) w.add("l.distributor_id = :distId", { distId: f.distributorId });
  if (f.productId) w.add("l.productId = :prodId", { prodId: f.productId });
  if (f.batchId) w.add("l.batchId = :batchIdF", { batchIdF: f.batchId });
  if (f.warehouseId) w.add("COALESCE(l.warehouse_id, dw.id) = :whId", { whId: f.warehouseId });
  if (f.product) w.add("(LOWER(p.name) LIKE :prodLike ESCAPE '!' OR LOWER(p.material_code) LIKE :prodLike ESCAPE '!')", { prodLike: q.likeTerm(f.product) });
  if (f.batch) w.add("LOWER(b.batch_no) LIKE :batchLike ESCAPE '!'", { batchLike: q.likeTerm(f.batch) });
  if (f.from) w.add("l.createdAt >= :fromD", { fromD: dayStart(f.from) });
  if (f.to) w.add("l.createdAt < :toD", { toD: dayEndExclusive(f.to) });
  if (txn) w.add(txnPredicate(txn));
  if (f.q) {
    const asId = /^\d{1,9}$/.test(f.q) ? Number(f.q) : null;
    w.add(
      `(LOWER(p.name) LIKE :qLike ESCAPE '!' OR LOWER(p.material_code) LIKE :qLike ESCAPE '!' OR LOWER(COALESCE(b.batch_no, '')) LIKE :qLike ESCAPE '!'
        OR LOWER(COALESCE(sr.return_number, '')) LIKE :qLike ESCAPE '!' OR LOWER(COALESCE(pr.return_number, '')) LIKE :qLike ESCAPE '!'
        OR LOWER(COALESCE(l.reason, '')) LIKE :qLike ESCAPE '!'${asId != null ? " OR l.reference_id = :qId" : ""})`,
      { qLike: q.likeTerm(f.q), ...(asId != null ? { qId: asId } : {}) }
    );
  }
  return w;
}

function referenceLabel(r) {
  const id = r.reference_id;
  switch (r.reference_type) {
    case "PURCHASE": return id != null ? `Purchase delivery #${id}` : "Purchase";
    case "SALES": return id != null ? `Sales delivery #${id}` : "Sales";
    case "RETURN": return r.return_number || (id != null ? `Return #${id}` : "Return");
    case "TRANSFER": return id != null ? `TRF-${String(id).padStart(6, "0")}` : "Transfer";
    default: return r.reason || (r.reference_type === "OPENING" ? "Opening stock" : "—");
  }
}

async function listLedger(db, query, scope) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  const { page, pageSize, offset } = q.paging(query);
  const txn = q.oneOf(query.txnType, Object.keys(rules.TXN_TYPES), "txnType");
  const dir = q.oneOf(query.dir, ["asc", "desc"], "dir", (x) => x.toLowerCase()) || "desc";
  if (query.sort !== undefined && query.sort !== "" && query.sort !== "date") throw new q.QueryError("sort is not a valid column");
  const w = ledgerWhere(f, txn);
  const from = ledgerFrom(t);

  const [totalRow] = await run(`SELECT COUNT(*) AS n ${from} ${w.sql()}`, w.params);
  const rows = await run(
    `SELECT l.id AS id, l.createdAt AS created_at, l.movement_type AS movement_type, l.quantity AS quantity, l.reference_type AS reference_type,
            l.reference_id AS reference_id, l.reason AS reason, l.stock_state AS stock_state, l.non_saleable_reason AS non_saleable_reason,
            l.productId AS product_id, l.batchId AS batch_id, l.distributor_id AS distributor_id, COALESCE(l.warehouse_id, dw.id) AS wid,
            p.name AS product_name, p.material_code AS sku, b.batch_no AS batch_no, d.name AS distributor_name, d.distributor_code AS distributor_code,
            ww.name AS warehouse_name, ww.code AS warehouse_code, COALESCE(sr.return_number, pr.return_number) AS return_number
     ${from} ${w.sql()} ORDER BY l.createdAt ${dir.toUpperCase()}, l.id ${dir.toUpperCase()} LIMIT :limit OFFSET :offset`,
    { ...w.params, limit: pageSize, offset }
  );

  // Running balance for the rows on this page only (per batch + warehouse, both stock states, in ledger order).
  const ids = rows.map((r) => Number(r.id));
  const balances = new Map();
  if (ids.length) {
    const bal = await run(
      `SELECT l1.id AS id,
              (SELECT COALESCE(SUM(CASE WHEN l2.movement_type = 'OUT' THEN -l2.quantity ELSE l2.quantity END), 0)
               FROM ${t.ledger} l2
               WHERE l2.distributor_id = l1.distributor_id AND l2.batchId = l1.batchId
                 AND COALESCE(l2.warehouse_id, dw1.id, 0) = COALESCE(l1.warehouse_id, dw1.id, 0)
                 AND (l2.createdAt < l1.createdAt OR (l2.createdAt = l1.createdAt AND l2.id <= l1.id))) AS balance
       FROM ${t.ledger} l1 LEFT JOIN ${t.warehouse} dw1 ON dw1.distributor_id = l1.distributor_id AND dw1.is_default = 1
       WHERE l1.id IN (:ids)`,
      { ids }
    );
    bal.forEach((b) => balances.set(Number(b.id), num(b.balance)));
  }

  const items = rows.map((r) => {
    const type = rules.classifyTransaction(r.reference_type, r.movement_type);
    const isIn = r.movement_type !== "OUT";
    return {
      id: Number(r.id), date: iso(r.created_at), reference: referenceLabel(r),
      transactionType: type.key, transactionLabel: type.label,
      productId: Number(r.product_id), sku: r.sku, product: r.product_name, batchId: r.batch_id != null ? Number(r.batch_id) : null, batchNo: r.batch_no || null,
      distributor: distributorOf(r), warehouse: warehouseOf(r),
      inQty: isIn ? num(r.quantity) : null, outQty: isIn ? null : num(r.quantity), balance: balances.has(Number(r.id)) ? balances.get(Number(r.id)) : null,
      stockState: r.stock_state === "NON_SALEABLE" ? "non_saleable" : "saleable", nonSaleableReason: r.non_saleable_reason || null,
      note: r.reason || null,
    };
  });
  return { items, total: num(totalRow.n), page, pageSize };
}

// ───────────────────────────── Stock Movement (Opening → Closing) ─────────────────────────────
// Every ledger row of the period falls in exactly ONE bucket, so opening + movements === closing (asserted in tests).
// Buckets: stockIn (PURCHASE / OPENING in) · stockOut (SALES out) · returns (RETURN, signed) · transfers (TRANSFER, signed) ·
// adjustments (DAMAGE/EXPIRY/BREAKAGE/PHYSICAL_COUNT/CORRECTION/ADJUSTMENT, signed) · other (whatever is left, e.g. RECLASSIFY
// pairs, which net to zero because both stock states are counted).
async function getMovement(db, query, scope) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  if (!f.productId && !f.batchId) throw new q.QueryError("productId or batchId is required");
  const w = ledgerWhere({ ...f, from: null, to: null }, null); // period is applied inside the SUMs so the opening balance can see earlier rows
  const adj = rules.ADJUSTMENT_REFS.map((r) => `'${r}'`).join(",");
  const inRange = `(${f.from ? "l.createdAt >= :fromD" : "1 = 1"} AND ${f.to ? "l.createdAt < :toD" : "1 = 1"})`;
  const params = { ...w.params, ...(f.from ? { fromD: dayStart(f.from) } : {}), ...(f.to ? { toD: dayEndExclusive(f.to) } : {}) };
  const opening = f.from ? `SUM(CASE WHEN l.createdAt < :fromD THEN ${SIGNED} ELSE 0 END)` : "0";
  const [r] = await run(
    `SELECT ${opening} AS opening,
            SUM(CASE WHEN ${inRange} AND l.movement_type <> 'OUT' AND l.reference_type IN ('PURCHASE','OPENING') THEN l.quantity ELSE 0 END) AS stock_in,
            SUM(CASE WHEN ${inRange} AND l.movement_type = 'OUT' AND l.reference_type = 'SALES' THEN l.quantity ELSE 0 END) AS stock_out,
            SUM(CASE WHEN ${inRange} AND l.reference_type = 'RETURN' AND l.movement_type <> 'OUT' THEN l.quantity ELSE 0 END) AS returns_in,
            SUM(CASE WHEN ${inRange} AND l.reference_type = 'RETURN' AND l.movement_type = 'OUT' THEN l.quantity ELSE 0 END) AS returns_out,
            SUM(CASE WHEN ${inRange} AND l.reference_type = 'TRANSFER' THEN ${SIGNED} ELSE 0 END) AS transfers,
            SUM(CASE WHEN ${inRange} AND l.reference_type IN (${adj}) THEN ${SIGNED} ELSE 0 END) AS adjustments,
            SUM(CASE WHEN ${inRange} THEN ${SIGNED} ELSE 0 END) AS period_net
     ${ledgerFrom(t)} ${w.sql()}`,
    params
  );
  const op = num(r.opening);
  const stockIn = num(r.stock_in);
  const stockOut = num(r.stock_out);
  const returns = num(r.returns_in) - num(r.returns_out);
  const transfers = num(r.transfers);
  const adjustments = num(r.adjustments);
  const net = num(r.period_net);
  const other = net - (stockIn - stockOut + returns + transfers + adjustments);
  return {
    productId: f.productId, batchId: f.batchId, from: f.from, to: f.to,
    opening: op, stockIn, stockOut, returns, returnsIn: num(r.returns_in), returnsOut: num(r.returns_out), transfers, adjustments, other,
    closing: op + net,
  };
}

// ───────────────────────────── lookups / warehouses / transfers ─────────────────────────────
async function getLookups(db, scope) {
  const t = tables(db);
  const run = runner(db);
  const scoped = scope && scope.distributorId != null;
  const dist = scoped ? { d: Number(scope.distributorId) } : {};
  const distributors = scoped
    ? []
    : (await run(`SELECT id, name, distributor_code AS code FROM ${t.distributor} ORDER BY name ASC LIMIT 500`)).map((d) => ({ id: Number(d.id), name: d.name, code: d.code }));
  const warehouses = await run(
    `SELECT id, distributor_id, code, name, is_default, status FROM ${t.warehouse} ${scoped ? "WHERE distributor_id = :d" : ""} ORDER BY name ASC LIMIT 1000`,
    dist
  );
  const categories = await run(
    `SELECT DISTINCT category FROM ${t.product} WHERE category IS NOT NULL AND TRIM(category) <> '' ${scoped ? "AND distributor_id = :d" : ""} ORDER BY category ASC LIMIT 200`,
    dist
  );
  return {
    distributors,
    warehouses: warehouses.map((w) => ({ id: Number(w.id), distributorId: Number(w.distributor_id), code: w.code, name: w.name, isDefault: !!Number(w.is_default), status: w.status })),
    categories: categories.map((c) => c.category),
    transactionTypes: Object.entries(rules.TXN_TYPES).map(([value, v]) => ({ value, label: v.label })),
    nonSaleableReasons: Object.entries(rules.NON_SALEABLE_REASONS).map(([value, label]) => ({ value, label })),
    thresholds: { nearExpiryDays: rules.getNearExpiryDays(), lowStock: "Product reorder level (default 10 when a product is created)" },
    // Phase 6 — same 30/60/90-day thresholds as the Phase 3 Admin Dashboard (see inventoryRules.service.js); exposed
    // here so the Near Expiry / FEFO Monitor filters never hard-code the bucket labels or windows.
    expiryBuckets: rules.EXPIRY_BUCKETS,
    valuation: rules.VALUATION,
  };
}

async function listTransfers(db, query, scope) {
  const t = tables(db);
  const run = runner(db);
  const f = await parseFilters(db, query, scope);
  const { page, pageSize, offset } = q.paging(query);
  const w = where();
  if (f.distributorId) w.add("tr.distributor_id = :distId", { distId: f.distributorId });
  if (f.batchId) w.add("tr.batchId = :batchIdF", { batchIdF: f.batchId });
  if (f.productId) w.add("tr.productId = :prodId", { prodId: f.productId });
  const from = `FROM ${t.transfer} tr JOIN ${t.product} p ON p.id = tr.productId JOIN ${t.batch} b ON b.id = tr.batchId
    JOIN ${t.warehouse} fw ON fw.id = tr.from_warehouse_id JOIN ${t.warehouse} tw ON tw.id = tr.to_warehouse_id JOIN ${t.distributor} d ON d.id = tr.distributor_id ${w.sql()}`;
  const [total] = await run(`SELECT COUNT(*) AS n ${from}`, w.params);
  const rows = await run(
    `SELECT tr.id, tr.transfer_no, tr.quantity, tr.transfer_date, tr.status, tr.reason, p.name AS product_name, p.material_code AS sku, b.batch_no,
            fw.name AS from_name, fw.code AS from_code, tw.name AS to_name, tw.code AS to_code, d.name AS distributor_name, d.distributor_code, tr.distributor_id
     ${from} ORDER BY tr.transfer_date DESC, tr.id DESC LIMIT :limit OFFSET :offset`,
    { ...w.params, limit: pageSize, offset }
  );
  return {
    items: rows.map((r) => ({
      id: Number(r.id), transferNo: r.transfer_no, date: iso(r.transfer_date), status: r.status, quantity: num(r.quantity), reason: r.reason || null,
      product: r.product_name, sku: r.sku, batchNo: r.batch_no, distributor: distributorOf(r),
      from: { name: r.from_name, code: r.from_code }, to: { name: r.to_name, code: r.to_code },
    })),
    total: num(total.n), page, pageSize,
  };
}

module.exports = {
  listCurrentStock, getSummary, listBatchStock, getBatchDetail, listLedger, getMovement, getLookups, listTransfers,
  getExpiryBucketSummary,
  // exposed for parity tests
  _internal: { txnPredicate, computeBatchFefoPriority, bucketPredicate },
};
