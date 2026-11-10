// controllers/delivery.controller.js
const db = require("../models");
const Delivery = db.Delivery;
const SalesOrderHeader = db.SalesOrderHeader;
const SalesOrderLine = db.SalesOrderLine;
const Customer = db.Customer;

// Fields a client is allowed to set/update on a Delivery. Anything else
// (e.g. salesOrderId after creation) is ignored to prevent mass assignment.
const UPDATABLE_FIELDS = ["deliveryDate", "status", "salesOrderLineId"];

function pickUpdatable(body) {
  const out = {};
  for (const key of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      out[key] = body[key];
    }
  }
  return out;
}

exports.createDelivery = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { salesOrderId, salesOrderLineId, deliveryDate, status } = req.body;

    if (!salesOrderId) {
      return res.status(400).json({ message: "salesOrderId is required" });
    }

    // Tenant isolation: the sales order must belong to the authenticated distributor
    const salesOrder = await SalesOrderHeader.findOne({
      where: { id: salesOrderId, distributor_id: distributorId },
      include: [{ model: Customer, as: "customer" }],
    });

    if (!salesOrder) {
      return res.status(404).json({ message: "Sales order not found" });
    }

    // If a line is specified, make sure it actually belongs to this sales order
    if (salesOrderLineId) {
      const line = await SalesOrderLine.findOne({
        where: { id: salesOrderLineId, orderId: salesOrder.id },
      });
      if (!line) {
        return res.status(400).json({ message: "Invalid salesOrderLineId for this sales order" });
      }
    }

    let customerName = "Unknown";
    if (salesOrder.customer) {
      customerName = salesOrder.customer.name || salesOrder.customer.shopName || "Unknown";
    }

    const delivery = await Delivery.create({
      deliveryDate: deliveryDate || new Date(),
      status: status || "Pending",
      salesOrderId: salesOrder.id,
      salesOrderLineId: salesOrderLineId || null,
      customerName,
    });

    const result = await Delivery.findByPk(delivery.id, {
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          include: [
            { model: Customer, as: "customer" },
            { model: SalesOrderLine, as: "lines" },
          ],
        },
        { model: SalesOrderLine, as: "salesOrderLine" },
      ],
    });

    res.status(201).json({ message: "Delivery created", delivery: result });
  } catch (error) {
    console.error("Error creating delivery:", error.message);
    res.status(500).json({ message: "Error creating delivery" });
  }
};

exports.getAllDeliveries = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const deliveries = await Delivery.findAll({
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          where: { distributor_id: distributorId },
          required: true,
          include: [
            { model: Customer, as: "customer" },
            { model: SalesOrderLine, as: "lines" },
          ],
        },
        { model: SalesOrderLine, as: "salesOrderLine" },
      ],
    });
    res.status(200).json(deliveries);
  } catch (error) {
    console.error("Error fetching deliveries:", error.message);
    res.status(500).json({ message: "Error fetching deliveries" });
  }
};

exports.getDeliveryById = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const delivery = await Delivery.findByPk(req.params.id, {
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          where: { distributor_id: distributorId },
          required: true,
          include: [{ model: Customer, as: "customer" }, { model: SalesOrderLine, as: "lines" }],
        },
        { model: SalesOrderLine, as: "salesOrderLine" },
      ],
    });
    if (!delivery) return res.status(404).json({ message: "Delivery not found" });
    res.status(200).json(delivery);
  } catch (error) {
    console.error("Error fetching delivery:", error.message);
    res.status(500).json({ message: "Error fetching delivery" });
  }
};

exports.updateDelivery = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const delivery = await Delivery.findByPk(req.params.id, {
      include: [{ model: SalesOrderHeader, as: "salesOrder", where: { distributor_id: distributorId }, required: true }],
    });
    if (!delivery) return res.status(404).json({ message: "Delivery not found" });

    const updates = pickUpdatable(req.body);

    // If reassigning to a different line, validate it belongs to the same sales order
    if (updates.salesOrderLineId) {
      const line = await SalesOrderLine.findOne({
        where: { id: updates.salesOrderLineId, orderId: delivery.salesOrderId },
      });
      if (!line) {
        return res.status(400).json({ message: "Invalid salesOrderLineId for this delivery's sales order" });
      }
    }

    await delivery.update(updates);

    const updatedDelivery = await Delivery.findByPk(delivery.id, {
      include: [
        { model: SalesOrderHeader, as: "salesOrder", include: [Customer, { model: SalesOrderLine, as: "lines" }] },
        { model: SalesOrderLine, as: "salesOrderLine" },
      ],
    });

    res.status(200).json({ message: "Delivery updated", delivery: updatedDelivery });
  } catch (error) {
    console.error("Error updating delivery:", error.message);
    res.status(500).json({ message: "Error updating delivery" });
  }
};

exports.deleteDelivery = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const delivery = await Delivery.findByPk(req.params.id, {
      include: [{ model: SalesOrderHeader, as: "salesOrder", where: { distributor_id: distributorId }, required: true }],
    });
    if (!delivery) return res.status(404).json({ message: "Delivery not found" });

    await delivery.destroy();
    res.status(200).json({ message: "Delivery deleted successfully" });
  } catch (error) {
    console.error("Error deleting delivery:", error.message);
    res.status(500).json({ message: "Error deleting delivery" });
  }
};

exports.getDeliveryCount = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const count = await Delivery.count({
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          attributes: [],
          where: { distributor_id: distributorId },
          required: true,
        },
      ],
    });

    res.status(200).json({ deliveryCount: count });
  } catch (error) {
    console.error("Error getting delivery count:", error.message);
    res.status(500).json({ message: "Error getting delivery count" });
  }
};
