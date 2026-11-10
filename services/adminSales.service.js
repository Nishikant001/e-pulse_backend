// services/adminSales.service.js
//
// READ-ONLY, cross-distributor queries behind the Admin "Sales" screens: Sales Orders, Sales Invoices, Secondary Sales.
// Nothing here writes. All filtering, searching, sorting and pagination happen in SQL (never in the browser), every value is
// bound as a named replacement (nothing user-supplied is concatenated), sort columns come from whitelists, and LIKE terms
// are escaped. SQL is portable (MySQL + SQLite).
//
// Reuses: tax.service / salesLineCalc.service (GST + line arithmetic), salesStatus.service (status + allowed actions),
// adminDashboard.service (date bucketing). Nothing about stock, pricing or accounting is recalculated here.
const tax = require("./tax.service");
const { computeLineAmounts, computeTotals } = require("./salesLineCalc.service");
const status = require("./salesStatus.service");
const q = require("./salesQuery");
const dash = require("./adminDashboard.service");

const SALES_INVOICE_STATUSES = "('POSTED','PARTIALLY_PAID','PAID')"; // counted as secondary sales (same rule as the Admin dashboard)
const TERRITORY = "COALESCE(NULLIF(d.territory,''), NULLIF(d.city,''), NULLIF(d.region,''))"; // Phase 8: explicit territory first, then city / state (same as Admin dashboard + Distributor Management)
const CATEGORY = "COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorised')";

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => tax.round2(num(v));
const dayOf = (v) => {
  const iso = dash.toIso(v);
  return iso ? iso.slice(0, 10) : null;
};

function tables(db) {
  const t = (m) => `\`${m.getTableName()}\``;
  return {
    order: t(db.SalesOrderHeader), line: t(db.SalesOrderLine), delivery: t(db.SalesDeliveryHeader), deliveryLine: t(db.SalesDeliveryLine),
    invoice: t(db.SalesInvoiceHeader), invoiceLine: t(db.SalesInvoiceLine), distributor: t(db.Distributor), customer: t(db.Customer),
    product: t(db.Product), batch: t(db.Batch), ledger: t(db.StockLedger), sap: t(db.SapSyncRecord), hsn: t(db.HSNGroup),
  };
}
const runner = (db) => (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

// Small WHERE builder: add(sql, params) keeps clauses and bound values together.
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
const dayEndExclusive = (s) => new Date(dayStart(s).getTime() + 24 * 60 * 60 * 1000);

// ══════════════════════════════════ lookups ══════════════════════════════════
async function getFilterLookups(db) {
  const t = tables(db);
  const run = runner(db);
  const [distributors, territories, categories] = await Promise.all([
    run(`SELECT d.id AS id, d.distributor_code AS code, d.name AS name, ${TERRITORY} AS territory FROM ${t.distributor} d ORDER BY d.name LIMIT 1000`),
    run(`SELECT DISTINCT ${TERRITORY} AS territory FROM ${t.distributor} d WHERE ${TERRITORY} IS NOT NULL ORDER BY territory LIMIT 500`),
    run(`SELECT DISTINCT ${CATEGORY} AS category FROM ${t.product} p ORDER BY category LIMIT 200`),
  ]);
  return {
    distributors: distributors.map((d) => ({ id: Number(d.id), code: d.code, name: d.name, territory: d.territory || null })),
    territories: territories.map((r) => r.territory),
    categories: categories.map((r) => r.category),
  };
}

async function getRetailerLookup(db, query) {
  const distributorId = q.intId(query.distributorId, "distributorId");
  if (!distributorId) throw new q.QueryError("distributorId is required");
  const search = q.text(query.q, "q");
  const t = tables(db);
  const w = where();
  w.add("c.distributor_id = :distributorId", { distributorId });
  if (search) w.add("(LOWER(c.name) LIKE :s ESCAPE '!' OR LOWER(COALESCE(c.customer_code,'')) LIKE :s ESCAPE '!')", { s: q.likeTerm(search) });
  const rows = await runner(db)(
    `SELECT c.id AS id, c.name AS name, c.customer_code AS code, c.city AS city, c.region AS region, c.taxNumber AS gstin, c.customer_group_id AS group_id
     FROM ${t.customer} c ${w.sql()} ORDER BY c.name LIMIT 500`,
    w.params
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, code: r.code || null, territory: r.city || r.region || null, gstin: r.gstin || null }));
}

async function getProductLookup(db, query) {
  const distributorId = q.intId(query.distributorId, "distributorId");
  if (!distributorId) throw new q.QueryError("distributorId is required");
  const search = q.text(query.q, "q");
  const t = tables(db);
  const w = where();
  w.add("p.distributor_id = :distributorId", { distributorId });
  if (search) w.add("(LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!')", { s: q.likeTerm(search) });
  const rows = await runner(db)(
    `SELECT p.id AS id, p.name AS name, p.material_code AS sku, p.unit AS unit, ${CATEGORY} AS category, h.hsn_code AS hsn,
            p.gst AS gst, p.cgst AS cgst, p.sgst AS sgst
     FROM ${t.product} p LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id ${w.sql()} ORDER BY p.name LIMIT 500`,
    w.params
  );
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, sku: r.sku, unit: r.unit || null, category: r.category, hsn: r.hsn || null,
    gstRate: r.gst !== null && r.gst !== undefined ? num(r.gst) : num(r.cgst) + num(r.sgst),
  }));
}

