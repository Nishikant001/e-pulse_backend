// controllers/purchasedebitnote.controller.js
//
// A Purchase Debit Note (issued BY the distributor TO the vendor) reduces
// what the distributor owes the vendor. Created automatically by a
// Purchase Return (see purchasereturn.controller.js), analogous to how a
// Sales Return generates a Sales Credit Note.
const db = require("../models");
const tax = require("../services/tax.service");
const accounting = require("../services/accounting.service");
const { PurchaseDebitNote, PurchaseInvoiceHeader, Vendor } = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}


async function generateDebitNoteNumber(distributor_code, transaction) {
  const last = await PurchaseDebitNote.findOne({
    where: { distributor_code }, order: [["createdAt", "DESC"], ["id", "DESC"]], transaction,
  });
  let next = 1;
  if (last?.debit_note_number) {
    next = (parseInt(String(last.debit_note_number).split("-").pop(), 10) || 0) + 1;
  }
  return `${distributor_code}-PDN-${String(next).padStart(4, "0")}`;
}

/**
 * Build and persist a purchase debit note. Does NOT commit/rollback —
 * caller owns the transaction (purchasereturn.controller.js when
 * generating a return-driven note).
 */
async function buildDebitNote({ distributorId, distributor_code, vendorId, invoiceId, taxableValue, cgstAmount = 0, sgstAmount = 0, igstAmount = 0, reason, sourceReturnId = null, transaction }) {
  const debit_note_number = await generateDebitNoteNumber(distributor_code, transaction);
  const totalAmount = tax.round2(Number(taxableValue) + Number(cgstAmount) + Number(sgstAmount) + Number(igstAmount));

  return PurchaseDebitNote.create({
    distributor_id: distributorId,
    distributor_code,
    debit_note_number,
    vendor_id: vendorId,
    invoiceId: invoiceId || null,
    sourceReturnId,
    reason: reason || null,
    status: "DRAFT",
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    totalAmount,
  }, { transaction });
}

exports.createFromReturn = buildDebitNote;

/**
 * Post the accounting for an already-built (DRAFT) debit note. Extracted
 * so purchasereturn.controller.js can post it in the SAME transaction as
 * the stock reversal.
 */
async function postDebitNoteAccounting(note, distributor_code, transaction) {
  if (note.status !== "DRAFT") throw badRequest(`Cannot post a debit note with status ${note.status}`);

  const payableGL = await accounting.getGL("Accounts Payable", distributor_code, transaction);
  const purchaseGL = await accounting.getGL("Purchase", distributor_code, transaction);
  const transaction_date = new Date();

  const journalRows = [
    {
      distributor_code, gl_id: payableGL, reference_no: note.id, reference_type: "PURCHASE_DEBIT_NOTE",
      debit: note.totalAmount, credit: 0, vendor_id: note.vendor_id, transaction_date,
      narration: `Payable reduced — ${note.debit_note_number}`,
    },
    {
      distributor_code, gl_id: purchaseGL, reference_no: note.id, reference_type: "PURCHASE_DEBIT_NOTE",
      debit: 0, credit: note.taxableValue, vendor_id: note.vendor_id, transaction_date,
      narration: `Purchase reversal — ${note.debit_note_number}`,
    },
  ];

  const totalTax = tax.round2(Number(note.cgstAmount) + Number(note.sgstAmount) + Number(note.igstAmount));
  if (totalTax > 0) {
    const inputGstGL = await accounting.getGL("Input GST", distributor_code, transaction);
    journalRows.push({
      distributor_code, gl_id: inputGstGL, reference_no: note.id, reference_type: "PURCHASE_DEBIT_NOTE",
      debit: 0, credit: totalTax, vendor_id: note.vendor_id, transaction_date,
      narration: `Input GST reversal — ${note.debit_note_number}`,
    });
  }

  accounting.assertBalanced(journalRows);
  for (const row of journalRows) {
    await db.JournalEntry.create(row, { transaction });
  }

  await note.update({ status: "POSTED", postedAt: new Date() }, { transaction });
  return note;
}
exports.postDebitNoteAccounting = postDebitNoteAccounting;

exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const note = await PurchaseDebitNote.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!note) throw notFound("Debit note not found");

    await postDebitNoteAccounting(note, distributor_code, t);

    await t.commit();
    res.json({ message: "Debit note posted", debitNote: note });
  } catch (error) {
    await t.rollback();
    console.error("Purchase Debit Note Post Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error posting debit note" });
  }
};

exports.cancel = async (req, res) => {
  try {
    const note = await PurchaseDebitNote.findOne({ where: { id: req.params.id, distributor_id: req.user.id } });
    if (!note) return res.status(404).json({ error: "Debit note not found" });
    if (note.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT debit note can be cancelled directly" });
    }
    await note.update({ status: "CANCELLED" });
    res.json({ message: "Debit note cancelled", debitNote: note });
  } catch (error) {
    console.error("Purchase Debit Note Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling debit note" });
  }
};

exports.getAll = async (req, res) => {
  try {
    const notes = await PurchaseDebitNote.findAll({
      where: { distributor_id: req.user.id },
      include: [{ model: Vendor, as: "vendor" }],
      order: [["createdAt", "DESC"]],
    });
    res.json(notes);
  } catch (error) {
    console.error("Purchase Debit Note GetAll Error:", error.message);
    res.status(500).json({ error: "Error fetching debit notes" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const note = await PurchaseDebitNote.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Vendor, as: "vendor" }, { model: PurchaseInvoiceHeader, as: "invoice" }],
    });
    if (!note) return res.status(404).json({ message: "Debit note not found" });
    res.json(note);
  } catch (error) {
    console.error("Purchase Debit Note GetOne Error:", error.message);
    res.status(500).json({ error: "Error fetching debit note" });
  }
};
