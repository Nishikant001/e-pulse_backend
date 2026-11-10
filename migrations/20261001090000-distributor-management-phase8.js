"use strict";

// Phase 8 — Distributor Management. ADDITIVE ONLY (no table created, nothing dropped, no data rewritten).
//
// The Distributor table already carries identity (distributor_code, name, email), tax identity (tax_no = GSTIN, pan),
// the registered address (street1-4, city, region = state, postal_code, country) and phone_number — all reused as-is.
// Only the fields that genuinely did not exist are added:
//   contact_person, territory, credit_limit, payment_terms, status (+ status_reason / status_changed_at).
// Every existing distributor becomes status = 'active' (the column default), so live behaviour does not change.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Distributors");

    if (!table.contact_person) await queryInterface.addColumn("Distributors", "contact_person", { type: Sequelize.STRING(150), allowNull: true });
    if (!table.territory) await queryInterface.addColumn("Distributors", "territory", { type: Sequelize.STRING(100), allowNull: true });
    if (!table.credit_limit) await queryInterface.addColumn("Distributors", "credit_limit", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    if (!table.payment_terms) await queryInterface.addColumn("Distributors", "payment_terms", { type: Sequelize.STRING(50), allowNull: true });
    if (!table.status) {
      await queryInterface.addColumn("Distributors", "status", {
        type: Sequelize.ENUM("active", "inactive", "pending"),
        allowNull: false,
        defaultValue: "active",
      });
    }
    if (!table.status_reason) await queryInterface.addColumn("Distributors", "status_reason", { type: Sequelize.STRING(255), allowNull: true });
    if (!table.status_changed_at) await queryInterface.addColumn("Distributors", "status_changed_at", { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("Distributors");
    for (const col of ["status_changed_at", "status_reason", "status", "payment_terms", "credit_limit", "territory", "contact_person"]) {
      if (table[col]) await queryInterface.removeColumn("Distributors", col);
    }
    if (queryInterface.sequelize.getDialect() === "postgres") {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Distributors_status";');
    }
  },
};