// Batches of a product with their saleable stock. Uses the EXISTING inventory.service for the balance and the
// saleable rule (active, not expired, positive balance); non-saleable batches that still hold stock are returned flagged so the
// UI can show them disabled with a reason instead of hiding them.
async function getBatchLookup(db, query) {
  const distributorId = q.intId(query.distributorId, "distributorId");
  const productId = q.intId(query.productId, "productId");
  if (!distributorId || !productId) throw new q.QueryError("distributorId and productId are required");
  const inventory = require("./inventory.service");
  const product = await db.Product.findOne({ where: { id: productId, distributor_id: distributorId } });
  if (!product) throw Object.assign(new q.QueryError("Product not found for this distributor"), { statusCode: 404 });
  const rows = await inventory.getAvailableBatches({ productId, distributorId, includeInactive: true, includeExpired: true });
  const now = new Date();
  return rows.map(({ batch, available }) => {
    const expired = batch.exp_date ? new Date(batch.exp_date) < now : false;
    const inactive = batch.status !== "active";
    return {
      id: batch.id,
      batchNo: batch.batch_no,
      mfgDate: dayOf(batch.mfg_date),
      expDate: dayOf(batch.exp_date),
      available,
      mrp: null, // MRP is not captured in the current data model (planned: Product/Batch Master phase)
      salePrice: null, // the sale price is resolved per retailer by the pricing service (see order preview)
      saleable: !expired && !inactive && available > 0,
      reason: expired ? "EXPIRED" : inactive ? "NOT_SALEABLE" : null,
    };
  });
}

// ══════════════════════════════════ Sales Orders ══════════════════════════════════
function orderBaseSql(t) {
  return `SELECT o.id AS id, o.order_number AS order_number, o.orderDate AS order_date, o.status AS raw_status,
    o.distributor_id AS distributor_id, d.name AS distributor_name, d.distributor_code AS distributor_code, ${TERRITORY} AS territory,
    o.customerId AS retailer_id, COALESCE(c.name, o.customerName) AS retailer_name, o.paymentMethod AS payment_terms,
    o.totalAmount AS amount, o.createdAt AS created_at, o.updatedAt AS updated_at,
    (SELECT COUNT(*) FROM ${t.line} l WHERE l.orderId = o.id) AS product_count,
    (SELECT COALESCE(SUM(l.quantity),0) FROM ${t.line} l WHERE l.orderId = o.id) AS quantity,
    ((SELECT COALESCE(SUM(l.quantity),0) FROM ${t.line} l WHERE l.orderId = o.id)
      - (SELECT COALESCE(SUM(dl.quantityDelivered),0) FROM ${t.deliveryLine} dl JOIN ${t.delivery} dh ON dh.id = dl.deliveryId
         WHERE dh.orderId = o.id AND dh.status <> 'Cancelled')) AS remaining_qty,
    (SELECT COUNT(*) FROM ${t.delivery} dh WHERE dh.orderId = o.id AND dh.status <> 'Cancelled') AS deliveries,
    (SELECT COUNT(*) FROM ${t.delivery} dh WHERE dh.orderId = o.id AND dh.status <> 'Cancelled'
       AND NOT EXISTS (SELECT 1 FROM ${t.invoice} i WHERE i.deliveryId = dh.id AND i.status <> 'CANCELLED')) AS uninvoiced_deliveries,
    sr.status AS sap_raw, sr.sap_document_no AS sap_document_no
  FROM ${t.order} o
  JOIN ${t.distributor} d ON d.id = o.distributor_id
  LEFT JOIN ${t.customer} c ON c.id = o.customerId
  LEFT JOIN ${t.sap} sr ON sr.entity_type = 'SALES_ORDER' AND sr.entity_id = o.id`;
}

// x = base row; y = base row + derived display status + effective SAP status (so both can be filtered/sorted in SQL).
function orderWrapped(t, innerWhere) {
  return `SELECT x.*, ${status.ORDER_DISPLAY_SQL} AS display_status,
            CASE WHEN x.raw_status IN ('DRAFT','CANCELLED') THEN NULL ELSE COALESCE(x.sap_raw, 'PENDING') END AS sap_status
          FROM (${orderBaseSql(t)} ${innerWhere}) x`;
}

const ORDER_SORT = {
  order_number: "y.order_number", order_date: "y.order_date", distributor_name: "y.distributor_name", retailer_name: "y.retailer_name",
  product_count: "y.product_count", quantity: "y.quantity", amount: "y.amount", status: "y.display_status",
};

function mapOrderRow(r) {
  const rawStatus = r.raw_status;
  const facts = { status: rawStatus, remainingQty: num(r.remaining_qty), uninvoicedDeliveries: num(r.uninvoiced_deliveries) };
  return {
    id: Number(r.id),
    orderNumber: r.order_number,
    orderDate: dayOf(r.order_date),
    distributor: { id: Number(r.distributor_id), code: r.distributor_code, name: r.distributor_name },
    retailer: { id: r.retailer_id === null ? null : Number(r.retailer_id), name: r.retailer_name },
    territory: r.territory || null,
    paymentTerms: r.payment_terms || null,
    productCount: num(r.product_count),
    quantity: num(r.quantity),
    amount: money(r.amount),
    scheme: null, // no scheme data exists yet (Scheme Engine: later phase)
    status: r.display_status,
    rawStatus,
    sapStatus: r.sap_status || null,
    sapDocumentNo: r.sap_document_no || null,
    actions: status.allowedOrderActions(facts),
  };
}

