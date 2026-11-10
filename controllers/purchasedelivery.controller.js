const db = require("../models");
const inventory = require("../services/inventory.service");
const purchaseOrderCtrl = require("./purchaseorder.controller");
const {
  PurchaseDeliveryHeader,
  PurchaseDeliveryLine,
  PurchaseOrderHeader,
  PurchaseOrderLine,
  Product,
  Vendor,
  Address,
} = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const UPDATABLE_HEADER_FIELDS = ["deliveryDate", "remarks"];
function pickUpdatable(body) {
  const out = {};
  for (const key of UPDATABLE_HEADER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

/**
 * Recompute and persist the parent PO's status from its lines' received
 * quantities — mirrors recomputeOrderStatus in salesdelivery.controller.js.
 */
async function recomputeOrderStatus(order, transaction) {
  const lines = await PurchaseOrderLine.findAll({ where: { orderId: order.id }, transaction });
  let anyReceived = false;
  let allFullyReceived = true;

  for (const line of lines) {
    const received = await PurchaseDeliveryLine.sum("quantityReceived", {
      where: { orderLineId: line.id },
      include: [{ model: PurchaseDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
      transaction,
    });
    const qty = received || 0;
    if (qty > 0) anyReceived = true;
    if (qty < line.quantity) allFullyReceived = false;
  }

  let nextStatus = order.status;
  if (["CONFIRMED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"].includes(order.status)) {
    if (allFullyReceived && anyReceived) nextStatus = "FULLY_RECEIVED";
    else if (anyReceived) nextStatus = "PARTIALLY_RECEIVED";
    else nextStatus = "CONFIRMED";
  }

  if (nextStatus !== order.status) {
    await order.update({ status: nextStatus }, { transaction });
  }
  return nextStatus;
}

// ✅ CREATE Purchase Delivery — this is the ONLY place stock IN is posted
// for purchases, per the single-source-of-truth inventory architecture.
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const { order_number, deliveryDate, remarks, lines } = req.body;
    const distributorId = req.user.id;

    if (!order_number || !Array.isArray(lines) || lines.length === 0) {
      throw badRequest("order_number and at least one line are required");
    }

    // Tenant isolation + row lock: serializes concurrent delivery attempts
    // against the same PO so two simultaneous deliveries can't both read a
    // stale remaining-quantity and jointly over-receive.
    const order = await PurchaseOrderHeader.findOne({
      where: { order_number, distributor_id: distributorId },
      include: [
        {
          model: PurchaseOrderLine,
          as: "lines",
          include: [{ model: Product, as: "product" }],
        },
        {
          model: Vendor,
          as: "vendor",
          include: [{ model: Address, as: "addresses" }],
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!order) {
      throw Object.assign(new Error("Purchase Order not found"), { statusCode: 404 });
    }

    if (!purchaseOrderCtrl.DELIVERABLE_STATUSES.includes(order.status)) {
      throw badRequest(
        `Cannot create a delivery for a purchase order with status ${order.status}. ` +
        `Order must be CONFIRMED or PARTIALLY_RECEIVED.`
      );
    }

    const delivery = await PurchaseDeliveryHeader.create(
      {
        orderId: order.id,
        distributor_id: distributorId,
        deliveryDate,
        remarks,
        status: "Pending",
      },
      { transaction: t }
    );

    for (const line of lines) {
      const orderLine = order.lines.find((l) => l.id === line.orderLineId);
      if (!orderLine) throw badRequest(`Invalid order line ID: ${line.orderLineId}`);

      if (!line.quantityReceived || line.quantityReceived <= 0) {
        throw badRequest("quantityReceived must be a positive number");
      }

      // 🔒 Over-receive protection
      const alreadyReceived = await PurchaseDeliveryLine.sum("quantityReceived", {
        where: { orderLineId: orderLine.id },
        include: [{ model: PurchaseDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
        transaction: t,
      });

      const remaining = orderLine.quantity - (alreadyReceived || 0);
      if (line.quantityReceived > remaining) {
        throw badRequest(
          `Cannot receive more than ordered quantity for material ${orderLine.product.material_code}. ` +
          `Only ${remaining} unit(s) remain to be received.`
        );
      }
      if (!line.batchId) {
        throw badRequest("Batch is required for delivery");
      }

      // Tenant + product isolation on the batch
      const batch = await db.Batch.findOne({
        where: { id: line.batchId, productId: orderLine.productId, distributor_id: distributorId },
        transaction: t,
      });
      if (!batch) {
        throw badRequest("Invalid batch selected for this product/distributor");
      }

      const deliveryLine = await PurchaseDeliveryLine.create(
        {
          deliveryId: delivery.id,
          orderLineId: orderLine.id,
          productId: orderLine.productId,
          batchId: batch.id,
          material_code: orderLine.product.material_code,
          quantityReceived: line.quantityReceived,
          pricePerUnit: orderLine.pricePerUnit,
        },
        { transaction: t }
      );

      // 📦 Stock IN — single source of truth for physical inventory
      await inventory.postPurchaseIn({
        distributorId,
        productId: orderLine.productId,
        batchId: batch.id,
        quantity: line.quantityReceived,
        deliveryId: delivery.id,
        deliveryLineId: deliveryLine.id,
        userId: req.user.id,
        transaction: t,
      });
    }

    let fullyReceived = true;
    for (const ol of order.lines) {
      const received = await PurchaseDeliveryLine.sum("quantityReceived", {
        where: { orderLineId: ol.id },
        include: [{ model: PurchaseDeliveryHeader, as: "delivery", where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [] }],
        transaction: t,
      });
      if ((received || 0) < ol.quantity) {
        fullyReceived = false;
        break;
      }
    }

    await delivery.update({ status: fullyReceived ? "Received" : "Pending" }, { transaction: t });
    const newOrderStatus = await recomputeOrderStatus(order, t);

    await t.commit();

    res.status(201).json({
      message: "Purchase Delivery created successfully",
      delivery: {
        id: delivery.id,
        orderId: order.id,
        order_number: order.order_number,
        orderStatus: newOrderStatus,
        vendor: order.vendor?.name || "N/A",
        deliveryDate: new Date(delivery.deliveryDate).toLocaleDateString("en-GB"),
        remarks: delivery.remarks,
        status: delivery.status,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Error creating purchase delivery:", err.message);
    const status =
      err.statusCode ||
      (err instanceof inventory.InventoryValidationError || err instanceof inventory.InsufficientStockError ? 400 : 500);
    res.status(status).json({ error: status < 500 ? err.message : "Error creating purchase delivery" });
  }
};

// ✅ GET ALL
exports.getAll = async (req, res) => {
  try {
    const deliveries = await PurchaseDeliveryHeader.findAll({
      where: { distributor_id: req.user.id },
      include: [
        {
          model: PurchaseOrderHeader,
          as: "order",
          include: [{ model: Vendor, as: "vendor", include: [{ model: Address, as: "addresses" }] }],
        },
        { model: PurchaseDeliveryLine, as: "lines", include: ["product", "batch"] },
      ],
      order: [["createdAt", "DESC"]],
    });

    const formatted = deliveries.map((d) => ({
      id: d.id,
      orderId: d.orderId,
      deliveryDate: new Date(d.deliveryDate).toLocaleDateString("en-GB"),
      remarks: d.remarks,
      status: d.status,
      vendor: d.order?.vendor?.name || "N/A",
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching purchase deliveries:", err.message);
    res.status(500).json({ error: "Error fetching purchase deliveries" });
  }
};

// ✅ GET ONE
exports.getOne = async (req, res) => {
  try {
    const delivery = await PurchaseDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: PurchaseDeliveryLine, as: "lines", include: ["product", "batch"] },
        {
          model: PurchaseOrderHeader,
          as: "order",
          include: [{ model: Vendor, as: "vendor", include: [{ model: Address, as: "addresses" }] }],
        },
      ],
    });

    if (!delivery) return res.status(404).json({ message: "Not found" });
    res.json(delivery);
  } catch (error) {
    console.error("Error fetching purchase delivery:", error.message);
    res.status(500).json({ error: "Error fetching purchase delivery" });
  }
};

// ✅ UPDATE — header fields only. Status/lines/quantities cannot be
// mass-assigned since they must stay consistent with posted stock.
exports.update = async (req, res) => {
  try {
    const delivery = await PurchaseDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!delivery) return res.status(404).json({ message: "Not found" });

    await delivery.update(pickUpdatable(req.body));
    res.json({ message: "Updated successfully", delivery });
  } catch (error) {
    console.error("Error updating purchase delivery:", error.message);
    res.status(500).json({ error: "Error updating purchase delivery" });
  }
};

// ✅ DELETE — reverses the stock IN it posted (compensating OUT movements)
// so inventory never silently stays inflated after a delivery is removed,
// and recomputes the PO's status afterward. Blocked once a purchase
// invoice already exists against this delivery (an invoiced delivery must
// go through a proper credit/reversal workflow — Phase 5/13, not deleted).
exports.delete = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const delivery = await PurchaseDeliveryHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!delivery) throw badRequest2(404, "Not found");

    if (delivery.status === "Cancelled") {
      throw badRequest2(400, "Delivery is already cancelled");
    }

    const invoiced = await db.PurchaseInvoiceHeader.count({ where: { deliveryId: delivery.id }, transaction: t });
    if (invoiced > 0) {
      throw badRequest2(400, "Cannot cancel a delivery that already has an invoice. Cancel the invoice first.");
    }

    await inventory.reverseMovementsForReference({
      distributorId: req.user.id,
      referenceType: "PURCHASE",
      referenceId: delivery.id,
      reversalReferenceType: "CORRECTION",
      userId: req.user.id,
      reason: "Purchase delivery cancelled",
      transaction: t,
    });

    await delivery.update({ status: "Cancelled" }, { transaction: t });

    const order = await PurchaseOrderHeader.findOne({ where: { id: delivery.orderId }, transaction: t, lock: t.LOCK.UPDATE });
    const newOrderStatus = order ? await recomputeOrderStatus(order, t) : null;

    await t.commit();
    res.json({ message: "Delivery cancelled", delivery, orderStatus: newOrderStatus });
  } catch (error) {
    await t.rollback();
    console.error("Error cancelling purchase delivery:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error cancelling purchase delivery" });
  }
};

function badRequest2(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

exports.STATUSES = ["Pending", "Received", "Cancelled"];
// Alias for route/UX consistency with the sales side, where cancel is its
// own verb rather than reusing the DELETE HTTP method's name.
exports.cancel = exports.delete;
