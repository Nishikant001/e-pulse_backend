// services/tax.service.js
//
// Centralized GST computation. Every phase (Sales Order, Sales Invoice,
// and eventually Purchase) should compute tax through here rather than
// re-implementing the math inline, so there is exactly one place that
// defines what "tax" means in this system.
//
// SCOPE NOTE: this is intentionally a simple, defensible GST split, not a
// full GST engine (place-of-supply rules, reverse charge, exemptions,
// composition scheme, etc. are out of scope — see Phase 3 report). The
// rule implemented here is the common default for a single-state
// distributor: intra-state sales split the product's GST rate evenly into
// CGST + SGST; inter-state sales charge the full rate as IGST.
//
// Rates come from Product.cgst/sgst/igst/gst (see product.model.js). If a
// product has no rate configured, tax is computed as zero rather than
// throwing, since GST configuration is a data-completeness concern, not a
// transaction-blocking one — this is called out explicitly wherever it's
// used so it isn't silently wrong.

function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Compute the GST breakdown for a single line's taxable value.
 *
 * @param {number} taxableValue - value after discount, before tax
 * @param {object} product - a Product instance/plain object with
 *   cgst/sgst/igst/gst fields (any may be null/undefined)
 * @param {boolean} interState - true for inter-state (IGST) sales
 */
function computeLineTax(taxableValue, product, interState = false) {
  const value = n(taxableValue);

  if (interState) {
    // Prefer an explicit igst rate; otherwise fall back to the combined
    // `gst` rate (cgst+sgst equivalent) as the total inter-state rate.
    const igstRate = product?.igst != null ? n(product.igst) : n(product?.gst);
    const igstAmount = round2((value * igstRate) / 100);
    return { cgstAmount: 0, sgstAmount: 0, igstAmount, totalTax: igstAmount, cgstRate: 0, sgstRate: 0, igstRate };
  }

  let cgstRate = product?.cgst != null ? n(product.cgst) : null;
  let sgstRate = product?.sgst != null ? n(product.sgst) : null;

  if (cgstRate === null || sgstRate === null) {
    // No explicit split configured — derive an even split from the
    // combined `gst` rate if present.
    const combined = n(product?.gst) / 2;
    cgstRate = cgstRate ?? combined;
    sgstRate = sgstRate ?? combined;
  }

  const cgstAmount = round2((value * cgstRate) / 100);
  const sgstAmount = round2((value * sgstRate) / 100);

  return {
    cgstAmount,
    sgstAmount,
    igstAmount: 0,
    totalTax: round2(cgstAmount + sgstAmount),
    cgstRate,
    sgstRate,
    igstRate: 0,
  };
}

function round2(v) {
  return Math.round(n(v) * 100) / 100;
}

/**
 * Purchase-side GST split, based on HSN.gst_rate and whether the vendor
 * and distributor are in the same state (intra-state -> CGST+SGST split;
 * inter-state -> IGST). This mirrors the logic that already existed
 * inline in purchaseorder.controller.js — extracted here so
 * purchaseinvoice.controller.js can reuse the exact same computation
 * instead of re-implementing it, per the "do not duplicate tax logic"
 * requirement. This is intentionally a different, pre-existing
 * computation path from computeLineTax() (which is product.cgst/sgst
 * based, used on the Sales side) — unifying the two would be a GST-engine
 * redesign, which is explicitly out of scope for this phase.
 */
function computeHsnBasedTax(taxableValue, gstRate, vendor, distributor) {
  const value = n(taxableValue);
  const rate = n(gstRate);
  const lineTax = round2((value * rate) / 100);

  // NOTE: this previously compared `vendor.state`/`distributor.state`,
  // fields that don't exist on either model — so the intra-state branch
  // could never trigger. Both models actually already have a `region`
  // field (populated at vendor/distributor creation) that serves this
  // purpose; fixed to use the real field instead of adding a redundant
  // new column.
  const sameState = vendor?.region && distributor?.region && vendor.region === distributor.region;

  if (sameState) {
    const half = round2(lineTax / 2);
    return { cgstAmount: half, sgstAmount: half, igstAmount: 0, totalTax: round2(half * 2) };
  }
  return { cgstAmount: 0, sgstAmount: 0, igstAmount: lineTax, totalTax: lineTax };
}

/**
 * Phase 7 (Tax Master) — the intra-state / inter-state GST split for a single HSN/tax-category rate, with no
 * taxable value involved. Reuses the SAME even-split rule as computeLineTax() (intra-state = rate/2 + rate/2 as
 * CGST/SGST; inter-state = the full rate as IGST) so the Tax Master screen never re-implements this decision.
 */
function splitGstRate(gstRate) {
  const rate = n(gstRate);
  const half = round2(rate / 2);
  return { gstRate: rate, cgstRate: half, sgstRate: half, igstRate: rate };
}

module.exports = { computeLineTax, computeHsnBasedTax, splitGstRate, round2 };
