const db = require("../models");
const inventory = require("../services/inventory.service");
const salesOrderCtrl = require("./salesOrder.controller");
const {
  SalesDeliveryHeader,
  SalesDeliveryLine,
  SalesOrderHeader,
  SalesOrderLine,
  Product,
  Customer,
  Address,
} = db;

const UPDATABLE_HEADER_FIELDS = ["deliveryDate", "remarks"];
function pickUpdatable(body) {
  const out = {};
  for (const key of UPDATABLE_HEADER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Recompute and persist the parent Sales Order's status from its lines'
 * delivered quantities. Called after every delivery create/cancel so the
 * order status is always derived from real data, never set by hand.
 */
async function recomputeOrderStatus(order, transaction) {
  const lines = await SalesOrderLine.findAll({ where: { orderId: order.id }, transaction });
  let anyDelivered = false;
  let allFullyDelivered = true;

  for (const line of lines) {
    const delivered = await SalesDeliveryLine.sum("quantityDelivered", {
      where: { orderLineId: line.id },
      include: [{ model: SalesDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
      transaction,
    });
    const qty = delivered || 0;
    if (qty > 0) anyDelivered = true;
    if (qty < line.quantity) allFullyDelivered = false;
  }

  let nextStatus = order.status;
  if (order.status === "CONFIRMED" || order.status === "PARTIALLY_DELIVERED" || order.status === "FULLY_DELIVERED") {
    if (allFullyDelivered && anyDelivered) nextStatus = "FULLY_DELIVERED";
    else if (anyDelivered) nextStatus = "PARTIALLY_DELIVERED";
    else nextStatus = "CONFIRMED";
  }

  if (nextStatus !== order.status) {
    await order.update({ status: nextStatus }, { transaction });
  }
  return nextStatus;
}

// ✅ Create Delivery — the ONLY place stock OUT is posted for sales.
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const { order_number, deliveryDate, remarks, lines } = req.body;
    const distributorId = req.user.id;

    if (!order_number || !Array.isArray(lines) || lines.length === 0) {
      throw badRequest("order_number and at least one line are required");
    }

    // Row-locked fetch: serializes concurrent delivery attempts against the
    // same order so two simultaneous deliveries can't both read a "stale"
    // remaining-quantity and jointly oversell.
    const order = await SalesOrderHeader.findOne({
      where: { order_number, distributor_id: distributorId },
      include: [
        { model: SalesOrderLine, as: "lines", include: [{ model: Product, as: "product" }] },
        {
          model: Customer,
          as: "customer",
          include: [
            { model: Address, as: "addresses" },
            { model: Address, as: "shipToParty" },
            { model: Address, as: "soldToParty" },
            { model: Address, as: "billToParty" },
            { model: Address, as: "payer" },
          ],
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!order) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

    if (!salesOrderCtrl.DELIVERABLE_STATUSES.includes(order.status)) {
      throw badRequest(
        `Cannot create a delivery for an order with status ${order.status}. ` +
        `Order must be CONFIRMED or PARTIALLY_DELIVERED.`
      );
    }

    const delivery = await SalesDeliveryHeader.create(
      { orderId: order.id, distributor_id: distributorId, deliveryDate, remarks, status: "Pending" },
      { transaction: t }
    );

    for (const line of lines) {
      const orderLine = order.lines.find((l) => l.id === line.orderLineId);
      if (!orderLine) throw badRequest(`Invalid order line ID: ${line.orderLineId}`);

      if (!line.quantityDelivered || line.quantityDelivered <= 0) {
        throw badRequest("quantityDelivered must be a positive number");
      }

      const alreadyDelivered = await SalesDeliveryLine.sum("quantityDelivered", {
        where: { orderLineId: orderLine.id },
        include: [{ model: SalesDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
        transaction: t,
      });
      const remaining = orderLine.quantity - (alreadyDelivered || 0);
      if (line.quantityDelivered > remaining) {
        throw badRequest(
          `Delivery quantity exceeds remaining order quantity for ${orderLine.material_code}. ` +
          `Only ${remaining} unit(s) remain to be delivered.`
        );
      }

      const deliveryLine = await SalesDeliveryLine.create(
        {
          deliveryId: delivery.id,
          orderLineId: orderLine.id,
          productId: orderLine.productId,
          material_code: orderLine.product.material_code,
          quantityDelivered: line.quantityDelivered,
        },
        { transaction: t }
      );

      // 📦 Stock OUT — manual batch if specified, otherwise FEFO. Throws
      // InsufficientStockError / InventoryValidationError on failure,
      // which rolls back this entire transaction (no partial delivery).
      const chosenBatchId = line.batchId || orderLine.batchId || null;
      await inventory.postSalesOut({
        distributorId,
        productId: orderLine.productId,
        quantity: line.quantityDelivered,
        batchId: chosenBatchId,
        deliveryId: delivery.id,
        deliveryLineId: deliveryLine.id,
        userId: req.user.id,
        transaction: t,
      });
    }

    // A delivery record itself is marked Delivered once every line on THIS
    // delivery has been posted (which is always true at this point) —
    // order-level completeness is tracked separately via order.status.
    await delivery.update({ status: "Delivered" }, { transaction: t });

    const newOrderStatus = await recomputeOrderStatus(order, t);

    await t.commit();

    res.status(201).json({
      message: "Sales Delivery created successfully",
      delivery: {
        id: delivery.id,
        orderId: order.id,
        order_number: order.order_number,
        deliveryDate,
        remarks,
        status: delivery.status,
        orderStatus: newOrderStatus,
        customer: order.customer?.name || "N/A",
        shipToAddress:
          order.customer?.shipToParty ||
          order.customer?.addresses?.find((a) => a.type === "ship_to_party") ||
          null,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Delivery Create Error:", err.message);
    const status =
      err.statusCode ||
      (err instanceof inventory.InsufficientStockError || err instanceof inventory.InventoryValidationError ? 400 : 500);
    res.status(status).json({ error: err.message, details: err.details });
  }
};

// ✅ Cancel Delivery — reverses its stock OUT and recomputes order status.
// Only a delivery that hasn't been invoiced can be cancelled.
exports.cancel = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const delivery = await SalesDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!delivery) throw Object.assign(new Error("Delivery not found"), { statusCode: 404 });

    if (delivery.status === "Cancelled") {
      throw badRequest("Delivery is already cancelled");
    }

    const invoiced = await db.SalesInvoiceHeader.count({ where: { deliveryId: delivery.id }, transaction: t });
    if (invoiced > 0) {
      throw badRequest("Cannot cancel a delivery that already has an invoice. Cancel the invoice first.");
    }

    await inventory.reverseMovementsForReference({
      distributorId: req.user.id,
      referenceType: "SALES",
      referenceId: delivery.id,
      reversalReferenceType: "CORRECTION",
      userId: req.user.id,
      reason: "Sales delivery cancelled",
      transaction: t,
    });

    await delivery.update({ status: "Cancelled" }, { transaction: t });

    const order = await SalesOrderHeader.findOne({ where: { id: delivery.orderId }, transaction: t, lock: t.LOCK.UPDATE });
    const newOrderStatus = order ? await recomputeOrderStatus(order, t) : null;

    await t.commit();
    res.json({ message: "Delivery cancelled", delivery, orderStatus: newOrderStatus });
  } catch (err) {
    await t.rollback();
    console.error("Error cancelling delivery:", err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// ✅ Get All Deliveries
exports.getAll = async (req, res) => {
  try {
    const deliveries = await SalesDeliveryHeader.findAll({
      where: { distributor_id: req.user.id },
      include: [
        {
          model: SalesOrderHeader,
          as: "order",
          include: [
            {
              model: Customer,
              as: "customer",
              include: [
                { model: Address, as: "addresses" },
                { model: Address, as: "shipToParty" },
                { model: Address, as: "soldToParty" },
                { model: Address, as: "billToParty" },
                { model: Address, as: "payer" },
              ],
            },
          ],
        },
        { model: SalesDeliveryLine, as: "lines", include: ["product"] },
      ],
      order: [["createdAt", "DESC"]],
    });

    const formatted = deliveries.map((d) => ({
      id: d.id,
      orderId: d.orderId,
      order_number: d.order?.order_number || null,
      // ISO string — the UI formats it, and it can be sent back on edit safely
      deliveryDate: d.deliveryDate ? new Date(d.deliveryDate).toISOString() : null,
      remarks: d.remarks,
      status: d.status,
      customer: d.order?.customer?.name || "N/A",
      order: d.order ? { id: d.order.id, order_number: d.order.order_number, customer: { name: d.order.customer?.name || "N/A" } } : null,
      lines: d.lines || [],
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      shipToAddress:
        d.order?.customer?.shipToParty ||
        d.order?.customer?.addresses?.find((a) => a.type === "ship_to_party") ||
        null,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Get Deliveries Error:", err.message);
    res.status(500).json({ error: "Error fetching deliveries" });
  }
};

// ✅ Get One Delivery
exports.getOne = async (req, res) => {
  try {
    const delivery = await SalesDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: SalesDeliveryLine, as: "lines", include: ["product"] },
        {
          model: SalesOrderHeader,
          as: "order",
          include: [
            {
              model: Customer,
              as: "customer",
              include: [
                { model: Address, as: "addresses" },
                { model: Address, as: "shipToParty" },
                { model: Address, as: "soldToParty" },
                { model: Address, as: "billToParty" },
                { model: Address, as: "payer" },
              ],
            },
          ],
        },
      ],
    });

    if (!delivery) return res.status(404).json({ message: "Delivery not found" });

    res.json({
      id: delivery.id,
      orderId: delivery.orderId,
      order_number: delivery.order?.order_number || null,
      deliveryDate: delivery.deliveryDate ? new Date(delivery.deliveryDate).toISOString() : null,
      remarks: delivery.remarks,
      status: delivery.status,
      customer: delivery.order?.customer?.name || "N/A",
      order: delivery.order ? { id: delivery.order.id, order_number: delivery.order.order_number, customer: { name: delivery.order.customer?.name || "N/A" } } : null,
      shipToAddress:
        delivery.order?.customer?.shipToParty ||
        delivery.order?.customer?.addresses?.find((a) => a.type === "ship_to_party") ||
        null,
      lines: delivery.lines,
    });
  } catch (error) {
    console.error("Get One Delivery Error:", error.message);
    res.status(500).json({ error: "Error fetching delivery" });
  }
};

// ✅ Update Delivery — header fields only. A delivery that has posted
// stock movements cannot be edited; use cancel() + a new delivery instead.
exports.update = async (req, res) => {
  try {
    const delivery = await SalesDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!delivery) return res.status(404).json({ message: "Not found" });

    const changes = pickUpdatable(req.body);
    if (Object.prototype.hasOwnProperty.call(changes, "deliveryDate")) {
      const parsed = new Date(changes.deliveryDate);
      if (!changes.deliveryDate || Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "Invalid delivery date (use YYYY-MM-DD)" });
      }
      changes.deliveryDate = parsed;
    }
    await delivery.update(changes);
    res.json({ message: "Updated successfully", delivery });
  } catch (error) {
    console.error("Error updating sales delivery:", error.message);
    res.status(500).json({ error: "Error updating sales delivery" });
  }
};

// ✅ Delete Delivery — kept for backward compatibility, now just delegates
// to cancel() so stock is always reversed rather than silently orphaned.
exports.delete = async (req, res) => {
  return exports.cancel(req, res);
};

// ======================== DELIVERY COUNT ======================== //
exports.getDeliveryCount = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const count = await SalesDeliveryHeader.count({ where: { distributor_id: distributorId } });
    res.json({ count });
  } catch (error) {
    console.error("Delivery Count Error:", error.message);
    res.status(500).json({ error: "Error getting delivery count" });
  }
};