async function listOrders(db, query) {
  const t = tables(db);
  const run = runner(db);
  const pg = q.paging(query);
  const sort = q.sorting(query, ORDER_SORT, { key: "order_date", dir: "desc" });

  const from = q.day(query.from, "from");
  const to = q.day(query.to, "to");
  if (from && to && from > to) throw new q.QueryError("from must be on or before to");
  const distributorId = q.intId(query.distributorId, "distributorId");
  const retailer = q.text(query.retailer, "retailer");
  const territory = q.text(query.territory, "territory");
  const search = q.text(query.q, "q");
  const st = q.oneOf(query.status, status.ORDER_DISPLAY, "status");
  const sap = q.oneOf(query.sap, status.SAP_STATUSES, "sap", (s) => s.toUpperCase());

  const inner = where();
  if (from) inner.add("o.orderDate >= :from", { from: dayStart(from) });
  if (to) inner.add("o.orderDate < :toEnd", { toEnd: dayEndExclusive(to) });
  if (distributorId) inner.add("o.distributor_id = :distributorId", { distributorId });
  if (retailer) inner.add("LOWER(COALESCE(c.name, o.customerName)) LIKE :retailer ESCAPE '!'", { retailer: q.likeTerm(retailer) });
  if (territory) inner.add(`${TERRITORY} = :territory`, { territory });
  if (search) {
    inner.add(
      `(LOWER(o.order_number) LIKE :s ESCAPE '!' OR LOWER(d.name) LIKE :s ESCAPE '!' OR LOWER(d.distributor_code) LIKE :s ESCAPE '!'
        OR LOWER(COALESCE(c.name, o.customerName, '')) LIKE :s ESCAPE '!' OR LOWER(COALESCE(sr.sap_document_no, '')) LIKE :s ESCAPE '!'
        OR EXISTS (SELECT 1 FROM ${t.invoice} i JOIN ${t.delivery} dh ON dh.id = i.deliveryId WHERE dh.orderId = o.id AND LOWER(i.invoice_number) LIKE :s ESCAPE '!'))`,
      { s: q.likeTerm(search) }
    );
  }
  const outer = where();
  if (st) outer.add("y.display_status = :st", { st });
  if (sap) outer.add("y.sap_status = :sap", { sap });

  const wrapped = `SELECT y.* FROM (${orderWrapped(t, inner.sql())}) y ${outer.sql()}`;
  const params = { ...inner.params, ...outer.params };
  const [rows, count] = await Promise.all([
    run(`${wrapped} ORDER BY ${sort.column} ${sort.dir}, y.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params),
    run(`SELECT COUNT(*) AS n FROM (${wrapped}) z`, params),
  ]);
  return { items: rows.map(mapOrderRow), page: pg.page, pageSize: pg.pageSize, total: num(count[0]?.n) };
}

function computeOrderLine(l) {
  const amounts = computeLineAmounts({
    unitPrice: l.price, quantity: l.quantity, discountPercent: l.discount,
    product: { gst: l.gst, cgst: l.cgst, sgst: l.sgst, igst: l.igst },
  });
  return amounts;
}

const STAGES = [
  { key: "draft", label: "Order created" },
  { key: "confirmed", label: "Confirmed" },
  { key: "processing", label: "Processing" },
  { key: "invoiced", label: "Invoiced" },
  { key: "synced", label: "SAP synced" },
];
const STAGE_RANK = { draft: 0, confirmed: 1, processing: 2, invoiced: 3, synced: 4 };

async function getOrder(db, idInput) {
  const id = q.intId(idInput, "id");
  if (!id) throw new q.QueryError("id is required");
  const t = tables(db);
  const run = runner(db);

  const head = await run(`SELECT y.* FROM (${orderWrapped(t, "WHERE o.id = :id")}) y`, { id });
  if (head.length === 0) return null;
  const r = head[0];

  const [extra, lines, deliveries, sapRows] = await Promise.all([
    run(
      `SELECT o.description AS remarks, o.billingAddress AS billing_address, o.shippingAddress AS shipping_address, o.expectedDeliveryDate AS expected_delivery,
              o.netValue AS taxable, o.cgstAmount AS cgst, o.sgstAmount AS sgst, o.igstAmount AS igst,
              c.taxNumber AS retailer_gstin, c.street1 AS c_street1, c.street2 AS c_street2, c.city AS c_city, c.pincode AS c_pincode, c.region AS c_region,
              d.tax_no AS distributor_gstin
       FROM ${t.order} o JOIN ${t.distributor} d ON d.id = o.distributor_id LEFT JOIN ${t.customer} c ON c.id = o.customerId WHERE o.id = :id`,
      { id }
    ),
    run(
      `SELECT l.id AS line_id, l.productId AS product_id, l.batchId AS batch_id, l.quantity AS quantity, l.pricePerUnit AS price, l.discount AS discount, l.lineNetValue AS stored_net,
              p.name AS product_name, p.material_code AS sku, p.unit AS unit, ${CATEGORY} AS category, p.gst AS gst, p.cgst AS cgst, p.sgst AS sgst, p.igst AS igst,
              h.hsn_code AS hsn, b.batch_no AS batch_no, b.mfg_date AS mfg_date, b.exp_date AS exp_date, b.status AS batch_status,
              (SELECT COALESCE(SUM(dl.quantityDelivered),0) FROM ${t.deliveryLine} dl JOIN ${t.delivery} dh ON dh.id = dl.deliveryId
                 WHERE dl.orderLineId = l.id AND dh.status <> 'Cancelled') AS delivered_qty
       FROM ${t.line} l JOIN ${t.product} p ON p.id = l.productId LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id LEFT JOIN ${t.batch} b ON b.id = l.batchId
       WHERE l.orderId = :id ORDER BY l.id`,
      { id }
    ),
    run(
      `SELECT dh.id AS id, dh.deliveryDate AS delivery_date, dh.status AS status, dh.createdAt AS created_at,
              (SELECT COALESCE(SUM(dl.quantityDelivered),0) FROM ${t.deliveryLine} dl WHERE dl.deliveryId = dh.id) AS quantity,
              i.id AS invoice_id, i.invoice_number AS invoice_number, i.status AS invoice_status, i.invoiceDate AS invoice_date, i.postedAt AS posted_at, i.createdAt AS invoice_created_at
       FROM ${t.delivery} dh LEFT JOIN ${t.invoice} i ON i.deliveryId = dh.id AND i.status <> 'CANCELLED' WHERE dh.orderId = :id ORDER BY dh.id`,
      { id }
    ),
    run(`SELECT status, sap_document_no, last_attempt_at, last_error FROM ${t.sap} WHERE entity_type = 'SALES_ORDER' AND entity_id = :id`, { id }),
  ]);
  const e = extra[0] || {};

  const outLines = lines.map((l) => {
    const a = computeOrderLine(l);
    return {
      id: Number(l.line_id), productId: Number(l.product_id), product: l.product_name, sku: l.sku, hsn: l.hsn || null, unit: l.unit || null, category: l.category,
      batch: l.batch_id ? { id: Number(l.batch_id), batchNo: l.batch_no, mfgDate: dayOf(l.mfg_date), expDate: dayOf(l.exp_date), status: l.batch_status } : null,
      quantity: num(l.quantity), deliveredQuantity: num(l.delivered_qty), mrp: null, dealerPrice: money(l.price), discountPercent: num(l.discount),
      gstRate: a.cgstRate + a.sgstRate + a.igstRate, ...a, storedNet: money(l.stored_net),
    };
  });
  const totals = computeTotals(outLines);
  // Header totals are the values the order stored at creation; lines are recomputed with the current GST rates for display.
  const stored = { taxable: money(e.taxable), cgst: money(e.cgst), sgst: money(e.sgst), igst: money(e.igst), grandTotal: money(r.amount) };

  const order = mapOrderRow(r);
  const sapRow = sapRows[0] || null;
  const events = [{ key: "created", label: "Order created", at: dash.toIso(r.created_at), detail: null }];
  for (const d of deliveries) {
    events.push({ key: `delivery-${d.id}`, label: `Delivery ${d.status === "Cancelled" ? "cancelled" : "recorded"}`, at: dash.toIso(d.delivery_date || d.created_at), detail: `${num(d.quantity)} units` });
    if (d.invoice_id) events.push({ key: `invoice-${d.invoice_id}`, label: `Invoice ${d.invoice_number} ${String(d.invoice_status).toLowerCase().replace("_", " ")}`, at: dash.toIso(d.posted_at || d.invoice_date || d.invoice_created_at), detail: null });
  }
  if (order.rawStatus === "CANCELLED") events.push({ key: "cancelled", label: "Order cancelled (time is the last update)", at: dash.toIso(r.updated_at), detail: null });
  if (sapRow && sapRow.last_attempt_at) events.push({ key: "sap", label: `SAP ${String(sapRow.status).toLowerCase()}`, at: dash.toIso(sapRow.last_attempt_at), detail: sapRow.sap_document_no || sapRow.last_error || null });
  events.sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  const rank = STAGE_RANK[order.status] ?? 0;
  const cancelled = order.status === "cancelled";
  return {
    order: {
      ...order,
      remarks: e.remarks || null,
      billingAddress: e.billing_address || null,
      shippingAddress: e.shipping_address || null,
      expectedDelivery: dayOf(e.expected_delivery),
      distributorGstin: e.distributor_gstin || null,
      retailerGstin: e.retailer_gstin || null,
      retailerAddress: [e.c_street1, e.c_street2, e.c_city, e.c_pincode].filter(Boolean).join(", ") || null,
    },
    lines: outLines,
    totals: { ...totals, stored },
    deliveries: deliveries.map((d) => ({ id: Number(d.id), date: dayOf(d.delivery_date), status: d.status, quantity: num(d.quantity), invoiceId: d.invoice_id ? Number(d.invoice_id) : null, invoiceNumber: d.invoice_number || null, invoiceStatus: d.invoice_status || null })),
    stages: STAGES.map((s, i) => ({ ...s, reached: !cancelled && i <= rank, current: !cancelled && i === rank })),
    events,
    sap: order.sapStatus ? { status: order.sapStatus, documentNo: order.sapDocumentNo, lastAttemptAt: sapRow ? dash.toIso(sapRow.last_attempt_at) : null, lastError: sapRow ? sapRow.last_error || null : null } : null,
  };
}

// ══════════════════════════════════ Sales Invoices ══════════════════════════════════
function invoiceBaseSql(t) {
  return `SELECT h.id AS id, h.invoice_number AS invoice_number, h.invoiceDate AS invoice_date, h.status AS raw_status, h.paymentTerms AS payment_terms,
    h.distributor_id AS distributor_id, d.name AS distributor_name, d.distributor_code AS distributor_code, ${TERRITORY} AS territory,
    h.customer_id AS retailer_id, c.name AS retailer_name, h.totalAmount AS invoice_value, h.outstandingAmount AS outstanding, h.dueDate AS due_date,
    so.order_number AS order_number, h.createdAt AS created_at,
    (SELECT COUNT(*) FROM ${t.invoiceLine} il WHERE il.invoiceId = h.id) AS product_count,
    (SELECT COALESCE(SUM(il.quantity),0) FROM ${t.invoiceLine} il WHERE il.invoiceId = h.id) AS quantity,
    sr.status AS sap_raw, sr.sap_document_no AS sap_document_no
  FROM ${t.invoice} h
  JOIN ${t.distributor} d ON d.id = h.distributor_id
  LEFT JOIN ${t.customer} c ON c.id = h.customer_id
  LEFT JOIN ${t.delivery} dh ON dh.id = h.deliveryId
  LEFT JOIN ${t.order} so ON so.id = dh.orderId
  LEFT JOIN ${t.sap} sr ON sr.entity_type = 'SALES_INVOICE' AND sr.entity_id = h.id`;
}
function invoiceWrapped(t, innerWhere) {
  return `SELECT x.*, CASE WHEN x.raw_status IN ('POSTED','PARTIALLY_PAID','PAID') THEN COALESCE(x.sap_raw, 'PENDING') ELSE NULL END AS sap_status FROM (${invoiceBaseSql(t)} ${innerWhere}) x`;
}
const INVOICE_SORT = {
  invoice_number: "y.invoice_number", invoice_date: "y.invoice_date", distributor_name: "y.distributor_name", retailer_name: "y.retailer_name",
  product_count: "y.product_count", quantity: "y.quantity", invoice_value: "y.invoice_value", status: "y.raw_status",
};
function mapInvoiceRow(r) {
  return {
    id: Number(r.id),
    invoiceNumber: r.invoice_number,
    invoiceDate: dayOf(r.invoice_date),
    distributor: { id: Number(r.distributor_id), code: r.distributor_code, name: r.distributor_name },
    retailer: { id: r.retailer_id === null ? null : Number(r.retailer_id), name: r.retailer_name },
    territory: r.territory || null,
    orderNumber: r.order_number || null,
    productCount: num(r.product_count),
    quantity: num(r.quantity),
    invoiceValue: money(r.invoice_value),
    outstanding: money(r.outstanding),
    dueDate: dayOf(r.due_date),
    paymentTerms: r.payment_terms || null,
    status: String(r.raw_status).toLowerCase(),
    rawStatus: r.raw_status,
    sapStatus: r.sap_status || null,
    sapDocumentNo: r.sap_document_no || null,
    actions: status.allowedInvoiceActions({ status: r.raw_status }),
  };
}

async function listInvoices(db, query) {
  const t = tables(db);
  const run = runner(db);
  const pg = q.paging(query);
  const sort = q.sorting(query, INVOICE_SORT, { key: "invoice_date", dir: "desc" });
  const from = q.day(query.from, "from");
  const to = q.day(query.to, "to");
  if (from && to && from > to) throw new q.QueryError("from must be on or before to");
  const distributorId = q.intId(query.distributorId, "distributorId");
  const retailer = q.text(query.retailer, "retailer");
  const territory = q.text(query.territory, "territory");
  const search = q.text(query.q, "q");
  const st = q.oneOf(query.status, status.INVOICE_RAW, "status", (s) => s.toUpperCase());
  const sap = q.oneOf(query.sap, status.SAP_STATUSES, "sap", (s) => s.toUpperCase());

  const inner = where();
  if (from) inner.add("h.invoiceDate >= :from", { from: dayStart(from) });
  if (to) inner.add("h.invoiceDate < :toEnd", { toEnd: dayEndExclusive(to) });
  if (distributorId) inner.add("h.distributor_id = :distributorId", { distributorId });
  if (retailer) inner.add("LOWER(COALESCE(c.name, '')) LIKE :retailer ESCAPE '!'", { retailer: q.likeTerm(retailer) });
  if (territory) inner.add(`${TERRITORY} = :territory`, { territory });
  if (st) inner.add("h.status = :st", { st });
  if (search) {
    inner.add(
      `(LOWER(h.invoice_number) LIKE :s ESCAPE '!' OR LOWER(d.name) LIKE :s ESCAPE '!' OR LOWER(d.distributor_code) LIKE :s ESCAPE '!'
        OR LOWER(COALESCE(c.name, '')) LIKE :s ESCAPE '!' OR LOWER(COALESCE(so.order_number, '')) LIKE :s ESCAPE '!' OR LOWER(COALESCE(sr.sap_document_no, '')) LIKE :s ESCAPE '!')`,
      { s: q.likeTerm(search) }
    );
  }
  const outer = where();
  if (sap) outer.add("y.sap_status = :sap", { sap });

  const wrapped = `SELECT y.* FROM (${invoiceWrapped(t, inner.sql())}) y ${outer.sql()}`;
  const params = { ...inner.params, ...outer.params };
  const [rows, count] = await Promise.all([
    run(`${wrapped} ORDER BY ${sort.column} ${sort.dir}, y.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params),
    run(`SELECT COUNT(*) AS n FROM (${wrapped}) z`, params),
  ]);
  return { items: rows.map(mapInvoiceRow), page: pg.page, pageSize: pg.pageSize, total: num(count[0]?.n) };
}

