"use strict";

// Phase 7 — Product / Batch / Pricing / Tax Masters. ADDITIVE ONLY.
//
// Batch, PricingMaster and HSNGroup already carry every field this phase needs (mrp, purchase_price, status on
// Batch; base_price/discount_percent/valid_from/valid_to on PricingMaster; hsn_code/gst_rate on HSNGroup — see
// services/pricing.service.js and services/tax.service.js). Product is the only model missing genuinely new
// master-data fields: generic name, brand, dosage form, strength, pack size, MRP, sale price and an
// active/inactive status. `material_code` (already unique, already auto-generated) continues to serve as both
// the internal product code and the SKU — a separate `sku` column would just duplicate it.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Products");

    if (!table.generic_name) {
      await queryInterface.addColumn("Products", "generic_name", { type: Sequelize.STRING(150), allowNull: true });
    }
    if (!table.brand) {
      await queryInterface.addColumn("Products", "brand", { type: Sequelize.STRING(150), allowNull: true });
    }
    if (!table.dosage_form) {
      await queryInterface.addColumn("Products", "dosage_form", { type: Sequelize.STRING(50), allowNull: true });
    }
    if (!table.strength) {
      await queryInterface.addColumn("Products", "strength", { type: Sequelize.STRING(50), allowNull: true });
    }
    if (!table.pack_size) {
      await queryInterface.addColumn("Products", "pack_size", { type: Sequelize.STRING(50), allowNull: true });
    }
    if (!table.mrp) {
      await queryInterface.addColumn("Products", "mrp", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    }
    if (!table.sale_price) {
      await queryInterface.addColumn("Products", "sale_price", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    }
    if (!table.status) {
      await queryInterface.addColumn("Products", "status", {
        type: Sequelize.ENUM("active", "inactive"),
        allowNull: false,
        defaultValue: "active",
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("Products");
    if (table.status) await queryInterface.removeColumn("Products", "status");
    if (table.sale_price) await queryInterface.removeColumn("Products", "sale_price");
    if (table.mrp) await queryInterface.removeColumn("Products", "mrp");
    if (table.pack_size) await queryInterface.removeColumn("Products", "pack_size");
    if (table.strength) await queryInterface.removeColumn("Products", "strength");
    if (table.dosage_form) await queryInterface.removeColumn("Products", "dosage_form");
    if (table.brand) await queryInterface.removeColumn("Products", "brand");
    if (table.generic_name) await queryInterface.removeColumn("Products", "generic_name");
    // Dialect-specific ENUM type cleanup (Postgres); no-op on MySQL/SQLite.
    const qi = queryInterface;
    if (qi.sequelize.getDialect() === "postgres") {
      await qi.sequelize.query('DROP TYPE IF EXISTS "enum_Products_status";');
    }
  },
};
