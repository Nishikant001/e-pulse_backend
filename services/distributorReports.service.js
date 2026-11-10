// services/distributorReports.service.js — e-Pulse Phase 1: READ-ONLY reports for the Distributor portal.
// Every function takes the distributor id from the authenticated token (never from the query) and only ever SELECTs.
// Stock and Expiry reuse the existing, already distributor-scoped inventory read service so the numbers match the Inventory screens.
const { Op } = require("sequelize");
const q = require("./salesQuery");
const inventoryReads = require("./inventoryQuery.service");

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const col = (key, label, type = "text") => ({ key, label, type }); // type: text | number | money | date | status

const SECTIONS = [
  { id: "sales", label: "Sales" },
  { id: "stock", label: "Stock" },
  { id: "expiry", label: "Expiry" },
  { id: "distributor", label: "Distributor" },
  { id: "customers", label: "Customers" },
  { id: "scheme", label: "Scheme" },
  { id: "returns", label: "Returns" },
  { id: "outstanding", label: "Outstanding" },
  { id: "sap-sync", label: "SAP Sync" },
];

function dateRange(query, column) {
  const from = q.day(query.from, "from");
  const to = q.day(query.to, "to");
  if (from && to && from > to) throw new q.QueryError("from must not be after to");
  if (!from && !to) return undefined;
  const r = {};
  if (from) r[Op.gte] = new Date(`${from}T00:00:00.000Z`);
  if (to) r[Op.lte] = new Date(`${to}T23:59:59.999Z`);
  return { [column]: r };
}

const result = (title, description, columns, items, { total, page, pageSize, totals } = {}) => ({
  title, description, readOnly: true, columns, items,
  total: total ?? items.length, page: page ?? 1, pageSize: pageSize ?? items.length, totals: totals || null,
});

// ───────────────────────────── sections ─────────────────────────────
async function sales(db, id, query) {
  const { page, pageSize, offset } = q.paging(query);
  const where = { distributor_id: id, ...(dateRange(query, "invoiceDate") || {}) };
  const status = q.oneOf(query.status, ["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"], "status", (x) => x.toUpperCase());
  if (status) where.status = status;
  const { rows, count } = await db.SalesInvoiceHeader.findAndCountAll({
    where, order: [["invoiceDate", "DESC"], ["id", "DESC"]], limit: pageSize, offset,
    include: [{ model: db.Customer, as: "customer", attributes: ["name", "customer_code"], required: false }],
  });
  const sumWhere = { ...where, status: status || { [Op.ne]: "CANCELLED" } };
  const totalAmount = num(await db.SalesInvoiceHeader.sum("totalAmount", { where: sumWhere }));
  const items = rows.map((r) => ({
    id: r.id, invoiceNumber: r.invoice_number, invoiceDate: day(r.invoiceDate), customer: r.customer ? r.customer.name : null, customerCode: r.customer ? r.customer.customer_code : null,
    status: r.status, netValue: num(r.netValue), tax: num(r.cgstAmount) + num(r.sgstAmount) + num(r.igstAmount), totalAmount: num(r.totalAmount),
  }));
  return result("Sales report", "Sales invoices for your distributorship. View only.",
    [col("invoiceNumber", "Invoice"), col("invoiceDate", "Date", "date"), col("customer", "Customer"), col("status", "Status", "status"), col("netValue", "Net value", "money"), col("tax", "Tax", "money"), col("totalAmount", "Total", "money")],
    items, { total: count, page, pageSize, totals: { totalAmount } });
}

async function stock(db, id, query) {
  const out = await inventoryReads.listCurrentStock(db, query, { distributorId: id });
  return result("Stock report", "Current stock by product. View only.",
    [col("sku", "Code"), col("product", "Product"), col("category", "Category"), col("availableQty", "Available", "number"), col("reservedQty", "Reserved", "number"), col("saleableQty", "Saleable", "number"), col("nonSaleableQty", "Non-saleable", "number"), col("stockValue", "Stock value", "money"), col("status", "Status", "status")],
    out.items, { total: out.total, page: out.page, pageSize: out.pageSize });
}

async function expiry(db, id, query) {
  // Default window: already expired + expiring within 90 days. The caller may narrow with expFrom / expTo / bucket.
  const q2 = { ...query };
  if (!q2.expTo && !q2.bucket) q2.expTo = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const out = await inventoryReads.listBatchStock(db, q2, { distributorId: id });
  return result("Expiry report", "Batches that have expired or expire within 90 days. View only.",
    [col("sku", "Code"), col("product", "Product"), col("batchNo", "Batch"), col("expDate", "Expiry", "date"), col("daysToExpiry", "Days left", "number"), col("availableQty", "On hand", "number"), col("stockValue", "Stock value", "money"), col("status", "Status", "status")],
    out.items, { total: out.total, page: out.page, pageSize: out.pageSize });
}