async function getInvoice(db, idInput) {
  const id = q.intId(idInput, "id");
  if (!id) throw new q.QueryError("id is required");
  const t = tables(db);
  const run = runner(db);
  const head = await run(`SELECT y.* FROM (${invoiceWrapped(t, "WHERE h.id = :id")}) y`, { id });
  if (head.length === 0) return null;
  const r = head[0];

  const [extra, lines, sapRows] = await Promise.all([
    run(
      `SELECT h.netValue AS taxable, h.cgstAmount AS cgst, h.sgstAmount AS sgst, h.igstAmount AS igst, h.roundOff AS round_off, h.postedAt AS posted_at,
              d.tax_no AS d_gstin, d.pan AS d_pan, d.address AS d_address, d.street1 AS d_street1, d.street2 AS d_street2, d.city AS d_city, d.postal_code AS d_pincode, d.region AS d_region, d.phone_number AS d_phone,
              c.taxNumber AS c_gstin, c.street1 AS c_street1, c.street2 AS c_street2, c.city AS c_city, c.pincode AS c_pincode, c.region AS c_region
       FROM ${t.invoice} h JOIN ${t.distributor} d ON d.id = h.distributor_id LEFT JOIN ${t.customer} c ON c.id = h.customer_id WHERE h.id = :id`,
      { id }
    ),
    run(
      `SELECT il.id AS line_id, il.deliveryLineId AS delivery_line_id, il.quantity AS quantity, il.pricePerUnit AS price, il.discount AS discount_amount,
              il.taxableValue AS taxable, il.cgstAmount AS cgst, il.sgstAmount AS sgst, il.igstAmount AS igst, il.lineTotal AS line_total,
              p.name AS product_name, p.material_code AS sku, p.unit AS unit, h.hsn_code AS hsn, p.gst AS gst, p.cgst AS p_cgst, p.sgst AS p_sgst
       FROM ${t.invoiceLine} il JOIN ${t.product} p ON p.id = il.productId LEFT JOIN ${t.hsn} h ON h.id = p.hsn_id WHERE il.invoiceId = :id ORDER BY il.id`,
      { id }
    ),
    run(`SELECT status, sap_document_no, last_attempt_at, last_error FROM ${t.sap} WHERE entity_type = 'SALES_INVOICE' AND entity_id = :id`, { id }),
  ]);
  const e = extra[0] || {};

  // Batch(es) each invoice line was allocated from: the stock-ledger OUT movements posted by the delivery (existing structure).
  const dlIds = lines.map((l) => l.delivery_line_id).filter((v) => v !== null && v !== undefined);
  const alloc = dlIds.length
    ? await run(
        `SELECT s.reference_line_id AS delivery_line_id, s.batchId AS batch_id, SUM(s.quantity) AS qty, b.batch_no AS batch_no, b.mfg_date AS mfg_date, b.exp_date AS exp_date
         FROM ${t.ledger} s JOIN ${t.batch} b ON b.id = s.batchId
         WHERE s.reference_type = 'SALES' AND s.movement_type = 'OUT' AND s.reference_line_id IN (:dlIds)
         GROUP BY s.reference_line_id, s.batchId, b.batch_no, b.mfg_date, b.exp_date ORDER BY b.exp_date`,
        { dlIds }
      )
    : [];
  const byLine = new Map();
  for (const a of alloc) {
    const k = Number(a.delivery_line_id);
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push({ id: Number(a.batch_id), batchNo: a.batch_no, mfgDate: dayOf(a.mfg_date), expDate: dayOf(a.exp_date), quantity: num(a.qty) });
  }

  const outLines = lines.map((l) => {
    const qty = num(l.quantity);
    const gross = tax.round2(num(l.price) * qty);
    const taxRate = l.gst !== null && l.gst !== undefined ? num(l.gst) : num(l.p_cgst) + num(l.p_sgst);
    return {
      id: Number(l.line_id), product: l.product_name, sku: l.sku, hsn: l.hsn || null, unit: l.unit || null,
      batches: byLine.get(Number(l.delivery_line_id)) || [],
      quantity: qty, mrp: null, dealerPrice: money(l.price), gross,
      discountAmount: money(l.discount_amount), discountPercent: gross > 0 ? Math.round((num(l.discount_amount) / gross) * 10000) / 100 : 0,
      taxable: money(l.taxable), cgst: money(l.cgst), sgst: money(l.sgst), igst: money(l.igst),
      tax: money(num(l.cgst) + num(l.sgst) + num(l.igst)), gstRate: taxRate, net: money(l.line_total),
    };
  });
  const gross = tax.round2(outLines.reduce((a, l) => a + l.gross, 0));
  const discount = tax.round2(outLines.reduce((a, l) => a + l.discountAmount, 0));
  const inv = mapInvoiceRow(r);
  const address = (parts) => parts.filter(Boolean).join(", ") || null;
  const sapRow = sapRows[0] || null;
  return {
    invoice: {
      ...inv,
      postedAt: dash.toIso(e.posted_at),
      // "Company" = the issuing distributor (seller of this secondary sale)
      company: { name: r.distributor_name, code: r.distributor_code, gstin: e.d_gstin || null, pan: e.d_pan || null, phone: e.d_phone || null, address: e.d_address || address([e.d_street1, e.d_street2, e.d_city, e.d_pincode]) },
      retailerDetails: { name: r.retailer_name, gstin: e.c_gstin || null, address: address([e.c_street1, e.c_street2, e.c_city, e.c_pincode]) },
    },
    lines: outLines,
    totals: {
      grossAmount: gross, discount, taxable: money(e.taxable), cgst: money(e.cgst), sgst: money(e.sgst), igst: money(e.igst),
      roundOff: money(e.round_off), grandTotal: money(r.invoice_value),
    },
    sap: inv.sapStatus ? { status: inv.sapStatus, documentNo: inv.sapDocumentNo, lastAttemptAt: sapRow ? dash.toIso(sapRow.last_attempt_at) : null, lastError: sapRow ? sapRow.last_error || null : null } : null,
  };
}

