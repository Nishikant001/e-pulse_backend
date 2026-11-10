// controllers/salesreturn.controller.js
//
// Customer -> Sales Return -> Stock IN -> linked Credit Note.
// The return carries the physical detail (product/batch/quantity); the
// credit note it generates carries the financial rollup. Posting a return
// does both atomically: StockLedger IN via services/inventory.service.js
// (the same single source of truth used everywhere else), and a Credit
// Note via salescreditnote.controller.js's buildCreditNote (no duplicate
// accounting logic).
const db = require("../models");
const inventory = require("../services/inventory.service");
const returnable = require("../services/returnableQuantity.service");
const creditNoteCtrl = require("./salescreditnote.controller");
const { SalesReturn, SalesReturnLine, SalesInvoiceHeader, SalesInvoiceLine, Customer } = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

async function generateReturnNumber(distributor_code, transaction) {
  const last = await SalesReturn.findOne({
    where: { distributor_code }, order: [["createdAt", "DESC"], ["id", "DESC"]], transaction,
  });
  let next = 1;
  if (last?.return_number) {
    next = (parseInt(String(last.return_number).split("-").pop(), 10) || 0) + 1;
  }
  return `${distributor_code}-SRET-${String(next).padStart(4, "0")}`;
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

    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: invoiceId, distributor_id: distributorId },
      include: [{ model: SalesInvoiceLine, as: "lines" }],
      transaction: t,
    });
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status !== "POSTED") {
      throw badRequest("Returns can only be raised against a POSTED invoice");
    }

    const return_number = await generateReturnNumber(distributor_code, t);
    const header = await SalesReturn.create({
      return_number,
      distributor_id: distributorId,
      distributor_code,
      customerId: invoice.customer_id,
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

      const alreadyConsumed = await returnable.getSalesInvoiceLineConsumed(invoiceLine.id, t);
      const remaining = invoiceLine.quantity - alreadyConsumed;
      if (quantity > remaining) {
        throw badRequest(
          `Cannot return more than the remaining returnable quantity for this line. ` +
          `Remaining: ${remaining}, requested: ${quantity}.`
        );
      }

      await SalesReturnLine.create({
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
    res.status(201).json({ message: "Sales return created (draft)", salesReturn: header });
  } catch (error) {
    await t.rollback();
    console.error("Sales Return Create Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error creating sales return" });
  }
};

// ======================== POST ======================== //
// DRAFT -> POSTED. Posts StockLedger IN for every line, then generates
// and posts the linked Credit Note, all in one transaction. If anything
// fails — including the GL lookup inside the credit note post — nothing
// is left partially applied: no stock movement, no return, no credit note.
exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const header = await SalesReturn.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [{ model: SalesReturnLine, as: "lines" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!header) throw notFound("Sales return not found");
    if (header.status !== "DRAFT") throw badRequest(`Cannot post a sales return with status ${header.status}`);

    for (const line of header.lines) {
      await inventory.postMovement({
        distributorId,
        productId: line.productId,
        batchId: line.batchId,
        movementType: "IN",
        quantity: line.quantity,
        referenceType: "RETURN",
        referenceId: header.id,
        referenceLineId: line.id,
        userId: req.user.id,
        reason: line.reason || "Sales return",
        transaction: t,
      });
    }

    const creditNote = await creditNoteCtrl.createFromReturn({
      distributorId,
      distributor_code,
      invoiceId: header.invoiceId,
      lines: header.lines.map((l) => ({ invoiceLineId: l.invoiceLineId, quantity: l.quantity, batchId: l.batchId })),
      reason: header.reason || "Sales return",
      sourceReturnId: header.id,
      transaction: t,
    });
    // A posted return's financial adjustment must be applied immediately,
    // not left sitting in DRAFT — otherwise "outstanding" wouldn't
    // reflect the return until someone remembers to post the note too.
    await creditNoteCtrl.postCreditNoteAccounting(creditNote, distributor_code, t);

    await header.update({ status: "POSTED", creditNoteId: creditNote.id }, { transaction: t });

    await t.commit();
    res.json({ message: "Sales return posted", salesReturn: header, creditNote });
  } catch (error) {
    await t.rollback();
    console.error("Sales Return Post Error:", error.message);
    const status = error.statusCode || (error instanceof inventory.InsufficientStockError || error instanceof inventory.InventoryValidationError ? 400 : 500);
    res.status(status).json({ error: status < 500 ? error.message : "Error posting sales return" });
  }
};

exports.cancel = async (req, res) => {
  try {
    const header = await SalesReturn.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!header) return res.status(404).json({ error: "Sales return not found" });
    if (header.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT sales return can be cancelled directly" });
    }
    await header.update({ status: "CANCELLED" });
    res.json({ message: "Sales return cancelled", salesReturn: header });
  } catch (error) {
    console.error("Sales Return Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling sales return" });
  }
};

exports.getAll = async (req, res) => {
  try {
    const returns = await SalesReturn.findAll({
      where: { distributor_id: req.user.id },
      include: [
        { model: Customer, as: "customer" },
        { model: SalesReturnLine, as: "lines", include: [{ model: db.Product, as: "product" }] },
      ],
      order: [["createdAt", "DESC"]],
    });
    res.json(returns);
  } catch (error) {
    console.error("Sales Return GetAll Error:", error.message);
    res.status(500).json({ error: "Error fetching sales returns" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const header = await SalesReturn.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: Customer, as: "customer" },
        { model: SalesReturnLine, as: "lines", include: [{ model: db.Product, as: "product" }, { model: db.Batch, as: "batch" }] },
        { model: SalesInvoiceHeader, as: "invoice" },
      ],
    });
    if (!header) return res.status(404).json({ message: "Sales return not found" });
    res.json(header);
  } catch (error) {
    console.error("Sales Return GetOne Error:", error.message);
    res.status(500).json({ error: "Error fetching sales return" });
  }
};