async function distributor(db, id) {
  const d = await db.Distributor.findOne({ where: { id }, attributes: ["id", "distributor_code", "name", "city", "region", "territory", "status", "credit_limit", "payment_terms"] });
  const [customers, products, openOrders, outstanding] = await Promise.all([
    db.Customer.count({ where: { distributor_id: id } }),
    db.Product.count({ where: { distributor_id: id } }),
    db.SalesOrderHeader.count({ where: { distributor_id: id, status: { [Op.in]: ["DRAFT", "CONFIRMED"] } } }),
    db.SalesInvoiceHeader.sum("outstandingAmount", { where: { distributor_id: id, status: { [Op.in]: ["POSTED", "PARTIALLY_PAID"] } } }),
  ]);
  const rows = [
    ["Distributor", d ? `${d.name} (${d.distributor_code})` : "—"],
    ["Status", d ? d.status : "—"],
    ["Location", d ? [d.city, d.region].filter(Boolean).join(", ") || "—" : "—"],
    ["Territory", (d && d.territory) || "—"],
    ["Payment terms", (d && d.payment_terms) || "—"],
    ["Credit limit", d && d.credit_limit != null ? num(d.credit_limit) : "—"],
    ["Customers", customers],
    ["Products", products],
    ["Open sales orders (draft + confirmed)", openOrders],
    ["Outstanding receivable", num(outstanding)],
  ].map(([metric, value]) => ({ metric, value }));
  return result("Distributor report", "A summary of your distributorship. View only.", [col("metric", "Metric"), col("value", "Value")], rows);
}

async function customers(db, id, query) {
  const { page, pageSize, offset } = q.paging(query);
  const where = { distributor_id: id };
  const status = q.oneOf(query.status, ["active", "inactive", "pending"], "status");
  if (status) where.status = status;
  const term = q.text(query.q, "q", 100);
  if (term) {
    const like = q.likeTerm(term);
    where[Op.or] = ["name", "customer_code", "city", "contact_person"].map((c) => db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col(c)), { [Op.like]: like }));
  }
  const { rows, count } = await db.Customer.findAndCountAll({ where, order: [["name", "ASC"], ["id", "ASC"]], limit: pageSize, offset });
  const items = rows.map((r) => ({ id: r.id, code: r.customer_code, name: r.name, contact: r.contact_person || null, city: r.city || null, state: r.region || null, territory: r.territory || null, status: r.status, creditLimit: r.credit_limit != null ? num(r.credit_limit) : null }));
  return result("Customer report", "Your customers. View only — add or edit customers under Customers.",
    [col("code", "Code"), col("name", "Customer"), col("contact", "Contact"), col("city", "City"), col("state", "State"), col("territory", "Territory"), col("status", "Status", "status"), col("creditLimit", "Credit limit", "money")],
    items, { total: count, page, pageSize });
}

async function scheme(db, id, query) {
  const { page, pageSize, offset } = q.paging(query);
  const linked = (await db.SchemeDistributor.findAll({ where: { distributor_id: id }, attributes: ["scheme_id"] })).map((r) => r.scheme_id);
  const where = { [Op.or]: [{ distributor_scope: "ALL" }, ...(linked.length ? [{ id: linked }] : [])] };
  const status = q.oneOf(query.status, ["active", "inactive"], "status");
  if (status) where.status = status;
  const { rows, count } = await db.Scheme.findAndCountAll({ where, order: [["valid_from", "DESC"], ["id", "DESC"]], limit: pageSize, offset });
  const items = rows.map((r) => ({ id: r.id, code: r.scheme_code, name: r.name, type: r.scheme_type, validFrom: day(r.valid_from), validTo: day(r.valid_to), status: r.status }));
  return result("Scheme report", "Schemes that apply to your distributorship. View only — schemes are managed by the administrator.",
    [col("code", "Code"), col("name", "Scheme"), col("type", "Type"), col("validFrom", "Valid from", "date"), col("validTo", "Valid to", "date"), col("status", "Status", "status")],
    items, { total: count, page, pageSize });
}

