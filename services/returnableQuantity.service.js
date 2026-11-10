// services/returnableQuantity.service.js
//
// A single invoice line's quantity can be consumed by TWO independent
// mechanisms: a standalone Credit Note (e.g. a price correction with no
// physical goods movement) and a Sales Return (physical goods back +
// StockLedger IN, which itself generates a linked Credit Note). Both draw
// from the same "creditable quantity" pool, so this is the one place that
// computes it — neither controller is allowed to recompute it
// independently, or the two could jointly over-credit the same line.
//
// DRAFT documents already reserve quantity against the pool (not just
// POSTED ones) — otherwise two concurrent DRAFT credit notes could each
// be created for the full remaining quantity and both later posted,
// over-crediting the customer. Only CANCELLED documents free the
// quantity back up.
const db = require("../models");
const { Op } = require("sequelize");

async function getSalesInvoiceLineConsumed(invoiceLineId, transaction) {
  const [standaloneCreditNoteConsumed, returnConsumed] = await Promise.all([
    // Only STANDALONE credit notes count here — a credit note generated
    // BY a return (sourceReturnId set) covers the exact same quantity as
    // its parent SalesReturnLine, so counting both would double-count
    // the same physical/financial event.
    db.SalesCreditNoteLine.sum("quantity", {
      where: { invoiceLineId },
      include: [{
        model: db.SalesCreditNote, as: "creditNote",
        where: { status: { [Op.ne]: "CANCELLED" }, sourceReturnId: null }, attributes: [],
      }],
      transaction,
    }),
    db.SalesReturnLine.sum("quantity", {
      where: { invoiceLineId },
      include: [{
        model: db.SalesReturn, as: "return",
        where: { status: { [Op.ne]: "CANCELLED" } }, attributes: [],
      }],
      transaction,
    }),
  ]);
  return (standaloneCreditNoteConsumed || 0) + (returnConsumed || 0);
}

async function getPurchaseInvoiceLineConsumed(invoiceLineId, transaction) {
  const returnConsumed = await db.PurchaseReturnLine.sum("quantity", {
    where: { invoiceLineId },
    include: [{
      model: db.PurchaseReturn, as: "return",
      where: { status: { [Op.ne]: "CANCELLED" } }, attributes: [],
    }],
    transaction,
  });
  return returnConsumed || 0;
}

module.exports = { getSalesInvoiceLineConsumed, getPurchaseInvoiceLineConsumed };
