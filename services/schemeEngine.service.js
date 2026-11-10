// services/schemeEngine.service.js — Phase 10 Scheme Engine (evaluation). The ONLY place scheme benefits are calculated.
// Pure read: nothing is written, no stock is moved, no price/tax/order/invoice is changed. The result is a structured object
// future Sales Order / Invoice / Claims code can consume (and persist as its own snapshot).
//
// Rules (see docs/PHARMA_DMS_SCHEME_ENGINE.md):
//  • A scheme is considered only when stored status = active AND valid_from <= asOf <= valid_to (valid_to may be open).
//  • It must match the line's product (explicit product OR product category), the distributor and — if the scheme is
//    retailer-specific — the retailer. Distributor identity always comes from the caller's session, never from a request body.
//  • Types: QUANTITY_FREE (buy X get Y free, repeating), PERCENT_DISCOUNT, FIXED_DISCOUNT (per line).
//  • NO STACKING: per line, at most one scheme is applied — the eligible scheme with the lowest `priority` number.
//    If two or more eligible schemes share that lowest priority the requirements define no winner, so NONE is applied and the
//    line is flagged `conflict: true` with the tied schemes listed (Admin must give them distinct priorities).
const db = require("../models");
const { effectiveStatus, ruleSummary } = require("./schemes.service");
const { round2 } = require("./tax.service");

const isoDay = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const n = (v) => (v === null || v === undefined ? null : Number(v));

class EngineError extends Error {
  constructor(message, statusCode = 400, code = "VALIDATION_FAILED") {
    super(message);
    this.name = "SchemeEngineError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function loadActiveSchemes(asOf, transaction) {
  const { Op } = db.Sequelize;
  const schemes = await db.Scheme.findAll({
    where: { status: "active", valid_from: { [Op.lte]: asOf }, [Op.or]: [{ valid_to: null }, { valid_to: { [Op.gte]: asOf } }] },
    transaction,
  });
  if (!schemes.length) return [];
  const ids = schemes.map((s) => s.id);
  const [pl, dl, rl] = await Promise.all([
    db.SchemeProduct.findAll({ where: { scheme_id: { [Op.in]: ids } }, transaction }),
    db.SchemeDistributor.findAll({ where: { scheme_id: { [Op.in]: ids } }, transaction }),
    db.SchemeRetailer.findAll({ where: { scheme_id: { [Op.in]: ids } }, transaction }),
  ]);
  const group = (rows, key) => rows.reduce((m, r) => ((m[r.scheme_id] = m[r.scheme_id] || new Set()).add(Number(r[key])), m), {});
  const P = group(pl, "product_id");
  const D = group(dl, "distributor_id");
  const R = group(rl, "customer_id");
  return schemes.map((s) => ({ s, products: P[s.id] || new Set(), distributors: D[s.id] || new Set(), retailers: R[s.id] || new Set() }));
}

// Why a scheme does / does not apply to this line (structural checks first, then quantity).
function match(c, { product, distributorId, customerId, quantity }) {
  const { s } = c;
  if (s.distributor_scope === "SPECIFIC" && !c.distributors.has(Number(distributorId))) return "DISTRIBUTOR_NOT_APPLICABLE";
  if (s.retailer_scope === "SPECIFIC" && (!customerId || !c.retailers.has(Number(customerId)))) return "RETAILER_NOT_APPLICABLE";
  if (s.product_scope === "PRODUCTS" ? !c.products.has(Number(product.id)) : !product.category || s.category !== product.category) return "PRODUCT_NOT_APPLICABLE";
  if (s.scheme_type === "QUANTITY_FREE") {
    if (quantity < s.buy_quantity) return "BELOW_MINIMUM_QUANTITY";
  } else if (quantity < (s.min_quantity || 1)) return "BELOW_MINIMUM_QUANTITY";
  return null;
}

function benefit(s, quantity, unitPrice) {
  const considered = s.max_quantity ? Math.min(quantity, s.max_quantity) : quantity; // quantity beyond max_quantity earns nothing extra
  const base = { schemeId: Number(s.id), schemeCode: s.scheme_code, schemeName: s.name, schemeType: s.scheme_type, priority: s.priority, ruleSummary: ruleSummary(s) };
  if (s.scheme_type === "QUANTITY_FREE") {
    const times = Math.floor(considered / s.buy_quantity);
    const free = times * s.free_quantity;
    // purchased (paid) and free are kept apart on purpose — free goods are never silently added to the paid quantity.
    return { ...base, benefitType: "FREE_QUANTITY", buyQuantity: s.buy_quantity, freeQuantityPerBuy: s.free_quantity, timesApplied: times, purchasedQuantity: quantity, freeQuantity: free, totalQuantity: quantity + free };
  }
  const gross = unitPrice === null ? null : round2(unitPrice * considered);
  let amount = null;
  if (s.scheme_type === "PERCENT_DISCOUNT") {
    if (gross !== null) amount = round2((gross * Number(s.discount_percent)) / 100);
  } else if (gross !== null) amount = Math.min(Number(s.discount_amount), gross);
  if (amount !== null && s.max_discount !== null && s.max_discount !== undefined) amount = Math.min(amount, Number(s.max_discount));
  return {
    ...base,
    benefitType: s.scheme_type === "PERCENT_DISCOUNT" ? "PERCENT_DISCOUNT" : "FIXED_DISCOUNT",
    discountPercent: n(s.discount_percent), fixedAmount: n(s.discount_amount), maxDiscount: n(s.max_discount),
    discountAmount: amount === null ? null : round2(amount), // null when no unit price was supplied
    grossValue: gross,
  };
}

/**
 * @param {object} p { distributorId (from the SESSION), customerId?, lines: [{productId, quantity, unitPrice?}], asOf? ('YYYY-MM-DD') }
 */
async function evaluate({ distributorId, customerId = null, lines, asOf, transaction } = {}) {
  const dId = Number(distributorId);
  if (!Number.isInteger(dId) || dId <= 0) throw new EngineError("distributorId is required");
  if (!Array.isArray(lines) || lines.length === 0) throw new EngineError("At least one line is required");
  if (lines.length > 100) throw new EngineError("At most 100 lines can be evaluated at once");
  const day = asOf ? String(asOf).slice(0, 10) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) throw new EngineError("asOf must be a valid date (YYYY-MM-DD)");