// ══════════════════════════════════ Secondary Sales ══════════════════════════════════
// Grain: one row per (invoice line × batch allocation). Quantity/value of a line that was fulfilled from several batches are
// split pro-rata by allocated quantity. Only POSTED / PARTIALLY_PAID / PAID invoices count (drafts and cancelled are excluded).
function secondaryFrom(t) {
  return `FROM ${t.invoiceLine} il
    JOIN ${t.invoice} h ON h.id = il.invoiceId
    JOIN ${t.distributor} d ON d.id = h.distributor_id
    LEFT JOIN ${t.customer} c ON c.id = h.customer_id
    JOIN ${t.product} p ON p.id = il.productId
    LEFT JOIN ${t.hsn} hs ON hs.id = p.hsn_id
    LEFT JOIN ${t.ledger} s ON s.reference_type = 'SALES' AND s.movement_type = 'OUT' AND s.reference_line_id = il.deliveryLineId
    LEFT JOIN ${t.batch} b ON b.id = s.batchId
    LEFT JOIN ${t.delivery} dh ON dh.id = h.deliveryId
    LEFT JOIN ${t.order} so ON so.id = dh.orderId
    LEFT JOIN ${t.sap} sr ON sr.entity_type = 'SALES_INVOICE' AND sr.entity_id = h.id`;
}
const ROW_QTY = "COALESCE(s.quantity, il.quantity)";
const RATIO = `(${ROW_QTY} * 1.0 / NULLIF(il.quantity, 0))`;
const SAP_EFF = "COALESCE(sr.status, 'PENDING')";

