// controllers/purchasereturn.controller.js
//
// Purchase Invoice/Delivery -> Purchase Return -> Stock OUT -> linked
// Debit Note (reduces what's owed to the vendor). Mirrors
// salesreturn.controller.js exactly, but stock moves OUT (goods leaving
// back to the vendor) and the financial document is a Debit Note instead
// of a Credit Note.
const db = require("../models");
const inventory = require("../services/inventory.service");
const returnable = require("../services/returnableQuantity.service");
const debitNoteCtrl = require("./purchasedebitnote.controller");
const { PurchaseReturn, PurchaseReturnLine, PurchaseInvoiceHeader, PurchaseInvoiceLine, Vendor } = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

async function generateReturnNumber(distributor_code, transaction) {
  const last = await PurchaseReturn.findOne({
    where: { distributor_code }, order: [["createdAt", "DESC"], ["id", "DESC"]], transaction,
  });
  let next = 1;
  if (last?.return_number) {
    next = (parseInt(String(last.return_number).split("-").pop(), 10) || 0) + 1;
  }
  return `${distributor_code}-PRET-${String(next).padStart(4, "0")}`;
}

// ======================== CREATE (DRAFT) ======================== //
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;
    const { invoiceId, returnDate, reason, lines } = req.body;

    if (!invoiceId || !Array.isArray(lines) || lines.length === 0) {
      throw badRequest("invoiceId and at least one line are required");
    }

    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: invoiceId, distributor_id: distributorId },
      include: [{ model: PurchaseInvoiceLine, as: "lines" }],
      transaction: t,
    });
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status !== "POSTED") {
      throw badRequest("Returns can only be raised against a POSTED invoice");
    }

    const return_number = await generateReturnNumber(distributor_code, t);
    const header = await PurchaseReturn.create({
      return_number,
      distributor_id: distributorId,
      distributor_code,
      vendor_id: invoice.vendor_id,
      invoiceId,
      returnDate: returnDate || new Date(),
      reason: reason || null,
      status: "DRAFT",
    }, { transaction: t });

    for (const reqLine of lines) {
      const invoiceLine = invoice.lines.find((l) => l.id === reqLine.invoiceLineId);
      if (!invoiceLine) throw badRequest(`Invalid invoice line ID: ${reqLine.invoiceLineId}`);

      const quantity = reqLine.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw badRequest("quantity must be a positive whole number");
      }
      if (!reqLine.batchId) {
        throw badRequest("batchId is required for each return line");
      }

      const batch = await db.Batch.findOne({
        where: { id: reqLine.batchId, productId: invoiceLine.productId, distributor_id: distributorId },
        transaction: t,
      });
      if (!batch) throw badRequest("Invalid batch for this product/distributor");

      const alreadyConsumed = await returnable.getPurchaseInvoiceLineConsumed(invoiceLine.id, t);
      const remaining = invoiceLine.quantity - alreadyConsumed;
      if (quantity > remaining) {
        throw badRequest(
          `Cannot return more than the remaining eligible quantity for this line. ` +
          `Remaining: ${remaining}, requested: ${quantity}.`
        );
      }

      await PurchaseReturnLine.create({
        returnId: header.id,
        invoiceLineId: invoiceLine.id,
        productId: invoiceLine.productId,
        batchId: batch.id,
        quantity,
        pricePerUnit: invoiceLine.pricePerUnit,
        reason: reqLine.reason || null,
      }, { transaction: t });
    }

    await t.commit();
    res.status(201).json({ message: "Purchase return created (draft)", purchaseReturn: header });
  } catch (error) {
    await t.rollback();
    console.error("Purchase Return Create Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error creating purchase return" });
  }
};

// ======================== POST ======================== //
// DRAFT -> POSTED. Posts StockLedger OUT for every line (rejecting if
// insufficient stock — goods can't be sent back to the vendor if they've
// already been sold/consumed), then generates and posts the linked Debit
// Note, all in one transaction.
exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const header = await PurchaseReturn.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [{ model: PurchaseReturnLine, as: "lines" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!header) throw notFound("Purchase return not found");
    if (header.status !== "DRAFT") throw badRequest(`Cannot post a purchase return with status ${header.status}`);

    let taxableValue = 0;
    for (const line of header.lines) {
      // allowNegative defaults to false inside postMovement — insufficient
      // stock throws InsufficientStockError, rolling back the whole return.
      await inventory.postMovement({
        distributorId,
        productId: line.productId,
        batchId: line.batchId,
        movementType: "OUT",
        quantity: line.quantity,
        referenceType: "RETURN",
        referenceId: header.id,
        referenceLineId: line.id,
        userId: req.user.id,
        reason: line.reason || "Purchase return",
        transaction: t,
      });
      taxableValue += Number(line.pricePerUnit) * line.quantity;
    }

    const debitNote = await debitNoteCtrl.createFromReturn({
      distributorId,
      distributor_code,
      vendorId: header.vendor_id,
      invoiceId: header.invoiceId,
      taxableValue,
      reason: header.reason || "Purchase return",
      sourceReturnId: header.id,
      transaction: t,
    });
    await debitNoteCtrl.postDebitNoteAccounting(debitNote, distributor_code, t);

    await header.update({ status: "POSTED", debitNoteId: debitNote.id }, { transaction: t });

    await t.commit();
    res.json({ message: "Purchase return posted", purchaseReturn: header, debitNote });
  } catch (error) {
    await t.rollback();
    console.error("Purchase Return Post Error:", error.message);
    const status = error.statusCode || (error instanceof inventory.InsufficientStockError || error instanceof inventory.InventoryValidationError ? 400 : 500);
    res.status(status).json({ error: status < 500 ? error.message : "Error posting purchase return" });
  }
};

exports.cancel = async (req, res) => {
  try {
    const header = await PurchaseReturn.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!header) return res.status(404).json({ error: "Purchase return not found" });
    if (header.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT purchase return can be cancelled directly" });
    }
    await header.update({ status: "CANCELLED" });
    res.json({ message: "Purchase return cancelled", purchaseReturn: header });
  } catch (error) {
    console.error("Purchase Return Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling purchase return" });
  }
};

exports.getAll = async (req, res) => {
  try {
    const returns = await PurchaseReturn.findAll({
      where: { distributor_id: req.user.id },
      include: [
        { model: Vendor, as: "vendor" },
        { model: PurchaseReturnLine, as: "lines", include: [{ model: db.Product, as: "product" }] },
      ],
      order: [["createdAt", "DESC"]],
    });
    res.json(returns);
  } catch (error) {
    console.error("Purchase Return GetAll Error:", error.message);
    res.status(500).json({ error: "Error fetching purchase returns" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const header = await PurchaseReturn.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: Vendor, as: "vendor" },
        { model: PurchaseReturnLine, as: "lines", include: [{ model: db.Product, as: "product" }, { model: db.Batch, as: "batch" }] },
        { model: PurchaseInvoiceHeader, as: "invoice" },
      ],
    });
    if (!header) return res.status(404).json({ message: "Purchase return not found" });
    res.json(header);
  } catch (error) {
    console.error("Purchase Return GetOne Error:", error.message);
    res.status(500).json({ error: "Error fetching purchase return" });
  }
};