async function returns(db, id, query) {
  const { page, pageSize } = q.paging(query);
  const rangeS = dateRange(query, "returnDate") || {};
  const take = page * pageSize; // enough of each list to build the requested merged page
  const [s, p, sc, pc] = await Promise.all([
    db.SalesReturn.findAll({ where: { distributor_id: id, ...rangeS }, order: [["returnDate", "DESC"], ["id", "DESC"]], limit: take }),
    db.PurchaseReturn.findAll({ where: { distributor_id: id, ...rangeS }, order: [["returnDate", "DESC"], ["id", "DESC"]], limit: take }),
    db.SalesReturn.count({ where: { distributor_id: id, ...rangeS } }),
    db.PurchaseReturn.count({ where: { distributor_id: id, ...rangeS } }),
  ]);
  const merged = [
    ...s.map((r) => ({ key: `S-${r.id}`, type: "Sales", number: r.return_number, date: day(r.returnDate), status: r.status, reason: r.reason || null })),
    ...p.map((r) => ({ key: `P-${r.id}`, type: "Purchase", number: r.return_number, date: day(r.returnDate), status: r.status, reason: r.reason || null })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const items = merged.slice((page - 1) * pageSize, page * pageSize);
  return result("Returns report", "Sales and purchase returns. View only.",
    [col("type", "Type"), col("number", "Return no."), col("date", "Date", "date"), col("status", "Status", "status"), col("reason", "Reason")],
    items, { total: sc + pc, page, pageSize });
}

async function outstanding(db, id, query) {
  const { page, pageSize, offset } = q.paging(query);
  const where = { distributor_id: id, status: { [Op.in]: ["POSTED", "PARTIALLY_PAID"] }, outstandingAmount: { [Op.gt]: 0 } };
  const { rows, count } = await db.SalesInvoiceHeader.findAndCountAll({
    where, order: [["dueDate", "ASC"], ["id", "ASC"]], limit: pageSize, offset,
    include: [{ model: db.Customer, as: "customer", attributes: ["name", "customer_code"], required: false }],
  });
  const total = num(await db.SalesInvoiceHeader.sum("outstandingAmount", { where }));
  const today = day(new Date());
  const items = rows.map((r) => ({
    id: r.id, invoiceNumber: r.invoice_number, customer: r.customer ? r.customer.name : null, invoiceDate: day(r.invoiceDate), dueDate: day(r.dueDate),
    daysOverdue: r.dueDate && day(r.dueDate) < today ? Math.floor((Date.parse(today) - Date.parse(day(r.dueDate))) / 86400000) : 0,
    totalAmount: num(r.totalAmount), outstandingAmount: num(r.outstandingAmount),
  }));
  return result("Outstanding report", "Unpaid sales invoices. View only — record payments under Accounts.",
    [col("invoiceNumber", "Invoice"), col("customer", "Customer"), col("invoiceDate", "Invoice date", "date"), col("dueDate", "Due date", "date"), col("daysOverdue", "Days overdue", "number"), col("totalAmount", "Invoice total", "money"), col("outstandingAmount", "Outstanding", "money")],
    items, { total: count, page, pageSize, totals: { outstandingAmount: total } });
}

async function sapSync(db, id, query) {
  const { page, pageSize, offset } = q.paging(query);
  const where = { distributor_id: id };
  const status = q.oneOf(query.status, ["PENDING", "SYNCED", "FAILED"], "status", (x) => x.toUpperCase());
  if (status) where.status = status;
  const { rows, count } = await db.SapSyncRecord.findAndCountAll({ where, order: [["last_attempt_at", "DESC"], ["id", "DESC"]], limit: pageSize, offset });
  // The stored error text is deliberately not returned — only that an error exists.
  const items = rows.map((r) => ({ id: r.id, entity: r.entity_type, entityId: r.entity_id, status: r.status, sapDocument: r.sap_document_no || null, lastAttempt: r.last_attempt_at ? new Date(r.last_attempt_at).toISOString() : null, hasError: Boolean(r.last_error) }));
  return result("SAP sync report", "Sync status of your sales orders and invoices. View only.",
    [col("entity", "Document"), col("entityId", "Document id", "number"), col("status", "Status", "status"), col("sapDocument", "SAP document"), col("lastAttempt", "Last attempt", "date"), col("hasError", "Error")],
    items, { total: count, page, pageSize });
}

const HANDLERS = { sales, stock, expiry, distributor, customers, scheme, returns, outstanding, "sap-sync": sapSync };

async function runReport(db, distributorId, section, query = {}) {
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, section)) return null;
  return HANDLERS[section](db, Number(distributorId), query || {});
}

module.exports = { SECTIONS, runReport };
