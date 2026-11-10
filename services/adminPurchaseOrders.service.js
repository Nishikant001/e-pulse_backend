// services/adminPurchaseOrders.service.js — e-Pulse Phase 1: READ-ONLY view of distributors' purchase orders for the Admin (tenant admin) portal.
// A distributor creates a PO without choosing a vendor; the PO belongs to that distributor (distributor_id) and is shown here to the admin.
// There is deliberately no create / update / confirm / cancel in this service: the admin sees POs, the distributor owns them.
const { Op } = require("sequelize");
const q = require("./salesQuery");

const SORTS = {
  orderDate: "orderDate",
  order_number: "order_number",
  status: "status",
  totalAmount: "totalAmount",
  createdAt: "createdAt",
};
const STATUSES = ["DRAFT", "CONFIRMED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CANCELLED", "CLOSED"];
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function shapeDistributor(d) {
  return d ? { id: d.id, code: d.distributor_code, name: d.name } : null;
}

async function distributorMap(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.Distributor.findAll({ where: { id: unique }, attributes: ["id", "distributor_code", "name"] });
  return new Map(rows.map((d) => [d.id, d]));
}

async function listPurchaseOrders(db, query = {}) {
  const { page, pageSize, offset } = q.paging(query);
  const sort = q.sorting(query, SORTS, { key: "createdAt", dir: "desc" });
  const status = q.oneOf(query.status, STATUSES, "status", (x) => x.toUpperCase());
  const distributorId = q.intId(query.distributorId, "distributorId");
  const from = q.day(query.from, "from");
  const to = q.day(query.to, "to");
  const term = q.text(query.q, "q", 100);

  const where = {};
  if (status) where.status = status;
  if (distributorId) where.distributor_id = distributorId;
  if (from || to) {
    where.orderDate = {};
    if (from) where.orderDate[Op.gte] = new Date(`${from}T00:00:00.000Z`);
    if (to) where.orderDate[Op.lte] = new Date(`${to}T23:59:59.999Z`);
  }
  if (term) {
    const like = q.likeTerm(term);
    // search by PO number, or by the owning distributor's name / code
    const matching = await db.Distributor.findAll({
      where: { [Op.or]: [db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col("name")), { [Op.like]: like }), db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col("distributor_code")), { [Op.like]: like })] },
      attributes: ["id"],
    });
    where[Op.or] = [
      db.sequelize.where(db.sequelize.fn("lower", db.sequelize.col("order_number")), { [Op.like]: like }),
      ...(matching.length ? [{ distributor_id: matching.map((d) => d.id) }] : []),
    ];
  }

  const { rows, count } = await db.PurchaseOrderHeader.findAndCountAll({
    where,
    order: [[sort.column, sort.dir], ["id", "DESC"]],
    limit: pageSize,
    offset,
    include: [{ model: db.PurchaseOrderLine, as: "lines", attributes: ["id"] }],
    distinct: true,
  });
  const dists = await distributorMap(db, rows.map((r) => r.distributor_id));

  return {
    page, pageSize, total: count,
    items: rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      orderDate: r.orderDate,
      status: r.status,
      distributor: shapeDistributor(dists.get(r.distributor_id)) || { id: r.distributor_id, code: r.distributor_code, name: null },
      vendorName: r.vendorName || null, // legacy POs only; new POs have none
      lineCount: (r.lines || []).length,
      netValue: num(r.netValue),
      taxAmount: num(r.cgstAmount) + num(r.sgstAmount) + num(r.igstAmount),
      totalAmount: num(r.totalAmount),
      createdAt: r.createdAt,
    })),
  };
}

async function getPurchaseOrderDetail(db, id) {
  const pk = q.intId(id, "id");
  if (!pk) return null;
  const order = await db.PurchaseOrderHeader.findOne({
    where: { id: pk },
    include: [
      { model: db.PurchaseOrderLine, as: "lines", include: [{ model: db.Product, as: "product", attributes: ["id", "name", "material_code", "unit"] }] },
      { model: db.Vendor, as: "vendor", attributes: ["id", "name", "vendor_code", "city", "region"], required: false },
    ],
  });
  if (!order) return null;

  const [dist, deliveries] = await Promise.all([
    db.Distributor.findOne({ where: { id: order.distributor_id }, attributes: ["id", "distributor_code", "name", "email", "phone_number", "city", "region", "status"] }),
    db.PurchaseDeliveryHeader.findAll({ where: { orderId: order.id }, order: [["deliveryDate", "DESC"], ["id", "DESC"]], attributes: ["id", "deliveryDate", "status", "remarks"] }),
  ]);

  const invoices = deliveries.length
    ? await db.PurchaseInvoiceHeader.findAll({ where: { deliveryId: deliveries.map((d) => d.id) }, attributes: ["id", "invoice_number", "status", "totalAmount", "deliveryId"] })
    : [];
  const invoiceByDelivery = new Map(invoices.map((i) => [i.deliveryId, i]));

  const lines = [];
  for (const l of order.lines || []) {
    const received = num(await db.PurchaseDeliveryLine.sum("quantityReceived", {
      where: { orderLineId: l.id },
      include: [{ model: db.PurchaseDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
    }));
    lines.push({
      id: l.id,
      productId: l.productId,
      materialCode: l.material_code,
      productName: l.product ? l.product.name : null,
      unit: l.product ? l.product.unit : null,
      quantity: l.quantity,
      pricePerUnit: num(l.pricePerUnit),
      discount: num(l.discount),
      lineNetValue: num(l.lineNetValue),
      receivedQuantity: received,
      remainingQuantity: l.quantity - received,
    });
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    orderDate: order.orderDate,
    status: order.status,
    paymentMethod: order.paymentMethod || null,
    description: order.description || null,
    distributor: dist
      ? { id: dist.id, code: dist.distributor_code, name: dist.name, email: dist.email, phone: dist.phone_number, city: dist.city, state: dist.region, status: dist.status }
      : { id: order.distributor_id, code: order.distributor_code, name: null },
    vendor: order.vendor ? { id: order.vendor.id, code: order.vendor.vendor_code, name: order.vendor.name, city: order.vendor.city, state: order.vendor.region } : null,
    totals: { netValue: num(order.netValue), cgst: num(order.cgstAmount), sgst: num(order.sgstAmount), igst: num(order.igstAmount), total: num(order.totalAmount) },
    lines,
    canReceive: ["CONFIRMED", "PARTIALLY_RECEIVED"].includes(order.status),
    deliveries: deliveries.map((d) => {
      const inv = invoiceByDelivery.get(d.id);
      return {
        id: d.id, deliveryDate: d.deliveryDate, status: d.status, remarks: d.remarks || null,
        invoice: inv ? { id: inv.id, number: inv.invoice_number, status: inv.status, total: num(inv.totalAmount) } : null,
      };
    }),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

async function getLookups(db) {
  const rows = await db.Distributor.findAll({ attributes: ["id", "distributor_code", "name"], order: [["name", "ASC"]] });
  return { statuses: STATUSES, distributors: rows.map(shapeDistributor) };
}

module.exports = { listPurchaseOrders, getPurchaseOrderDetail, getLookups, STATUSES };
