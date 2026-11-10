const db = require("../models");
const tax = require("../services/tax.service");

const {
  PurchaseOrderHeader,
  PurchaseOrderLine,
  Product,
  Vendor,
  HSNGroup,
} = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

// -------------------- STATE MACHINE --------------------
const STATUSES = ["DRAFT", "CONFIRMED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CANCELLED", "CLOSED"];
const ALLOWED_TRANSITIONS = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CANCELLED"],
  PARTIALLY_RECEIVED: ["FULLY_RECEIVED"],
  FULLY_RECEIVED: ["CLOSED"],
  CANCELLED: [],
  CLOSED: [],
};
function assertTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw badRequest(`Cannot transition purchase order from ${from} to ${to}`);
  }
}
// Statuses in which a PO can still be received against.
const DELIVERABLE_STATUSES = ["CONFIRMED", "PARTIALLY_RECEIVED"];

/* ===========================================================
   HELPER – GENERATE PO NUMBER
=========================================================== */
async function generatePONumber(distributor_code, transaction) {
  const lastOrder = await PurchaseOrderHeader.findOne({
    where: { distributor_code },
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
  });

  let nextNumber = "0001";
  if (lastOrder?.order_number) {
    const lastNo = parseInt(lastOrder.order_number.split("-")[2], 10) || 0;
    nextNumber = String(lastNo + 1).padStart(4, "0");
  }
  return `${distributor_code}-PO-${nextNumber}`;
}

function validateLineInput(line) {
  const { productId, quantity, pricePerUnit, discount } = line;
  if (!productId) throw badRequest("Each line requires a productId");
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest("quantity must be a positive whole number");
  }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
    throw badRequest("pricePerUnit must be a non-negative number");
  }
  if (discount !== undefined && discount !== null) {
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw badRequest("discount must be between 0 and 100");
    }
  }
}

async function buildLine({ line, distributorId, vendor, distributor, transaction }) {
  validateLineInput(line);
  const { productId, quantity, pricePerUnit, discount = 0 } = line;

  const product = await Product.findOne({
    where: { id: productId, distributor_id: distributorId },
    include: [{ model: HSNGroup, as: "hsn" }],
    transaction,
  });
  if (!product) throw badRequest("Product not found for this distributor");

  const finalPrice = Number(pricePerUnit);
  const gross = tax.round2(finalPrice * quantity);
  const discountAmount = tax.round2((gross * discount) / 100);
  const taxableValue = tax.round2(gross - discountAmount);

  const gstRate = product.hsn?.gst_rate || 0;
  const { cgstAmount, sgstAmount, igstAmount, totalTax } = tax.computeHsnBasedTax(
    taxableValue, gstRate, vendor, distributor
  );
  const lineNetValue = tax.round2(taxableValue + totalTax);

  return {
    productId,
    material_code: product.material_code,
    quantity,
    pricePerUnit: finalPrice,
    discount,
    lineNetValue,
    _tax: { taxableValue, cgstAmount, sgstAmount, igstAmount },
  };
}