const SECONDARY_SORT = {
  invoice_date: "y.invoice_date", invoice_number: "y.invoice_number", distributor_name: "y.distributor_name", retailer_name: "y.retailer_name",
  product: "y.product", quantity: "y.quantity", net_value: "y.net_value", gst: "y.gst",
};

function secondaryFilters(query, { withDate = true } = {}) {
  const w = where();
  w.add(`h.status IN ${SALES_INVOICE_STATUSES}`);
  if (withDate) {
    const from = q.day(query.from, "from");
    const to = q.day(query.to, "to");
    if (from && to && from > to) throw new q.QueryError("from must be on or before to");
    if (from) w.add("h.invoiceDate >= :from", { from: dayStart(from) });
    if (to) w.add("h.invoiceDate < :toEnd", { toEnd: dayEndExclusive(to) });
  }
  const distributorId = q.intId(query.distributorId, "distributorId");
  const retailer = q.text(query.retailer, "retailer");
  const product = q.text(query.product, "product");
  const category = q.text(query.category, "category");
  const territory = q.text(query.territory, "territory");
  const batch = q.text(query.batch, "batch");
  const sap = q.oneOf(query.sap, status.SAP_STATUSES, "sap", (s) => s.toUpperCase());
  const search = q.text(query.q, "q");
  if (distributorId) w.add("h.distributor_id = :distributorId", { distributorId });
  if (retailer) w.add("LOWER(COALESCE(c.name, '')) LIKE :retailer ESCAPE '!'", { retailer: q.likeTerm(retailer) });
  if (product) w.add("(LOWER(p.name) LIKE :product ESCAPE '!' OR LOWER(p.material_code) LIKE :product ESCAPE '!')", { product: q.likeTerm(product) });
  if (category) w.add(`${CATEGORY} = :category`, { category });
  if (territory) w.add(`${TERRITORY} = :territory`, { territory });
  if (batch) w.add("LOWER(COALESCE(b.batch_no, '')) LIKE :batch ESCAPE '!'", { batch: q.likeTerm(batch) });
  if (sap) w.add(`${SAP_EFF} = :sap`, { sap });
  if (search) {
    w.add(
      `(LOWER(h.invoice_number) LIKE :s ESCAPE '!' OR LOWER(d.name) LIKE :s ESCAPE '!' OR LOWER(d.distributor_code) LIKE :s ESCAPE '!'
        OR LOWER(COALESCE(c.name, '')) LIKE :s ESCAPE '!' OR LOWER(p.name) LIKE :s ESCAPE '!' OR LOWER(p.material_code) LIKE :s ESCAPE '!'
        OR LOWER(COALESCE(b.batch_no, '')) LIKE :s ESCAPE '!')`,
      { s: q.likeTerm(search) }
    );
  }
  return w;
}