  const distributor = await db.Distributor.findByPk(dId, { attributes: ["id"], transaction });
  if (!distributor) throw new EngineError("Distributor not found", 404, "NOT_FOUND");
  let retailerId = null;
  if (customerId !== null && customerId !== undefined && customerId !== "") {
    const c = await db.Customer.findOne({ where: { id: Number(customerId), distributor_id: dId }, attributes: ["id"], transaction });
    if (!c) throw new EngineError("Retailer not found for this distributor", 400, "RETAILER_NOT_FOUND");
    retailerId = Number(c.id);
  }

  const candidates = await loadActiveSchemes(day, transaction);
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const l = lines[index] || {};
    const quantity = Number(l.quantity);
    const out = { index, productId: Number(l.productId), quantity, eligibleSchemes: [], applied: null, conflict: false, conflictSchemes: [], considered: [], errors: [] };
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) out.errors.push({ code: "INVALID_QUANTITY", message: "Quantity must be a positive whole number" });
    const unitPrice = l.unitPrice === undefined || l.unitPrice === null || l.unitPrice === "" ? null : Number(l.unitPrice);
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) out.errors.push({ code: "INVALID_PRICE", message: "unitPrice must be zero or more" });
    const product = Number.isInteger(out.productId) && out.productId > 0
      ? await db.Product.findOne({ where: { id: out.productId, distributor_id: dId }, attributes: ["id", "category", "status"], transaction })
      : null;
    if (!product) out.errors.push({ code: "PRODUCT_NOT_FOUND", message: "Product not found for this distributor" });
    if (out.errors.length) { results.push(out); continue; }

    const ctx = { product, distributorId: dId, customerId: retailerId, quantity };
    const eligible = [];
    for (const c of candidates) {
      const reason = match(c, ctx);
      // Only schemes that structurally target this product are reported as "considered" (keeps the payload small and
      // never reveals unrelated schemes); quantity misses are shown so the user can see why a scheme did not fire.
      if (reason === null) {
        const b = benefit(c.s, quantity, unitPrice);
        eligible.push(b);
        out.considered.push({ schemeId: b.schemeId, schemeCode: b.schemeCode, eligible: true, reason: null });
      } else if (reason === "BELOW_MINIMUM_QUANTITY") {
        out.considered.push({ schemeId: Number(c.s.id), schemeCode: c.s.scheme_code, eligible: false, reason });
      }
    }
    eligible.sort((a, b) => a.priority - b.priority || a.schemeId - b.schemeId);
    out.eligibleSchemes = eligible;
    if (eligible.length) {
      const top = eligible.filter((e) => e.priority === eligible[0].priority);
      if (top.length === 1) out.applied = { eligible: true, ...top[0] };
      else { out.conflict = true; out.conflictSchemes = top.map((t) => ({ schemeId: t.schemeId, schemeCode: t.schemeCode, priority: t.priority })); }
    }
    results.push(out);
  }
  return { asOf: day, distributorId: dId, retailerId, stacking: false, lines: results };
}

/** Read-only list of schemes usable by ONE distributor (its own products / retailers only) — for the Distributor portal. */
async function listApplicableForDistributor(distributorId, { asOf } = {}) {
  const dId = Number(distributorId);
  const day = asOf || today();
  const candidates = await loadActiveSchemes(day);
  const mine = await db.Product.findAll({ where: { distributor_id: dId }, attributes: ["id", "name", "material_code", "category"] });
  const myIds = new Set(mine.map((p) => Number(p.id)));
  const myCats = new Set(mine.map((p) => p.category).filter(Boolean));
  const out = [];
  for (const c of candidates) {
    const { s } = c;
    if (s.distributor_scope === "SPECIFIC" && !c.distributors.has(dId)) continue;
    const products = s.product_scope === "CATEGORY" ? (myCats.has(s.category) ? mine.filter((p) => p.category === s.category) : []) : mine.filter((p) => c.products.has(Number(p.id)));
    if (!products.length) continue;
    if (s.retailer_scope === "SPECIFIC") {
      const rs = await db.Customer.count({ where: { distributor_id: dId, id: { [db.Sequelize.Op.in]: [...c.retailers] } } });
      if (!rs) continue;
    }
    out.push({
      id: Number(s.id), code: s.scheme_code, name: s.name, type: s.scheme_type, ruleSummary: ruleSummary(s), priority: s.priority,
      validFrom: isoDay(s.valid_from), validTo: isoDay(s.valid_to), effectiveStatus: effectiveStatus(s, day), retailerSpecific: s.retailer_scope === "SPECIFIC",
      products: products.slice(0, 50).map((p) => ({ id: Number(p.id), name: p.name, code: p.material_code })),
    });
  }
  return out.sort((a, b) => a.priority - b.priority || a.id - b.id);
}

module.exports = { evaluate, listApplicableForDistributor, EngineError };
