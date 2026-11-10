"use strict";

// Phase 9 — Retailer Management. ADDITIVE ONLY (no table created, nothing dropped, no data rewritten).
//
// A retailer IS a Customer (Customer.distributor_id already carries ownership), so no Retailer table is created.
// Already present and reused as-is: name, taxNumber (GSTIN), city, region (state), street1-4, pincode/postalCode,
// alternatePhone, customer_code, distributor_id, customer_group_id, plus Address rows (ship_to_party = shipping address).
// Only genuinely missing fields are added:
//   contact_person, phone_number, email, pan, territory, status (+ status_reason / status_changed_at).
// Every existing customer becomes status = 'active' (the column default), so live behaviour does not change.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Customers");

    if (!table.contact_person) await queryInterface.addColumn("Customers", "contact_person", { type: Sequelize.STRING(150), allowNull: true });
    if (!table.phone_number) await queryInterface.addColumn("Customers", "phone_number", { type: Sequelize.STRING(20), allowNull: true });
    if (!table.email) await queryInterface.addColumn("Customers", "email", { type: Sequelize.STRING(255), allowNull: true });
    if (!table.pan) await queryInterface.addColumn("Customers", "pan", { type: Sequelize.STRING(10), allowNull: true });
    if (!table.territory) await queryInterface.addColumn("Customers", "territory", { type: Sequelize.STRING(100), allowNull: true });
    if (!table.status) {
      await queryInterface.addColumn("Customers", "status", {
        type: Sequelize.ENUM("active", "inactive", "pending"),
        allowNull: false,
        defaultValue: "active",
      });
    }
    if (!table.status_reason) await queryInterface.addColumn("Customers", "status_reason", { type: Sequelize.STRING(255), allowNull: true });
    if (!table.status_changed_at) await queryInterface.addColumn("Customers", "status_changed_at", { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("Customers");
    for (const col of ["status_changed_at", "status_reason", "status", "territory", "pan", "email", "phone_number", "contact_person"]) {
      if (table[col]) await queryInterface.removeColumn("Customers", col);
    }
    if (queryInterface.sequelize.getDialect() === "postgres") {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Customers_status";');
    }
  },
};
