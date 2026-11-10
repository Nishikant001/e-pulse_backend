// services/pricing.service.js
//
// Centralized, authoritative price resolution. The frontend may display a
// price, but the backend must never trust a client-supplied rate for
// financial calculations — it always re-resolves from PricingMaster,
// which is keyed per (product, customer group, distributor) with a
// validity window.
//
// NOTE: this function previously queried PricingMaster by `material_code`
// and `customer_group` and read a `tax_percent` field — none of those
// columns exist on the PricingMaster model (real columns are `productId`,
// `customer_group_id`, `base_price`, `discount_percent`). Since nothing
// else in the codebase called this function, it was dead/broken code;
// fixed in place here rather than duplicated, per the Phase 3 requirement
// to reuse the existing centralized pricing service.
const db = require("../models");
const { Op } = require("sequelize");

class PricingNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingNotConfiguredError";
    this.statusCode = 400;
  }
}

/**
 * Resolve the authoritative discounted unit price for a product sold to a
 * given customer group, scoped to the distributor, as of `asOf` (defaults
 * to now). Tax is NOT included here — see services/tax.service.js.
 */
exports.getFinalPrice = async ({ productId, customer_group_id, distributor_id, asOf = new Date(), transaction }) => {
  const pricing = await db.PricingMaster.findOne({
    where: {
      productId,
      customer_group_id,
      distributor_id,
      valid_from: { [Op.lte]: asOf },
      [Op.or]: [{ valid_to: null }, { valid_to: { [Op.gte]: asOf } }],
    },
    order: [["valid_from", "DESC"]],
    transaction,
  });

  if (!pricing) {
    throw new PricingNotConfiguredError(
      `No pricing configured for product ${productId} / customer group ${customer_group_id}`
    );
  }

  const basePrice = Number(pricing.base_price);
  const discountPercent = Number(pricing.discount_percent) || 0;
  const discountAmount = Math.round(((basePrice * discountPercent) / 100) * 100) / 100;
  const unitPrice = Math.round((basePrice - discountAmount) * 100) / 100;

  return { basePrice, discountPercent, discountAmount, unitPrice, pricingMasterId: pricing.id };
};

/**
 * Convenience wrapper: resolve price for a customer by ID (looks up their
 * customer_group_id) instead of requiring the caller to know it already.
 */
exports.getFinalPriceForCustomer = async ({ productId, customerId, distributorId, asOf, transaction }) => {
  const customer = await db.Customer.findOne({
    where: { id: customerId, distributor_id: distributorId },
    transaction,
  });
  if (!customer) {
    throw new PricingNotConfiguredError("Customer not found for this distributor");
  }
  return exports.getFinalPrice({
    productId,
    customer_group_id: customer.customer_group_id,
    distributor_id: distributorId,
    asOf,
    transaction,
  });
};

exports.PricingNotConfiguredError = PricingNotConfiguredError;
