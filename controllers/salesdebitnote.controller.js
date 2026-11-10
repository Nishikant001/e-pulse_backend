// controllers/salesdebitnote.controller.js
//
// A Sales Debit Note increases what a customer owes (e.g. an under-billed
// invoice correction). Simpler than the Credit Note engine — no line-item
// quantity validation against the invoice, since a debit note isn't
// bounded by "what was originally sold" the way a credit/return is.
const db = require("../models");
const tax = require("../services/tax.service");
const accounting = require("../services/accounting.service");
const { SalesDebitNote, SalesInvoiceHeader, Customer } = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}


async function generateDebitNoteNumber(distributor_code, transaction) {
  const last = await SalesDebitNote.findOne({
    where: { distributor_code }, order: [["createdAt", "DESC"], ["id", "DESC"]], transaction,
  });
  let next = 1;
  if (last?.debit_note_number) {
    next = (parseInt(String(last.debit_note_number).split("-").pop(), 10) || 0) + 1;
  }
  return `${distributor_code}-DN-${String(next).padStart(4, "0")}`;
}

exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;
    const { invoiceId, taxableValue, cgstAmount = 0, sgstAmount = 0, igstAmount = 0, reason } = req.body;

    if (!invoiceId) throw badRequest("invoiceId is required");
    if (!Number.isFinite(taxableValue) || taxableValue <= 0) {
      throw badRequest("taxableValue must be a positive number");
    }
    for (const [label, val] of [["cgstAmount", cgstAmount], ["sgstAmount", sgstAmount], ["igstAmount", igstAmount]]) {
      if (!Number.isFinite(val) || val < 0) throw badRequest(`${label} must be a non-negative number`);
    }

    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: invoiceId, distributor_id: distributorId },
      transaction: t,
    });
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status !== "POSTED") {
      throw badRequest("Debit notes can only be raised against a POSTED invoice");
    }

    const debit_note_number = await generateDebitNoteNumber(distributor_code, t);
    const totalAmount = tax.round2(Number(taxableValue) + Number(cgstAmount) + Number(sgstAmount) + Number(igstAmount));

    const note = await SalesDebitNote.create({
      invoiceId,
      distributor_id: distributorId,
      distributor_code,
      debit_note_number,
      customerId: invoice.customer_id,
      reason: reason || null,
      status: "DRAFT",
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalAmount,
      amount: totalAmount,
    }, { transaction: t });

    await t.commit();
    res.status(201).json({ message: "Debit note created (draft)", debitNote: note });
  } catch (error) {
    await t.rollback();
    console.error("Debit Note Create Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error creating debit note" });
  }
};

// DRAFT -> POSTED. Increases the customer's receivable and revenue/tax —
// the mirror image of a credit note's posting.
exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const note = await SalesDebitNote.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [{ model: Customer, as: "customer" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!note) throw notFound("Debit note not found");
    if (note.status !== "DRAFT") throw badRequest(`Cannot post a debit note with status ${note.status}`);

    const receivableGL = await accounting.getGL("Accounts Receivable", distributor_code, t);
    const salesGL = await accounting.getGL("Sales", distributor_code, t);
    const transaction_date = new Date();

    const journalRows = [
      {
        distributor_code, gl_id: receivableGL, reference_no: note.id, reference_type: "SALES_DEBIT_NOTE",
        debit: note.totalAmount, credit: 0, customer_id: note.customerId, customer_code: note.customer?.customer_code,
        transaction_date,
        narration: `Receivable increased — ${note.debit_note_number}`,
      },
      {
        distributor_code, gl_id: salesGL, reference_no: note.id, reference_type: "SALES_DEBIT_NOTE",
        debit: 0, credit: note.taxableValue, customer_id: note.customerId, customer_code: note.customer?.customer_code,
        transaction_date,
        narration: `Sales correction — ${note.debit_note_number}`,
      },
    ];

    const totalTax = tax.round2(Number(note.cgstAmount) + Number(note.sgstAmount) + Number(note.igstAmount));
    if (totalTax > 0) {
      const gstGL = await accounting.getGL("Output GST", distributor_code, t);
      journalRows.push({
        distributor_code, gl_id: gstGL, reference_no: note.id, reference_type: "SALES_DEBIT_NOTE",
        debit: 0, credit: totalTax, customer_id: note.customerId, customer_code: note.customer?.customer_code,
        transaction_date,
        narration: `Output GST correction — ${note.debit_note_number}`,
      });
    }

    accounting.assertBalanced(journalRows);
    for (const row of journalRows) {
      await db.JournalEntry.create(row, { transaction: t });
    }

    await note.update({ status: "POSTED", postedAt: new Date() }, { transaction: t });

    await t.commit();
    res.json({ message: "Debit note posted", debitNote: note });
  } catch (error) {
    await t.rollback();
    console.error("Debit Note Post Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error posting debit note" });
  }
};

exports.cancel = async (req, res) => {
  try {
    const note = await SalesDebitNote.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!note) return res.status(404).json({ error: "Debit note not found" });
    if (note.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT debit note can be cancelled directly" });
    }
    await note.update({ status: "CANCELLED" });
    res.json({ message: "Debit note cancelled", debitNote: note });
  } catch (error) {
    console.error("Debit Note Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling debit note" });
  }
};

exports.getAll = async (req, res) => {
  try {
    const notes = await SalesDebitNote.findAll({
      where: { distributor_id: req.user.id },
      include: [{ model: Customer, as: "customer" }],
      order: [["createdAt", "DESC"]],
    });
    res.json(notes);
  } catch (error) {
    console.error("Debit Note GetAll Error:", error.message);
    res.status(500).json({ error: "Error fetching debit notes" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const note = await SalesDebitNote.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Customer, as: "customer" }, { model: SalesInvoiceHeader, as: "invoice" }],
    });
    if (!note) return res.status(404).json({ message: "Debit note not found" });
    res.json(note);
  } catch (error) {
    console.error("Debit Note GetOne Error:", error.message);
    res.status(500).json({ error: "Error fetching debit note" });
  }
};

exports.update = async (req, res) => {
  try {
    const note = await SalesDebitNote.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!note) return res.status(404).json({ message: "Debit note not found" });
    if (note.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT debit note can be edited" });
    }
    const { reason } = req.body;
    await note.update({ reason: reason ?? note.reason });
    res.json(note);
  } catch (error) {
    console.error("Debit Note Update Error:", error.message);
    res.status(500).json({ error: "Error updating debit note" });
  }
};

exports.delete = async (req, res) => {
  try {
    const note = await SalesDebitNote.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!note) return res.status(404).json({ message: "Debit note not found" });
    if (note.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT debit note can be deleted; POSTED notes are never deleted" });
    }
    await note.destroy();
    res.json({ message: "Debit note deleted successfully" });
  } catch (error) {
    console.error("Debit Note Delete Error:", error.message);
    res.status(500).json({ error: "Error deleting debit note" });
  }
};
