// controllers/salesorder.controller.js
//
// IMPORTANT: A Sales Order is a commercial commitment, NOT a physical stock
// movement. It must never create/update/delete StockLedger rows or touch
// Batch quantities. Physical stock is only ever affected by a confirmed
// Sales Delivery (see salesdelivery.controller.js).
const db = require("../models");
const SalesOrderHeader = db.SalesOrderHeader;
const SalesOrderLine = db.SalesOrderLine;
const Product = db.Product;
const Batch = db.Batch;
const Customer = db.Customer;
const pricing = require("../services/pricing.service");
const tax = require("../services/tax.service");

// -------------------- STATE MACHINE --------------------
const STATUSES = ["DRAFT", "CONFIRMED", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELLED", "CLOSED"];
const ALLOWED_TRANSITIONS = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELLED"],
  PARTIALLY_DELIVERED: ["FULLY_DELIVERED"],
  FULLY_DELIVERED: ["CLOSED"],
  CANCELLED: [],
  CLOSED: [],
};

function assertTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    const err = new Error(`Cannot transition sales order from ${from} to ${to}`);
    err.statusCode = 400;
    throw err;
  }
}

// Statuses in which a sales order can still be delivered against.
const DELIVERABLE_STATUSES = ["CONFIRMED", "PARTIALLY_DELIVERED"];

async function generateOrderNumber(distributor_code, transaction) {
  const lastOrder = await db.SalesOrderHeader.findOne({
    where: { distributor_code },
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
  });

  let nextNumber = "0001";
  if (lastOrder?.order_number) {
    // Phase 16 fix: the counter is the LAST segment ("DTC001-SO-0007" → 7). The old split("-")[1] read "SO" → 0, so every new order of a
    // distributor got number 0001 and the second one failed on the UNIQUE order_number. Existing numbers are unchanged.
    const lastNo = parseInt(lastOrder.order_number.split("-").pop(), 10) || 0;
    nextNumber = String(lastNo + 1).padStart(4, "0");
  }
  return `${distributor_code}-SO-${nextNumber}`;
}

