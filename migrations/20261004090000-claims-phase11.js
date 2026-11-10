"use strict";

// Phase 11 — Claims. ADDITIVE ONLY (Claims, ClaimItems, ClaimStatusHistories). Idempotent and reversible.
// No FK to Distributors/Customers/Schemes/Invoices on purpose (same convention as Phase 10): those tables are shared with legacy
// flows, and ownership/consistency is validated by the service on every write.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = (n) => existing.includes(n);
    const ts = { createdAt: { type: Sequelize.DATE, allowNull: false }, updatedAt: { type: Sequelize.DATE, allowNull: false } };
    const pk = { id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false } };

    if (!has("Claims")) {
      await queryInterface.createTable("Claims", {
        ...pk,
        claim_number: { type: Sequelize.STRING(30), allowNull: false, unique: true },
        claim_type: { type: Sequelize.ENUM("SCHEME"), allowNull: false, defaultValue: "SCHEME" },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        customer_id: { type: Sequelize.INTEGER, allowNull: true },
        scheme_id: { type: Sequelize.INTEGER, allowNull: false },
        invoice_id: { type: Sequelize.INTEGER, allowNull: false },
        claim_date: { type: Sequelize.DATEONLY, allowNull: false },
        period_from: { type: Sequelize.DATEONLY, allowNull: false },
        period_to: { type: Sequelize.DATEONLY, allowNull: false },
        claim_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        description: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.ENUM("DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "NEEDS_CORRECTION", "RESUBMITTED"), allowNull: false, defaultValue: "DRAFT" },
        submitted_at: { type: Sequelize.DATE, allowNull: true },
        reviewed_at: { type: Sequelize.DATE, allowNull: true },
        decided_at: { type: Sequelize.DATE, allowNull: true },
        decided_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        decision_reason: { type: Sequelize.STRING(1000), allowNull: true },
        correction_reason: { type: Sequelize.STRING(1000), allowNull: true },
        required_information: { type: Sequelize.STRING(1000), allowNull: true },
        scheme_snapshot: { type: Sequelize.TEXT, allowNull: true },
        ...ts,
      });
      await queryInterface.addIndex("Claims", ["distributor_id", "status"], { name: "claims_distributor_status" });
      await queryInterface.addIndex("Claims", ["scheme_id"], { name: "claims_scheme" });
      await queryInterface.addIndex("Claims", ["invoice_id"], { name: "claims_invoice" });
      await queryInterface.addIndex("Claims", ["customer_id"], { name: "claims_customer" });
      await queryInterface.addIndex("Claims", ["claim_date"], { name: "claims_date" });
    }

    if (!has("ClaimItems")) {
      await queryInterface.createTable("ClaimItems", {
        ...pk,
        claim_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "Claims", key: "id" }, onDelete: "CASCADE" },
        invoice_line_id: { type: Sequelize.INTEGER, allowNull: false },
        product_id: { type: Sequelize.INTEGER, allowNull: false },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        unit_price: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        benefit_type: { type: Sequelize.STRING(20), allowNull: true },
        free_quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        eligible_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      });
      await queryInterface.addIndex("ClaimItems", ["claim_id"], { name: "claimitems_claim" });
      await queryInterface.addIndex("ClaimItems", ["invoice_line_id"], { name: "claimitems_invoice_line" });
      await queryInterface.addIndex("ClaimItems", ["product_id"], { name: "claimitems_product" });
    }

    if (!has("ClaimStatusHistories")) {
      await queryInterface.createTable("ClaimStatusHistories", {
        ...pk,
        claim_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "Claims", key: "id" }, onDelete: "CASCADE" },
        from_status: { type: Sequelize.STRING(20), allowNull: true },
        to_status: { type: Sequelize.STRING(20), allowNull: false },
        actor_type: { type: Sequelize.ENUM("ADMIN", "DISTRIBUTOR"), allowNull: false },
        actor_id: { type: Sequelize.INTEGER, allowNull: false },
        comment: { type: Sequelize.STRING(1000), allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex("ClaimStatusHistories", ["claim_id", "createdAt"], { name: "claimhistory_claim_created" });
    }
  },

  async down(queryInterface) {
    for (const t of ["ClaimStatusHistories", "ClaimItems", "Claims"]) await queryInterface.dropTable(t);
    if (queryInterface.sequelize.getDialect() === "postgres") {
      for (const e of ["Claims_claim_type", "Claims_status", "ClaimStatusHistories_actor_type"]) await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_${e}";`);
    }
  },
};