const SECONDARY_SELECT = `il.id AS line_id, COALESCE(b.id, 0) AS batch_key, h.id AS invoice_id, h.invoice_number AS invoice_number, h.invoiceDate AS invoice_date,
    h.distributor_id AS distributor_id, d.name AS distributor_name, d.distributor_code AS distributor_code, ${TERRITORY} AS territory,
    h.customer_id AS retailer_id, c.name AS retailer_name, p.name AS product, p.material_code AS sku, ${CATEGORY} AS category, hs.hsn_code AS hsn,
    b.batch_no AS batch_no, b.mfg_date AS mfg_date, b.exp_date AS exp_date, ${ROW_QTY} AS quantity, il.pricePerUnit AS dealer_price,
    il.discount * ${RATIO} AS discount_amount, il.taxableValue * ${RATIO} AS net_value,
    (il.cgstAmount + il.sgstAmount + il.igstAmount) * ${RATIO} AS gst, il.cgstAmount * ${RATIO} AS cgst, il.sgstAmount * ${RATIO} AS sgst, il.igstAmount * ${RATIO} AS igst,
    (il.pricePerUnit * il.quantity) * ${RATIO} AS gross_value,
    h.paymentTerms AS payment_terms, h.status AS invoice_status, so.order_number AS order_number, ${SAP_EFF} AS sap_status, sr.sap_document_no AS sap_document_no`;

function mapSecondaryRow(r) {
  return {
    key: `${r.line_id}-${r.batch_key}`,
    lineId: Number(r.line_id),
    invoiceId: Number(r.invoice_id),
    invoiceNumber: r.invoice_number,
    invoiceDate: dayOf(r.invoice_date),
    distributor: { id: Number(r.distributor_id), code: r.distributor_code, name: r.distributor_name },
    retailer: { id: r.retailer_id === null ? null : Number(r.retailer_id), name: r.retailer_name },
    territory: r.territory || null,
    product: r.product,
    sku: r.sku,
    category: r.category,
    batchNo: r.batch_no || null,
    expiryDate: dayOf(r.exp_date),
    quantity: num(r.quantity),
    mrp: null, // not captured by the current data model
    dealerPrice: money(r.dealer_price),
    scheme: null, // Scheme Engine: later phase
    discountAmount: money(r.discount_amount),
    gst: money(r.gst),
    netValue: money(r.net_value),
    sapStatus: r.sap_status,
  };
}

