// services/salesLineCalc.service.js
//
// Line/total arithmetic for Sales documents, on top of the EXISTING tax.service (GST split) and the price resolved by
// the EXISTING pricing.service. The arithmetic mirrors salesOrder.controller.js `buildLine` exactly
// (gross → percentage discount → taxable → GST), so previews and detail views show the same numbers the order will store.
// The frontend only displays these values; it never calculates money.
const tax = require("./tax.service");

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * @param {object} p { unitPrice, quantity, discountPercent, product, interState }
 * product: any object with gst/cgst/sgst/igst (Product row or plain object)
 */
function computeLineAmounts({ unitPrice, quantity, discountPercent = 0, product, interState = false }) {
  const price = n(unitPrice);
  const qty = n(quantity);
  const gross = price * qty; // same as buildLine: unrounded, then discount/taxable are rounded
  const discountAmount = tax.round2((gross * n(discountPercent)) / 100);
  const taxable = tax.round2(gross - discountAmount);
  const t = tax.computeLineTax(taxable, product, interState);
  return {
    gross: tax.round2(gross),
    discountAmount,
    taxable,
    cgst: t.cgstAmount,
    sgst: t.sgstAmount,
    igst: t.igstAmount,
    tax: t.totalTax,
    cgstRate: t.cgstRate,
    sgstRate: t.sgstRate,
    igstRate: t.igstRate,
    net: tax.round2(taxable + t.totalTax),
  };
}

// Document totals from computed lines. roundOff mirrors what the existing documents store (the ERP does not round today:
// invoice.roundOff is never set), so it is 0 unless a stored value is supplied.
function computeTotals(lines, { roundOff = 0 } = {}) {
  const sum = (k) => tax.round2(lines.reduce((a, l) => a + n(l[k]), 0));
  const subtotal = sum("gross");
  const discount = sum("discountAmount");
  const taxable = sum("taxable");
  const cgst = sum("cgst");
  const sgst = sum("sgst");
  const igst = sum("igst");
  const totalTax = tax.round2(cgst + sgst + igst);
  const ro = tax.round2(roundOff);
  return { subtotal, discount, taxable, cgst, sgst, igst, totalTax, roundOff: ro, grandTotal: tax.round2(taxable + totalTax + ro) };
}

module.exports = { computeLineAmounts, computeTotals };
