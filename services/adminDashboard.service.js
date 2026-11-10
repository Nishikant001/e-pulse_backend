// services/adminDashboard.service.js
//
// READ-ONLY, cross-distributor aggregations for the Admin dashboard. Nothing here writes to the database.
//
// Business definitions (see docs/PHARMA_DMS_ADMIN_DASHBOARD.md — they are engineering assumptions taken from what the
// existing data model can answer and must be validated against the business requirements document):
//   Secondary sales   = SUM(netValue, i.e. before GST) of sales invoices with status POSTED / PARTIALLY_PAID / PAID,
//                       by invoiceDate.
//   Orders            = sales orders that are not DRAFT or CANCELLED, by orderDate.
//   Returns           = SUM(quantity * pricePerUnit) of POSTED sales-return lines, by returnDate.
//   Inventory value   = SUM(ledger balance * batch purchase price) over batches with a positive balance.
//   Near expiry       = positive-balance batches expiring within 30 / 60 / 90 days (critical / high / medium).
//   Outstanding       = SUM(debit - credit) on every distributor's "Accounts Receivable" GL journal entries.
//
// All SQL is portable (MySQL + SQLite) and uses named replacements; no user input is ever concatenated into SQL.

// Phase 6 (FEFO & Expiry Management): near-expiry/expired bucket totals below are now computed by
// services/inventoryQuery.service.js#getExpiryBucketSummary — the SAME function the FEFO Monitor and Near Expiry
// pages use — rather than by SQL of their own. NEAR_EXPIRY_DAYS is kept (and still exported) for backward
// compatibility with anything importing it from here, but it is now SOURCED from inventoryRules.service.js so this
// dashboard and the Phase 6 screens can never drift apart on what "critical/high/medium" mean.
const reads = require("./inventoryQuery.service");
const { EXPIRY_BUCKET_THRESHOLDS_DAYS: NEAR_EXPIRY_DAYS } = require("./inventoryRules.service");

const DAY_MS = 24 * 60 * 60 * 1000;

const SALES_STATUSES = "('POSTED','PARTIALLY_PAID','PAID')";
const ORDER_STATUSES = "('CONFIRMED','PARTIALLY_DELIVERED','FULLY_DELIVERED','CLOSED')";
const AR_GL_NAME = "Accounts Receivable"; // same canonical name used by services/accounting.service.js
const ADJUSTMENT_TYPES = "('DAMAGE','EXPIRY','BREAKAGE','PHYSICAL_COUNT','CORRECTION','ADJUSTMENT')";
const BALANCE_EXPR = "CASE WHEN movement_type = 'OUT' THEN -quantity ELSE quantity END";