// -------------------- LINE VALIDATION --------------------
function validateLineInput(line) {
  const { productId, quantity, pricePerUnit, discount } = line;

  if (!Number.isInteger(productId) && !(typeof productId === "number" && Number.isFinite(productId))) {
    throw badRequest("Each line requires a valid productId");
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest("quantity must be a positive whole number");
  }
  if (quantity > 1_000_000) {
    throw badRequest("quantity exceeds the maximum allowed per line");
  }
  if (pricePerUnit !== undefined && pricePerUnit !== null) {
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      throw badRequest("pricePerUnit must be a non-negative number");
    }
  }
  if (discount !== undefined && discount !== null) {
    if (!Number.isFinite(discount) || discount < 0) {
      throw badRequest("discount must be a non-negative number");
    }
    if (discount > 100) {
      throw badRequest("discount cannot exceed 100%");
    }
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Resolve the authoritative price/tax for a line. Prefers PricingMaster
 * (authoritative, ignores any client-supplied price when available).
 * Falls back to the client-supplied pricePerUnit only when no
 * PricingMaster entry exists yet for this product/customer-group — this
 * keeps the system usable for distributors who haven't finished pricing
 * setup, while making pricing authoritative wherever it IS configured.
 */
async function resolveLinePricing({ productId, customerId, distributorId, clientPrice, transaction }) {
  try {
    const resolved = await pricing.getFinalPriceForCustomer({
      productId, customerId, distributorId, transaction,
    });
    return { unitPrice: resolved.unitPrice, source: "PricingMaster" };
  } catch (err) {
    if (err instanceof pricing.PricingNotConfiguredError) {
      if (clientPrice === undefined || clientPrice === null) {
        throw badRequest(`No pricing configured for this product, and no pricePerUnit was supplied`);
      }
      return { unitPrice: clientPrice, source: "manual" };
    }
    throw err;
  }
}

async function buildLine({ line, distributorId, customerId, transaction }) {
  validateLineInput(line);
  const { productId, batchId, quantity, discount = 0 } = line;

  const product = await Product.findOne({
    where: { id: productId, distributor_id: distributorId },
    transaction,
  });
  if (!product) throw badRequest("Product not found for this distributor");

  if (batchId) {
    const batch = await Batch.findOne({
      where: { id: batchId, productId, distributor_id: distributorId },
      transaction,
    });
    if (!batch) throw badRequest(`Invalid batch ${batchId} for this product/distributor`);
  }

  const { unitPrice } = await resolveLinePricing({
    productId, customerId, distributorId, clientPrice: line.pricePerUnit, transaction,
  });

  const gross = unitPrice * quantity;
  const discountAmount = tax.round2((gross * discount) / 100);
  const taxableValue = tax.round2(gross - discountAmount);
  const { cgstAmount, sgstAmount, igstAmount, totalTax } = tax.computeLineTax(taxableValue, product);
  const lineNetValue = tax.round2(taxableValue + totalTax);

  return {
    productId,
    batchId: batchId || null,
    material_code: product.material_code,
    quantity,
    pricePerUnit: unitPrice,
    discount,
    lineNetValue,
    _tax: { cgstAmount, sgstAmount, igstAmount, taxableValue },
  };
}

// -------------------- CREATE --------------------
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const {
      orderDate, customerId, paymentMethod, description, lines,
      expectedDeliveryDate, billingAddress, shippingAddress,
    } = req.body;
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    if (!customerId || !Array.isArray(lines) || lines.length === 0) {
      throw badRequest("customerId and at least one line are required");
    }

    // Phase 8: a deactivated / pending distributor cannot create NEW orders (existing orders are untouched).
    // Rows created before Phase 8 default to 'active', so this never affects existing tenants.
    const owner = await db.Distributor.findOne({ where: { id: distributorId }, attributes: ["id", "status"], transaction: t });
    if (owner && owner.status && owner.status !== "active") {
      const blocked = badRequest("This distributor account is not active. New orders cannot be created.");
      blocked.statusCode = 403;
      throw blocked;
    }

    const customer = await Customer.findOne({
      where: { id: customerId, distributor_id: distributorId },
      transaction: t,
    });
    if (!customer) throw badRequest("Customer not found");

    // Phase 9: an inactive / pending retailer cannot receive NEW orders (historical documents are untouched).
    if (customer.status && customer.status !== "active") {
      const blocked = badRequest("This retailer is not active. New orders cannot be created for it.");
      blocked.statusCode = 409;
      throw blocked;
    }

    const order_number = await generateOrderNumber(distributor_code, t);

    let netValue = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

    const header = await SalesOrderHeader.create({
      orderDate,
      order_number,
      distributor_code,
      customerId,
      distributor_id: distributorId,
      customerName: customer.name,
      address: `${customer.street1 || ""} ${customer.street2 || ""} ${customer.city || ""}`,
      billingAddress: billingAddress || null,
      shippingAddress: shippingAddress || null,
      expectedDeliveryDate: expectedDeliveryDate || null,
      paymentMethod,
      description,
      status: "DRAFT",
    }, { transaction: t });

    for (const line of lines) {
      const built = await buildLine({ line, distributorId, customerId, transaction: t });
      netValue += Number(built._tax.taxableValue);
      cgstAmount += Number(built._tax.cgstAmount);
      sgstAmount += Number(built._tax.sgstAmount);
      igstAmount += Number(built._tax.igstAmount);

      delete built._tax;
      await SalesOrderLine.create({ orderId: header.id, ...built }, { transaction: t });
    }

    netValue = tax.round2(netValue);
    cgstAmount = tax.round2(cgstAmount);
    sgstAmount = tax.round2(sgstAmount);
    igstAmount = tax.round2(igstAmount);
    const totalAmount = tax.round2(netValue + cgstAmount + sgstAmount + igstAmount);

    await header.update({ netValue, cgstAmount, sgstAmount, igstAmount, totalAmount }, { transaction: t });

    await t.commit();
    res.status(201).json({ message: "Sales order created", order_number, header });
  } catch (err) {
    await t.rollback();
    console.error("Error creating sales order:", err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// -------------------- CONFIRM --------------------
exports.confirm = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const header = await SalesOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
    });
    if (!header) {
      await t.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    assertTransition(header.status, "CONFIRMED");
    await header.update({ status: "CONFIRMED" }, { transaction: t });
    await t.commit();
    res.json({ message: "Order confirmed", header });
  } catch (err) {
    await t.rollback();
    console.error("Error confirming sales order:", err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// -------------------- CANCEL --------------------
exports.cancel = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const header = await SalesOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
    });
    if (!header) {
      await t.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    assertTransition(header.status, "CANCELLED");
    await header.update({ status: "CANCELLED" }, { transaction: t });
    await t.commit();
    res.json({ message: "Order cancelled", header });
  } catch (err) {
    await t.rollback();
    console.error("Error cancelling sales order:", err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// -------------------- GET ONE --------------------
// Attach real delivered/remaining quantities to each order line, computed
// from SalesDeliveryLine (the same source of truth used by
// recomputeOrderStatus in salesdelivery.controller.js) — never a second,
// independently-maintained counter.
async function withDeliveryProgress(order) {
  if (!order) return order;
  const plain = order.toJSON ? order.toJSON() : order;
  if (!Array.isArray(plain.lines)) return plain;

  for (const line of plain.lines) {
    const delivered = await db.SalesDeliveryLine.sum("quantityDelivered", {
      where: { orderLineId: line.id },
      include: [{
        model: db.SalesDeliveryHeader, as: "delivery",
        where: { status: { [db.Sequelize.Op.ne]: "Cancelled" } }, attributes: [],
      }],
    });
    line.deliveredQuantity = delivered || 0;
    line.remainingQuantity = line.quantity - (delivered || 0);
  }
  return plain;
}

exports.getOne = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const order = await SalesOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [
        { model: Customer, as: "customer" },
        { model: SalesOrderLine, as: "lines", include: ["product", "batch"] },
      ],
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(await withDeliveryProgress(order));
  } catch (err) {
    console.error("Error fetching sales order:", err.message);
    res.status(500).json({ error: "Error fetching sales order" });
  }
};