/* ===========================================================
   CREATE PURCHASE ORDER
=========================================================== */
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const { orderDate, vendorId, paymentMethod, description, lines } = req.body;
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    // e-Pulse Phase 1: vendorId is OPTIONAL. A PO is addressed to the distributor's admin (tenant admin), who sees it in the Admin portal;
    // the distributor no longer picks a vendor. A vendorId, when still sent (older clients), is validated exactly as before.
    if (!orderDate || !Array.isArray(lines) || !lines.length) {
      throw badRequest("orderDate and at least one line are required");
    }

    const distributor = await db.Distributor.findByPk(distributorId, { transaction: t });
    if (!distributor) throw notFound("Distributor not found");

    // Tenant isolation: a vendor, if supplied, must belong to this distributor
    let vendor = null;
    if (vendorId) {
      vendor = await Vendor.findOne({
        where: { id: vendorId, distributor_id: distributorId },
        transaction: t,
      });
      if (!vendor) throw notFound("Vendor not found for this distributor");
    }

    const order_number = await generatePONumber(distributor_code, t);

    let netValue = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

    const header = await PurchaseOrderHeader.create({
      orderDate,
      order_number,
      distributor_code,
      vendorId: vendor ? vendor.id : null,
      distributor_id: distributorId,
      vendorName: vendor ? vendor.name : null,
      address: vendor ? `${vendor.street1 || ""} ${vendor.street2 || ""} ${vendor.city || ""}` : null,
      paymentMethod,
      description,
      status: "DRAFT",
    }, { transaction: t });

    for (const line of lines) {
      const built = await buildLine({ line, distributorId, vendor, distributor, transaction: t });
      netValue += Number(built._tax.taxableValue);
      cgstAmount += Number(built._tax.cgstAmount);
      sgstAmount += Number(built._tax.sgstAmount);
      igstAmount += Number(built._tax.igstAmount);
      delete built._tax;
      await PurchaseOrderLine.create({ orderId: header.id, ...built }, { transaction: t });
    }

    netValue = tax.round2(netValue);
    cgstAmount = tax.round2(cgstAmount);
    sgstAmount = tax.round2(sgstAmount);
    igstAmount = tax.round2(igstAmount);
    const totalAmount = tax.round2(netValue + cgstAmount + sgstAmount + igstAmount);

    await header.update({ netValue, cgstAmount, sgstAmount, igstAmount, totalAmount }, { transaction: t });

    await t.commit();
    return res.status(201).json({ message: "Purchase order created successfully", order_number, header });
  } catch (err) {
    await t.rollback();
    console.error("Error creating purchase order:", err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Error creating purchase order" });
  }
};

/* ===========================================================
   CONFIRM / CANCEL
=========================================================== */
exports.confirm = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const header = await PurchaseOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
    });
    if (!header) throw notFound("Purchase order not found");
    assertTransition(header.status, "CONFIRMED");
    await header.update({ status: "CONFIRMED" }, { transaction: t });
    await t.commit();
    res.json({ message: "Purchase order confirmed", header });
  } catch (err) {
    await t.rollback();
    console.error("Error confirming purchase order:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Error confirming purchase order" });
  }
};

exports.cancel = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const header = await PurchaseOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
    });
    if (!header) throw notFound("Purchase order not found");
    assertTransition(header.status, "CANCELLED");
    await header.update({ status: "CANCELLED" }, { transaction: t });
    await t.commit();
    res.json({ message: "Purchase order cancelled", header });
  } catch (err) {
    await t.rollback();
    console.error("Error cancelling purchase order:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Error cancelling purchase order" });
  }
};

/* ===========================================================
   GET ALL / GET ONE / GET BY NUMBER — with received/remaining progress
=========================================================== */
async function withReceivingProgress(order) {
  if (!order) return order;
  const plain = order.toJSON ? order.toJSON() : order;
  if (!Array.isArray(plain.lines)) return plain;

  for (const line of plain.lines) {
    const received = await db.PurchaseDeliveryLine.sum("quantityReceived", {
      where: { orderLineId: line.id },
    });
    line.receivedQuantity = received || 0;
    line.remainingQuantity = line.quantity - (received || 0);
  }
  return plain;
}

exports.getAll = async (req, res) => {
  try {
    const orders = await PurchaseOrderHeader.findAll({
      where: { distributor_id: req.user.id },
      include: [
        // Vendor has no `state` column — the real field is `region`; aliased so the response shape is unchanged.
        { model: Vendor, as: "vendor", attributes: ["id", "name", "vendor_code", "city", ["region", "state"]] },
        { model: PurchaseOrderLine, as: "lines" },
      ],
      order: [["createdAt", "DESC"]],
    });
    res.json(await Promise.all(orders.map(withReceivingProgress)));
  } catch (err) {
    console.error("Error fetching purchase orders:", err.message);
    res.status(500).json({ error: "Error fetching purchase orders" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const order = await PurchaseOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: Vendor, as: "vendor" },
        {
          model: PurchaseOrderLine, as: "lines",
          include: [{ model: Product, as: "product", include: [{ model: HSNGroup, as: "hsn", attributes: ["hsn_code", "gst_rate"] }] }],
        },
      ],
    });
    if (!order) return res.status(404).json({ message: "Purchase order not found" });
    res.json(await withReceivingProgress(order));
  } catch (err) {
    console.error("Error fetching purchase order:", err.message);
    res.status(500).json({ error: "Error fetching purchase order" });
  }
};