// ───────────────────────── date helpers (UTC, YYYY-MM-DD) ─────────────────────────
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(s) {
  if (typeof s !== "string" || !ISO_DAY.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
const toDay = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const daysBetweenInclusive = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

// Previous period = same length, immediately before `from`.
function previousRangeOf(from, to) {
  const len = daysBetweenInclusive(from, to);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Bucket size keeps the number of chart points readable: daily ≤ 62 days, weekly ≤ 200 days, otherwise 30-day.
function bucketDays(spanDays) {
  if (spanDays <= 62) return 1;
  if (spanDays <= 200) return 7;
  return 30;
}

function buildBuckets(from, to) {
  const span = daysBetweenInclusive(from, to);
  const size = bucketDays(span);
  const buckets = [];
  for (let i = 0; i < span; i += size) {
    const start = addDays(from, i);
    buckets.push({ start: toDay(start), index: buckets.length });
  }
  return { size, span, buckets };
}

// Sum daily rows { bucket_day, ...fields } into aligned buckets.
function bucketise(rows, from, to, fields) {
  const { size, buckets } = buildBuckets(from, to);
  const out = buckets.map((b) => ({ date: b.start, ...Object.fromEntries(fields.map((f) => [f, 0])) }));
  const fromMs = from.getTime();
  for (const row of rows) {
    const day = parseDay(String(row.bucket_day).slice(0, 10));
    if (!day) continue;
    const idx = Math.floor((day.getTime() - fromMs) / DAY_MS / size);
    if (idx < 0 || idx >= out.length) continue;
    for (const f of fields) out[idx][f] += toNumber(row[f]);
  }
  return { granularityDays: size, points: out };
}

// ───────────────────────── service ─────────────────────────
async function getAdminDashboardSummary(db, { from, to, now = new Date() }) {
  const fromD = parseDay(from);
  const toD = parseDay(to);
  if (!fromD || !toD || fromD > toD) throw new RangeError("Invalid date range");

  const prev = previousRangeOf(fromD, toD);
  const rng = {
    start: fromD,
    end: addDays(toD, 1), // exclusive upper bound
    pstart: prev.from,
    pend: addDays(prev.to, 1),
  };
  const today = parseDay(toDay(now));
  const dayRep = {
    tstart: today,
    tend: addDays(today, 1),
    ystart: addDays(today, -1),
    now: today,
  };

  const T = (m) => `\`${m.getTableName()}\``;
  const tInvoice = T(db.SalesInvoiceHeader);
  const tInvoiceLine = T(db.SalesInvoiceLine);
  const tOrder = T(db.SalesOrderHeader);
  const tReturn = T(db.SalesReturn);
  const tReturnLine = T(db.SalesReturnLine);
  const tLedger = T(db.StockLedger);
  const tBatch = T(db.Batch);
  const tProduct = T(db.Product);
  const tDistributor = T(db.Distributor);
  const tCustomer = T(db.Customer);
  const tJournal = T(db.JournalEntry);
  const tGL = T(db.GLMaster);

  const q = (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

  const invRange = (a, b) => `status IN ${SALES_STATUSES} AND invoiceDate >= :${a} AND invoiceDate < :${b}`;
  const hdrRange = (a, b) => `h.status IN ${SALES_STATUSES} AND h.invoiceDate >= :${a} AND h.invoiceDate < :${b}`;
  const ordRange = (a, b) => `status IN ${ORDER_STATUSES} AND orderDate >= :${a} AND orderDate < :${b}`;

  // Stock balance per batch (derived from the ledger exactly like services/inventory.service.js).
  const balanceSub = `(SELECT batchId, SUM(${BALANCE_EXPR}) AS qty FROM ${tLedger} WHERE batchId IS NOT NULL GROUP BY batchId HAVING SUM(${BALANCE_EXPR}) > 0)`;

  const [
    [
      salesCur, salesPrev, ordersToday, ordersYesterday, activeDist, activeRet, registeredDist, registeredRet,
      trendCur, trendPrev, distSales, distSalesPrev, distOrders, distList, arByCode,
      products, categories, returnsCur, returnsPrev,
      inventory, lowStock, movement,
      recentOrders, recentInvoices, recentReturns,
    ],
    expiryBuckets,
  ] = await Promise.all([
    Promise.all([
    q(`SELECT COALESCE(SUM(netValue),0) AS total FROM ${tInvoice} WHERE ${invRange("start", "end")}`, rng),
    q(`SELECT COALESCE(SUM(netValue),0) AS total FROM ${tInvoice} WHERE ${invRange("pstart", "pend")}`, rng),
    q(`SELECT COUNT(*) AS n FROM ${tOrder} WHERE ${ordRange("tstart", "tend")}`, dayRep),
    q(`SELECT COUNT(*) AS n FROM ${tOrder} WHERE ${ordRange("ystart", "tstart")}`, dayRep),
    q(`SELECT COUNT(DISTINCT x.distributor_id) AS n FROM (
         SELECT distributor_id FROM ${tInvoice} WHERE ${invRange("start", "end")}
         UNION SELECT distributor_id FROM ${tOrder} WHERE ${ordRange("start", "end")}) x`, rng),
    q(`SELECT COUNT(DISTINCT x.customer_ref) AS n FROM (
         SELECT customer_id AS customer_ref FROM ${tInvoice} WHERE ${invRange("start", "end")}
         UNION SELECT customerId AS customer_ref FROM ${tOrder} WHERE ${ordRange("start", "end")}) x`, rng),
    q(`SELECT COUNT(*) AS n FROM ${tDistributor}`),
    q(`SELECT COUNT(*) AS n FROM ${tCustomer}`),
    q(`SELECT CAST(DATE(invoiceDate) AS CHAR) AS bucket_day, COALESCE(SUM(netValue),0) AS amount FROM ${tInvoice}
       WHERE ${invRange("start", "end")} GROUP BY CAST(DATE(invoiceDate) AS CHAR)`, rng),
    q(`SELECT CAST(DATE(invoiceDate) AS CHAR) AS bucket_day, COALESCE(SUM(netValue),0) AS amount FROM ${tInvoice}
       WHERE ${invRange("pstart", "pend")} GROUP BY CAST(DATE(invoiceDate) AS CHAR)`, rng),
    q(`SELECT distributor_id, COALESCE(SUM(netValue),0) AS sales FROM ${tInvoice} WHERE ${invRange("start", "end")} GROUP BY distributor_id`, rng),
    q(`SELECT distributor_id, COALESCE(SUM(netValue),0) AS sales FROM ${tInvoice} WHERE ${invRange("pstart", "pend")} GROUP BY distributor_id`, rng),
    q(`SELECT distributor_id, COUNT(*) AS orders FROM ${tOrder} WHERE ${ordRange("start", "end")} GROUP BY distributor_id`, rng),
    q(`SELECT id, distributor_code, name, city, region, territory FROM ${tDistributor}`),
    q(`SELECT g.distributor_code AS code, COALESCE(SUM(j.debit),0) - COALESCE(SUM(j.credit),0) AS outstanding
       FROM ${tJournal} j JOIN ${tGL} g ON g.id = j.gl_id
       WHERE g.gl_name = '${AR_GL_NAME}' GROUP BY g.distributor_code`),
    q(`SELECT MIN(p.name) AS product, MIN(p.category) AS category, COALESCE(SUM(l.taxableValue),0) AS sales,
              COALESCE(SUM(l.quantity),0) AS quantity, LOWER(TRIM(p.name)) AS pkey
       FROM ${tInvoiceLine} l JOIN ${tInvoice} h ON h.id = l.invoiceId JOIN ${tProduct} p ON p.id = l.productId
       WHERE ${hdrRange("start", "end")} AND p.name IS NOT NULL
       GROUP BY LOWER(TRIM(p.name)) ORDER BY sales DESC LIMIT 10`, rng),
    q(`SELECT COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorised') AS category, COALESCE(SUM(l.taxableValue),0) AS sales
       FROM ${tInvoiceLine} l JOIN ${tInvoice} h ON h.id = l.invoiceId JOIN ${tProduct} p ON p.id = l.productId
       WHERE ${hdrRange("start", "end")}
       GROUP BY COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorised') ORDER BY sales DESC`, rng),
    q(`SELECT COALESCE(SUM(l.quantity * l.pricePerUnit),0) AS total, COUNT(DISTINCT r.id) AS n
       FROM ${tReturn} r JOIN ${tReturnLine} l ON l.returnId = r.id
       WHERE r.status = 'POSTED' AND r.returnDate >= :start AND r.returnDate < :end`, rng),
    q(`SELECT COALESCE(SUM(l.quantity * l.pricePerUnit),0) AS total
       FROM ${tReturn} r JOIN ${tReturnLine} l ON l.returnId = r.id
       WHERE r.status = 'POSTED' AND r.returnDate >= :pstart AND r.returnDate < :pend`, rng),
    q(`SELECT COALESCE(SUM(bal.qty * COALESCE(b.purchase_price,0)),0) AS stock_value, COALESCE(SUM(bal.qty),0) AS units, COUNT(*) AS batches
       FROM ${balanceSub} bal JOIN ${tBatch} b ON b.id = bal.batchId`),
    q(`SELECT COUNT(*) AS n FROM (
         SELECT p.id AS pid, p.reorder_level AS reorder, SUM(${BALANCE_EXPR.replace(/movement_type/g, "s.movement_type").replace(/quantity/g, "s.quantity")}) AS qty
         FROM ${tProduct} p JOIN ${tLedger} s ON s.productId = p.id
         WHERE p.reorder_level > 0 GROUP BY p.id, p.reorder_level) t
       WHERE t.qty <= t.reorder`),
    q(`SELECT CAST(DATE(createdAt) AS CHAR) AS bucket_day,
              SUM(CASE WHEN movement_type = 'IN' AND reference_type IN ('OPENING','PURCHASE') THEN quantity ELSE 0 END) AS stockIn,
              SUM(CASE WHEN movement_type = 'OUT' AND reference_type IN ('SALES','RETURN') THEN quantity ELSE 0 END) AS stockOut,
              SUM(CASE WHEN movement_type = 'IN' AND reference_type = 'RETURN' THEN quantity ELSE 0 END) AS salesReturns,
              SUM(CASE WHEN movement_type = 'ADJUST' OR reference_type IN ${ADJUSTMENT_TYPES} THEN quantity ELSE 0 END) AS adjustments
       FROM ${tLedger} WHERE createdAt >= :start AND createdAt < :end GROUP BY CAST(DATE(createdAt) AS CHAR)`, rng),
    q(`SELECT o.id AS id, o.order_number AS reference, o.status AS status, o.updatedAt AS event_at, d.name AS distributor
       FROM ${tOrder} o LEFT JOIN ${tDistributor} d ON d.id = o.distributor_id
       WHERE o.status <> 'DRAFT' ORDER BY o.updatedAt DESC LIMIT 10`),
    q(`SELECT h.id AS id, h.invoice_number AS reference, h.status AS status, COALESCE(h.postedAt, h.updatedAt) AS event_at, d.name AS distributor
       FROM ${tInvoice} h LEFT JOIN ${tDistributor} d ON d.id = h.distributor_id
       WHERE h.status <> 'DRAFT' ORDER BY event_at DESC LIMIT 10`),
    q(`SELECT r.id AS id, r.return_number AS reference, r.status AS status, r.updatedAt AS event_at, d.name AS distributor
       FROM ${tReturn} r LEFT JOIN ${tDistributor} d ON d.id = r.distributor_id
       WHERE r.status <> 'DRAFT' ORDER BY r.updatedAt DESC LIMIT 10`),
    ]),
    // Phase 6: near-expiry / expired totals now come from the one shared function (see the top-of-file comment)
    // instead of SQL of their own; cross-tenant (distributorId: null), same as every other dashboard total.
    reads.getExpiryBucketSummary(db, { distributorId: null }, { now: dayRep.now }),
  ]);

  // Top products need previous-period sales for the same product keys (growth).
  const productKeys = products.map((p) => p.pkey);
  const productsPrev = productKeys.length
    ? await q(
        `SELECT LOWER(TRIM(p.name)) AS pkey, COALESCE(SUM(l.taxableValue),0) AS sales
         FROM ${tInvoiceLine} l JOIN ${tInvoice} h ON h.id = l.invoiceId JOIN ${tProduct} p ON p.id = l.productId
         WHERE ${hdrRange("pstart", "pend")} AND LOWER(TRIM(p.name)) IN (:keys) GROUP BY LOWER(TRIM(p.name))`,
        { ...rng, keys: productKeys }
      )
    : [];

  // ── KPIs ─────────────────────────────────────────────────────────────
  const salesNow = toNumber(salesCur[0]?.total);
  const salesBefore = toNumber(salesPrev[0]?.total);
  const returnsNow = toNumber(returnsCur[0]?.total);
  const returnsBefore = toNumber(returnsPrev[0]?.total);
  const ordToday = toNumber(ordersToday[0]?.n);
  const ordYesterday = toNumber(ordersYesterday[0]?.n);

  // expiryBuckets already has exactly this shape — {critical,high,medium,healthy,expired} each {batches,products,units,value} —
  // computed by inventoryQuery.service.getExpiryBucketSummary (see above); nothing left to assemble from raw rows here.
  const expiry = expiryBuckets;
  const empty = () => ({ batches: 0, products: 0, units: 0, value: 0 });
  const nearExpiryBuckets = { critical: expiry.critical || empty(), high: expiry.high || empty(), medium: expiry.medium || empty() };
  const nearTotals = Object.values(nearExpiryBuckets).reduce(
    (acc, b) => ({ batches: acc.batches + b.batches, products: acc.products + b.products, units: acc.units + b.units, value: acc.value + b.value }),
    empty()
  );
  const inv = inventory[0] || {};
  const arRows = new Map(arByCode.map((r) => [String(r.code), toNumber(r.outstanding)]));
  const outstanding = arByCode.length ? [...arRows.values()].reduce((a, b) => a + b, 0) : null; // null → no receivable ledger exists yet

  // ── Distributors ─────────────────────────────────────────────────────
  const prevSalesById = new Map(distSalesPrev.map((r) => [Number(r.distributor_id), toNumber(r.sales)]));
  const ordersById = new Map(distOrders.map((r) => [Number(r.distributor_id), toNumber(r.orders)]));
  const distById = new Map(distList.map((d) => [Number(d.id), d]));
  const distributors = distSales
    .map((r) => ({ id: Number(r.distributor_id), sales: toNumber(r.sales) }))
    .filter((r) => r.sales > 0)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 10)
    .map((r, i) => {
      const d = distById.get(r.id) || {};
      const previousSales = prevSalesById.get(r.id) || 0;
      return {
        rank: i + 1,
        id: r.id,
        code: d.distributor_code || null,
        name: d.name || `Distributor #${r.id}`,
        territory: d.territory || d.city || d.region || null,
        sales: r.sales,
        previousSales,
        growthPct: pct(r.sales, previousSales),
        orders: ordersById.get(r.id) || 0,
        outstanding: d.distributor_code && arRows.has(String(d.distributor_code)) ? arRows.get(String(d.distributor_code)) : null,
        status: "active",
      };
    });

  // ── Products / categories ────────────────────────────────────────────
  const prevProd = new Map(productsPrev.map((r) => [r.pkey, toNumber(r.sales)]));
  const topProducts = products.map((p, i) => ({
    rank: i + 1,
    name: p.product,
    category: (p.category || "").trim() || "Uncategorised",
    sales: toNumber(p.sales),
    quantity: toNumber(p.quantity),
    growthPct: pct(toNumber(p.sales), prevProd.get(p.pkey) || 0),
  }));

  const catTotal = categories.reduce((a, c) => a + toNumber(c.sales), 0);
  let categoryRows = categories.map((c) => ({ name: c.category, sales: toNumber(c.sales) }));
  if (categoryRows.length > 8) {
    const head = categoryRows.slice(0, 7);
    const tail = categoryRows.slice(7).reduce((a, c) => a + c.sales, 0);
    categoryRows = [...head, { name: "Other", sales: tail }];
  }
  categoryRows = categoryRows.map((c) => ({ ...c, share: catTotal > 0 ? Math.round((c.sales / catTotal) * 1000) / 10 : 0 }));

  // ── Trend + movement (aligned current vs previous buckets) ───────────
  const cur = bucketise(trendCur, fromD, toD, ["amount"]);
  const prv = bucketise(trendPrev, prev.from, prev.to, ["amount"]);
  const salesTrend = {
    granularityDays: cur.granularityDays,
    points: cur.points.map((p, i) => ({ date: p.date, current: p.amount, previous: prv.points[i] ? prv.points[i].amount : 0 })),
  };
  const mv = bucketise(movement, fromD, toD, ["stockIn", "stockOut", "salesReturns", "adjustments"]);
  const stockMovement = { unit: "units", granularityDays: mv.granularityDays, points: mv.points };

  // ── Activity (derived from the latest business documents — NOT an audit log) ─────
  const ORDER_ACTION = { CONFIRMED: "Sales order confirmed", PARTIALLY_DELIVERED: "Sales order partially delivered", FULLY_DELIVERED: "Sales order fully delivered", CLOSED: "Sales order closed", CANCELLED: "Sales order cancelled" };
  const INVOICE_ACTION = { POSTED: "Invoice posted", PARTIALLY_PAID: "Invoice partially paid", PAID: "Invoice paid", CANCELLED: "Invoice cancelled" };
  const RETURN_ACTION = { POSTED: "Sales return posted", CANCELLED: "Sales return cancelled" };
  const mapActivity = (rows, module, kind, actions) =>
    rows.map((r) => ({ id: `${kind}-${r.id}`, module, action: actions[r.status] || `${module} ${String(r.status).toLowerCase()}`, status: r.status, reference: r.reference || null, distributor: r.distributor || null, at: toIso(r.event_at) }));
  const activity = [
    ...mapActivity(recentOrders, "Sales Orders", "order", ORDER_ACTION),
    ...mapActivity(recentInvoices, "Sales Invoices", "invoice", INVOICE_ACTION),
    ...mapActivity(recentReturns, "Sales Returns", "return", RETURN_ACTION),
  ]
    .filter((a) => a.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);

  // ── Alerts (only conditions the current data model can actually detect) ──────
  const alerts = [];
  if (nearExpiryBuckets.critical.batches > 0) alerts.push({ id: "near-expiry-critical", code: "NEAR_EXPIRY_CRITICAL", tone: "error", count: nearExpiryBuckets.critical.batches, value: nearExpiryBuckets.critical.value });
  if (expiry.expired && expiry.expired.batches > 0) alerts.push({ id: "expired-stock", code: "EXPIRED_STOCK", tone: "error", count: expiry.expired.batches, value: expiry.expired.value });
  if (nearExpiryBuckets.high.batches > 0) alerts.push({ id: "near-expiry-high", code: "NEAR_EXPIRY_HIGH", tone: "warning", count: nearExpiryBuckets.high.batches, value: nearExpiryBuckets.high.value });
  const lowStockCount = toNumber(lowStock[0]?.n);
  if (lowStockCount > 0) alerts.push({ id: "low-stock", code: "LOW_STOCK", tone: "warning", count: lowStockCount });

  return {
    meta: {
      generatedAt: now.toISOString(),
      range: { from: toDay(fromD), to: toDay(toD) },
      previousRange: { from: toDay(prev.from), to: toDay(prev.to) },
      asOf: toDay(today),
      timezone: "UTC",
      // Which figures follow the selected range and which are point-in-time snapshots.
      appliedTo: {
        range: ["totalSecondarySales", "activeDistributors", "activeRetailers", "salesReturns", "salesTrend", "distributors", "topProducts", "categories", "stockMovement"],
        today: ["todaysOrders"],
        snapshot: ["currentInventory", "nearExpiryStock", "outstanding", "nearExpiry", "alerts", "activity"],
      },
      nearExpiryThresholdsDays: NEAR_EXPIRY_DAYS,
    },
    kpis: {
      totalSecondarySales: { value: salesNow, previous: salesBefore, changePct: pct(salesNow, salesBefore) },
      todaysOrders: { value: ordToday, previous: ordYesterday, changePct: pct(ordToday, ordYesterday) },
      activeDistributors: { value: toNumber(activeDist[0]?.n), registered: toNumber(registeredDist[0]?.n) },
      activeRetailers: { value: toNumber(activeRet[0]?.n), registered: toNumber(registeredRet[0]?.n) },
      currentInventory: { value: toNumber(inv.stock_value), units: toNumber(inv.units), batches: toNumber(inv.batches) },
      nearExpiryStock: { value: nearTotals.value, batches: nearTotals.batches },
      salesReturns: { value: returnsNow, previous: returnsBefore, changePct: pct(returnsNow, returnsBefore), count: toNumber(returnsCur[0]?.n) },
      outstanding: { value: outstanding },
    },
    salesTrend,
    distributors,
    categories: categoryRows,
    stockMovement,
    nearExpiry: { buckets: nearExpiryBuckets, totals: nearTotals, expired: expiry.expired || empty() },
    topProducts,
    activity,
    alerts,
    sap: { status: "not_configured" }, // honest: there is no SAP integration yet
  };
}

// ───────────────────────── ERP health card (Phase 21) ─────────────────────────
// The dashboard used to hard-code `sap: { status: "not_configured" }` even after the ERP monitoring of Phases 13–20 existed. This block reports the
// REAL state of the session tenant's ERP connections, from the same service the ERP monitoring screens use (services/erpMonitoring.service.js).
//
// Standalone rules (the DMS must work with no ERP):
//   * no connection at all           → configured:false  (a normal, healthy standalone state — never an error)
//   * the admin role lacks ERP_VIEW  → access "RESTRICTED": no ERP figure is disclosed to roles the ERP routes would refuse
//   * any failure while reading ERP  → access "UNAVAILABLE": the rest of the dashboard is returned unchanged; nothing is thrown
// It never contacts an ERP (database reads only), so an unreachable ERP cannot slow or break the dashboard.
const HEALTH_RANK = { UNKNOWN: 0, HEALTHY: 1, WARNING: 2, ERROR: 3 };
async function getErpHealthBlock(db, { tenantKey, role, now = new Date() } = {}) {
  const { roleHas } = require("../config/erpPermissions");
  if (!roleHas(role, "ERP_VIEW")) return { access: "RESTRICTED" };
  try {
    const s = await require("./erpMonitoring.service").getSummary(db, tenantKey, { now });
    if (!s.connections) return { access: "OK", configured: false, connections: 0, activeConnections: 0 };
    const active = s.perConnection.filter((c) => c.status === "ACTIVE");
    const health = active.length ? active.map((c) => c.health.status).reduce((w, h) => (HEALTH_RANK[h] > HEALTH_RANK[w] ? h : w), "UNKNOWN") : null;
    return {
      access: "OK", configured: true, connections: s.connections, activeConnections: s.activeConnections, errorConnections: s.errorConnections,
      health, // worst sync health among ACTIVE connections; null when none is active. This is sync history, NOT a live reachability check.
      failedSyncsLast7Days: s.failedSyncsLast7Days, partialSyncsLast7Days: s.partialSyncsLast7Days,
      runningSyncs: s.runningSyncs, queuedSyncs: s.queuedSyncs, openAlerts: Array.isArray(s.alerts) ? s.alerts.length : 0,
      lastSuccessfulSync: s.lastSuccessfulSync ? { at: s.lastSuccessfulSync.at, capability: s.lastSuccessfulSync.capability } : null,
      lastFailedSync: s.lastFailedSync ? { at: s.lastFailedSync.at, capability: s.lastFailedSync.capability } : null,
      asOf: now.toISOString(),
    };
  } catch (err) {
    console.error("admin dashboard ERP health unavailable:", err && err.name);
    return { access: "UNAVAILABLE" };
  }
}

module.exports = { getErpHealthBlock, getAdminDashboardSummary, parseDay, toDay, addDays, previousRangeOf, daysBetweenInclusive, bucketDays, buildBuckets, bucketise, toIso, toNumber, NEAR_EXPIRY_DAYS };
