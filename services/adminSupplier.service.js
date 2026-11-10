// services/adminSupplier.service.js
//
// Business rule (decided with the product owner): a distributor's purchase order has NO vendor — it is supplied by the
// distributor's administrator (the company). A purchase invoice still needs a supplier row for its tax place-of-supply and
// for the Accounts Payable journal, so each distributor gets ONE auto-created supplier row that represents the company.
//
// Place of supply (CGST+SGST vs IGST): tax.computeHsnBasedTax compares vendor.region with distributor.region. The admin account has no
// state of its own, so the supplier region defaults to the distributor's region (intra-state → CGST + SGST). Set
// ADMIN_SUPPLIER_REGION in .env to the company's state to change this (a different state → IGST).
const db = require("../models");

const SUPPLIER_NAME = "Company (Admin supply)";

async function ensureAdminSupplier(distributor, transaction) {
  const existing = await db.Vendor.findOne({ where: { distributor_id: distributor.id, name: SUPPLIER_NAME }, transaction });
  if (existing) return existing;
  return db.Vendor.create(
    {
      name: SUPPLIER_NAME,
      vendor_group: "Company",
      country: "India",
      region: process.env.ADMIN_SUPPLIER_REGION || distributor.region || null,
      distributor_id: distributor.id,
    },
    { transaction }
  );
}

module.exports = { ensureAdminSupplier, SUPPLIER_NAME };