async function listSecondary(db, query) {
  const t = tables(db);
  const run = runner(db);
  const pg = q.paging(query);
  const sort = q.sorting(query, SECONDARY_SORT, { key: "invoice_date", dir: "desc" });
  const w = secondaryFilters(query);
  const wrapped = `SELECT y.* FROM (SELECT ${SECONDARY_SELECT} ${secondaryFrom(t)} ${w.sql()}) y`;
  const [rows, count] = await Promise.all([
    run(`${wrapped} ORDER BY ${sort.column} ${sort.dir}, y.line_id DESC, y.batch_key DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, w.params),
    run(`SELECT COUNT(*) AS n FROM (${wrapped}) z`, w.params),
  ]);
  return { items: rows.map(mapSecondaryRow), page: pg.page, pageSize: pg.pageSize, total: num(count[0]?.n) };
}

async function getSecondary(db, key) {
  const m = /^(\d+)-(\d+)$/.exec(String(key));
  if (!m) throw new q.QueryError("Invalid secondary-sales record key");
  const t = tables(db);
  const w = secondaryFilters({}, { withDate: false });
  w.add("il.id = :lineId", { lineId: Number(m[1]) });
  w.add("COALESCE(b.id, 0) = :batchKey", { batchKey: Number(m[2]) });
  const rows = await runner(db)(`SELECT ${SECONDARY_SELECT} ${secondaryFrom(t)} ${w.sql()}`, w.params);
  if (rows.length === 0) return null;
  const r = rows[0];
  const sapRows = await runner(db)(`SELECT status, sap_document_no, last_attempt_at, last_error FROM ${t.sap} WHERE entity_type = 'SALES_INVOICE' AND entity_id = :id`, { id: Number(r.invoice_id) });
  const sapRow = sapRows[0] || null;
  const gross = money(r.gross_value);
  const qty = num(r.quantity);
  return {
    record: {
      ...mapSecondaryRow(r),
      hsn: r.hsn || null,
      mfgDate: dayOf(r.mfg_date),
      orderNumber: r.order_number || null,
      paymentTerms: r.payment_terms || null,
      invoiceStatus: String(r.invoice_status).toLowerCase(),
      grossValue: gross,
      discountPercent: gross > 0 ? Math.round((num(r.discount_amount) / gross) * 10000) / 100 : 0,
      cgst: money(r.cgst), sgst: money(r.sgst), igst: money(r.igst),
      unitNetValue: qty > 0 ? tax.round2(num(r.net_value) / qty) : 0,
    },
    sap: { status: r.sap_status, documentNo: sapRow ? sapRow.sap_document_no || null : null, lastAttemptAt: sapRow ? dash.toIso(sapRow.last_attempt_at) : null, lastError: sapRow ? sapRow.last_error || null : null },
  };
}

// KPI strip + charts for the current filter set. "Today" and "This month" always use the calendar (UTC) and ignore the date
// filter; everything else follows every filter including the date range.
async function getSecondarySummary(db, query, now = new Date()) {
  const t = tables(db);
  const run = runner(db);
  const today = dash.toDay(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = q.day(query.from, "from") || monthStart;
  const to = q.day(query.to, "to") || today;
  if (from > to) throw new q.QueryError("from must be on or before to");
  if (dash.daysBetweenInclusive(dash.parseDay(from), dash.parseDay(to)) > 400) throw new q.QueryError("The date range cannot exceed 400 days");

  const ranged = secondaryFilters({ ...query, from, to });
  const noDate = (extra) => {
    const w = secondaryFilters(query, { withDate: false });
    w.add("h.invoiceDate >= :rs AND h.invoiceDate < :re", extra);
    return w;
  };
  const wToday = noDate({ rs: dayStart(today), re: dayEndExclusive(today) });
  const wMonth = noDate({ rs: dayStart(monthStart), re: dayEndExclusive(today) });
  const from_ = secondaryFrom(t);

  const [totals, todayRow, monthRow, trendRows, byDistributor, byProduct] = await Promise.all([
    run(
      `SELECT COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS net_value, COALESCE(SUM(${ROW_QTY}), 0) AS quantity, COUNT(DISTINCT h.id) AS invoices,
              COUNT(DISTINCT h.distributor_id) AS distributors, COUNT(DISTINCT h.customer_id) AS retailers ${from_} ${ranged.sql()}`,
      ranged.params
    ),
    run(`SELECT COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS net_value ${from_} ${wToday.sql()}`, wToday.params),
    run(`SELECT COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS net_value ${from_} ${wMonth.sql()}`, wMonth.params),
    run(
      `SELECT CAST(DATE(h.invoiceDate) AS CHAR) AS bucket_day, COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS amount
       ${from_} ${ranged.sql()} GROUP BY CAST(DATE(h.invoiceDate) AS CHAR)`,
      ranged.params
    ),
    run(
      `SELECT d.id AS id, d.name AS name, d.distributor_code AS code, COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS net_value
       ${from_} ${ranged.sql()} GROUP BY d.id, d.name, d.distributor_code ORDER BY net_value DESC LIMIT 10`,
      ranged.params
    ),
    run(
      `SELECT LOWER(TRIM(p.name)) AS pkey, MIN(p.name) AS name, COALESCE(SUM(${ROW_QTY}), 0) AS quantity, COALESCE(SUM(il.taxableValue * ${RATIO}), 0) AS net_value
       ${from_} ${ranged.sql()} GROUP BY LOWER(TRIM(p.name)) ORDER BY net_value DESC LIMIT 10`,
      ranged.params
    ),
  ]);

  const tRow = totals[0] || {};
  const bucketed = dash.bucketise(trendRows, dash.parseDay(from), dash.parseDay(to), ["amount"]);
  return {
    meta: { range: { from, to }, asOf: today, timezone: "UTC" },
    kpis: {
      totalSecondarySales: money(tRow.net_value),
      todaysSecondarySales: money(todayRow[0]?.net_value),
      monthlySecondarySales: money(monthRow[0]?.net_value),
      activeDistributors: num(tRow.distributors),
      activeRetailers: num(tRow.retailers),
      totalInvoices: num(tRow.invoices),
      totalQuantity: num(tRow.quantity),
    },
    trend: { granularityDays: bucketed.granularityDays, points: bucketed.points.map((p) => ({ date: p.date, value: money(p.amount) })) },
    distributors: byDistributor.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, value: money(r.net_value) })),
    products: byProduct.map((r) => ({ name: r.name, quantity: num(r.quantity), value: money(r.net_value) })),
  };
}

module.exports = {
  getFilterLookups, getRetailerLookup, getProductLookup, getBatchLookup,
  listOrders, getOrder, listInvoices, getInvoice, listSecondary, getSecondary, getSecondarySummary,
  mapOrderRow, ORDER_SORT, INVOICE_SORT, SECONDARY_SORT,
};