// -------------------- GET ALL --------------------
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const orders = await SalesOrderHeader.findAll({
      where: { distributor_id: distributorId },
      include: [
        { model: Customer, as: "customer" },
        { model: SalesOrderLine, as: "lines", include: ["product", "batch"] },
      ],
      order: [["orderDate", "DESC"]],
    });
    res.json(await Promise.all(orders.map(withDeliveryProgress)));
  } catch (err) {
    console.error("Error fetching sales orders:", err.message);
    res.status(500).json({ error: "Error fetching sales orders" });
  }
};

// -------------------- UPDATE --------------------
// Only allowed while the order is still DRAFT — once confirmed, changing
// quantities/products would desync from anything already delivered/priced.
exports.update = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const orderId = req.params.id;
    const {
      orderDate, customerId, paymentMethod, description, lines,
      expectedDeliveryDate, billingAddress, shippingAddress,
    } = req.body;

    const header = await SalesOrderHeader.findOne({
      where: { id: orderId, distributor_id: distributorId },
      include: { model: SalesOrderLine, as: "lines" },
      transaction: t,
    });
    if (!header) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

    if (Array.isArray(lines) && header.status !== "DRAFT") {
      throw badRequest("Order lines can only be changed while the order is in DRAFT status");
    }

    let netValue, cgstAmount, sgstAmount, igstAmount, totalAmount;

    if (Array.isArray(lines)) {
      await SalesOrderLine.destroy({ where: { orderId }, transaction: t });

      netValue = 0; cgstAmount = 0; sgstAmount = 0; igstAmount = 0;
      const effectiveCustomerId = customerId || header.customerId;
      for (const line of lines) {
        const built = await buildLine({ line, distributorId, customerId: effectiveCustomerId, transaction: t });
        netValue += Number(built._tax.taxableValue);
        cgstAmount += Number(built._tax.cgstAmount);
        sgstAmount += Number(built._tax.sgstAmount);
        igstAmount += Number(built._tax.igstAmount);
        delete built._tax;
        await SalesOrderLine.create({ orderId, ...built }, { transaction: t });
      }
      netValue = tax.round2(netValue);
      cgstAmount = tax.round2(cgstAmount);
      sgstAmount = tax.round2(sgstAmount);
      igstAmount = tax.round2(igstAmount);
      totalAmount = tax.round2(netValue + cgstAmount + sgstAmount + igstAmount);
    }

    let customerName = header.customerName;
    if (customerId && customerId !== header.customerId) {
      const customer = await Customer.findOne({
        where: { id: customerId, distributor_id: distributorId },
        transaction: t,
      });
      if (!customer) throw badRequest("Invalid customer for this distributor");
      customerName = customer.name;
    }

    await header.update({
      orderDate: orderDate ?? header.orderDate,
      customerId: customerId ?? header.customerId,
      customerName,
      paymentMethod: paymentMethod ?? header.paymentMethod,
      description: description ?? header.description,
      expectedDeliveryDate: expectedDeliveryDate ?? header.expectedDeliveryDate,
      billingAddress: billingAddress ?? header.billingAddress,
      shippingAddress: shippingAddress ?? header.shippingAddress,
      ...(netValue !== undefined ? { netValue, cgstAmount, sgstAmount, igstAmount, totalAmount } : {}),
    }, { transaction: t });

    await t.commit();
    res.json({ message: "Order updated", header });
  } catch (err) {
    await t.rollback();
    console.error("Error updating sales order:", err.message);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// -------------------- DELETE --------------------
// Only DRAFT orders can be deleted outright; confirmed orders must go
// through cancel() to preserve the audit trail.
exports.delete = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const orderId = req.params.id;

    const header = await SalesOrderHeader.findOne({
      where: { id: orderId, distributor_id: distributorId },
      transaction: t,
    });
    if (!header) {
      await t.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    if (header.status !== "DRAFT") {
      await t.rollback();
      return res.status(400).json({ message: "Only DRAFT orders can be deleted; cancel confirmed orders instead" });
    }

    await SalesOrderLine.destroy({ where: { orderId }, transaction: t });
    await header.destroy({ transaction: t });

    await t.commit();
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    await t.rollback();
    console.error("Error deleting sales order:", err.message);
    res.status(500).json({ error: "Error deleting sales order" });
  }
};

// -------------------- COUNT --------------------
exports.getOrderCountByDistributor = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const count = await SalesOrderHeader.count({ where: { distributor_id: distributorId } });
    res.status(200).json({ distributor_id: distributorId, orderCount: count });
  } catch (err) {
    console.error("Error counting sales orders:", err.message);
    res.status(500).json({ error: "Error counting sales orders" });
  }
};

exports.getByNumber = async (req, res) => {
  try {
    const order = await SalesOrderHeader.findOne({
      where: {
        order_number: req.params.order_number,
        distributor_code: req.user.distributor_code,
      },
      include: [
        { model: Customer, as: "customer" },
        { model: SalesOrderLine, as: "lines", include: ["product", "batch"] },
      ],
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(await withDeliveryProgress(order));
  } catch (err) {
    console.error("Error fetching sales order by number:", err.message);
    res.status(500).json({ error: "Error fetching sales order" });
  }
};

exports.STATUSES = STATUSES;
exports.DELIVERABLE_STATUSES = DELIVERABLE_STATUSES;
exports.assertTransition = assertTransition;