exports.getByNumber = async (req, res) => {
  try {
    const order = await PurchaseOrderHeader.findOne({
      where: { order_number: req.params.order_number, distributor_code: req.user.distributor_code },
      include: [
        { model: Vendor, as: "vendor" },
        {
          model: PurchaseOrderLine, as: "lines",
          include: [{ model: Product, as: "product", include: [{ model: HSNGroup, as: "hsn" }] }],
        },
      ],
    });
    if (!order) return res.status(404).json({ message: "Purchase order not found" });
    res.json(await withReceivingProgress(order));
  } catch (err) {
    console.error("Error fetching purchase order by number:", err.message);
    res.status(500).json({ error: "Error fetching purchase order" });
  }
};

/* ===========================================================
   UPDATE — full line editing while DRAFT; header-only otherwise
=========================================================== */
exports.update = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const { vendorId, paymentMethod, description, orderDate, lines } = req.body;

    const header = await PurchaseOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      transaction: t,
    });
    if (!header) throw notFound("Purchase order not found");

    if (Array.isArray(lines) && header.status !== "DRAFT") {
      throw badRequest("Order lines can only be changed while the order is in DRAFT status");
    }

    let vendor = null;
    if (vendorId && vendorId !== header.vendorId) {
      if (header.status !== "DRAFT") {
        throw badRequest("Vendor can only be changed while the order is in DRAFT status");
      }
      vendor = await Vendor.findOne({ where: { id: vendorId, distributor_id: distributorId }, transaction: t });
      if (!vendor) throw badRequest("Vendor not found for this distributor");
    }

    let netValue, cgstAmount, sgstAmount, igstAmount, totalAmount;

    if (Array.isArray(lines)) {
      const distributor = await db.Distributor.findByPk(distributorId, { transaction: t });
      const effectiveVendor = vendor || (header.vendorId ? await Vendor.findByPk(header.vendorId, { transaction: t }) : null);

      await PurchaseOrderLine.destroy({ where: { orderId: header.id }, transaction: t });

      netValue = 0; cgstAmount = 0; sgstAmount = 0; igstAmount = 0;
      for (const line of lines) {
        const built = await buildLine({ line, distributorId, vendor: effectiveVendor, distributor, transaction: t });
        netValue += Number(built._tax.taxableValue);
        cgstAmount += Number(built._tax.cgstAmount);
        sgstAmount += Number(built._tax.sgstAmount);
        igstAmount += Number(built._tax.igstAmount);
        delete built._tax;
        await PurchaseOrderLine.create({ orderId: header.id, ...built }, { transaction: t });
      }
      netValue = tax.round2(netValue);
      cgstAmount = tax.round2(cgstAmount);
      sgstAmount = tax.round2(sgstAmount);
      igstAmount = tax.round2(igstAmount);
      totalAmount = tax.round2(netValue + cgstAmount + sgstAmount + igstAmount);
    }

    await header.update({
      orderDate: orderDate ?? header.orderDate,
      vendorId: vendor ? vendor.id : header.vendorId,
      vendorName: vendor ? vendor.name : header.vendorName,
      paymentMethod: paymentMethod ?? header.paymentMethod,
      description: description ?? header.description,
      ...(netValue !== undefined ? { netValue, cgstAmount, sgstAmount, igstAmount, totalAmount } : {}),
    }, { transaction: t });

    await t.commit();
    res.json({ message: "Purchase order updated", header });
  } catch (err) {
    await t.rollback();
    console.error("Error updating purchase order:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Error updating purchase order" });
  }
};

/* ===========================================================
   DELETE — only DRAFT; confirmed orders must go through cancel()
=========================================================== */
exports.delete = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const header = await PurchaseOrderHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      transaction: t,
    });
    if (!header) throw notFound("Purchase order not found");

    if (header.status !== "DRAFT") {
      throw badRequest("Only DRAFT purchase orders can be deleted; cancel confirmed orders instead");
    }

    await PurchaseOrderLine.destroy({ where: { orderId: header.id }, transaction: t });
    await header.destroy({ transaction: t });

    await t.commit();
    res.json({ message: "Purchase order deleted successfully" });
  } catch (err) {
    await t.rollback();
    console.error("Error deleting purchase order:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Error deleting purchase order" });
  }
};

exports.STATUSES = STATUSES;
exports.DELIVERABLE_STATUSES = DELIVERABLE_STATUSES;
exports.assertTransition = assertTransition;
