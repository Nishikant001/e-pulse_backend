"use strict";

// Phase 12 — Accounts & Financial Management. ADDITIVE ONLY. Idempotent and reversible.
//   • Payments, PaymentAllocations (new — no payment table existed)
//   • Customers.credit_limit (retailers had no credit-limit field; Distributors.credit_limit already exists and is reused)
//   • Claims.settlement_reference (unique) / settled_at / settled_by_admin_id — the link from a claim to its CLAIM_SETTLEMENT journal entries
// No new invoice / credit-note / journal / ledger table: those are reused. No FK to shared legacy tables (same convention as Phases 10–11).
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = (n) => tables.includes(n);
    const cols = async (t) => Object.keys(await queryInterface.describeTable(t));
    const idx = async (t) => (await queryInterface.showIndex(t)).map((i) => i.name);
    const ts = { createdAt: { type: Sequelize.DATE, allowNull: false }, updatedAt: { type: Sequelize.DATE, allowNull: false } };

    if (!has("Payments")) {
      await queryInterface.createTable("Payments", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        payment_number: { type: Sequelize.STRING(30), allowNull: false, unique: true },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        customer_id: { type: Sequelize.INTEGER, allowNull: false },
        payment_date: { type: Sequelize.DATEONLY, allowNull: false },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        mode: { type: Sequelize.ENUM("CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "OTHER"), allowNull: false },
        reference_no: { type: Sequelize.STRING(60), allowNull: true },
        remarks: { type: Sequelize.STRING(500), allowNull: true },
        status: { type: Sequelize.ENUM("POSTED"), allowNull: false, defaultValue: "POSTED" },
        created_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        ...ts,
      });
      await queryInterface.addIndex("Payments", ["distributor_id", "reference_no"], { unique: true, name: "uniq_payment_reference_per_distributor" });
      await queryInterface.addIndex("Payments", ["distributor_id", "payment_date"], { name: "payments_distributor_date" });
      await queryInterface.addIndex("Payments", ["customer_id"], { name: "payments_customer" });
    }

    if (!has("PaymentAllocations")) {
      await queryInterface.createTable("PaymentAllocations", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        payment_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "Payments", key: "id" }, onDelete: "CASCADE" },
        invoice_id: { type: Sequelize.INTEGER, allowNull: false },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        ...ts,
      });
      await queryInterface.addIndex("PaymentAllocations", ["payment_id", "invoice_id"], { unique: true, name: "uniq_allocation_payment_invoice" });
      await queryInterface.addIndex("PaymentAllocations", ["invoice_id"], { name: "paymentallocations_invoice" });
    }

    if (has("Customers") && !(await cols("Customers")).includes("credit_limit")) {
      await queryInterface.addColumn("Customers", "credit_limit", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    }

    if (has("Claims")) {
      const c = await cols("Claims");
      if (!c.includes("settlement_reference")) await queryInterface.addColumn("Claims", "settlement_reference", { type: Sequelize.STRING(40), allowNull: true });
      if (!c.includes("settled_at")) await queryInterface.addColumn("Claims", "settled_at", { type: Sequelize.DATE, allowNull: true });
      if (!c.includes("settled_by_admin_id")) await queryInterface.addColumn("Claims", "settled_by_admin_id", { type: Sequelize.INTEGER, allowNull: true });
      if (!(await idx("Claims")).includes("uniq_claims_settlement_reference")) {
        await queryInterface.addIndex("Claims", ["settlement_reference"], { unique: true, name: "uniq_claims_settlement_reference" });
      }
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await queryInterface.describeTable(t));

    if (tables.includes("Claims")) {
      const names = (await queryInterface.showIndex("Claims")).map((i) => i.name);
      if (names.includes("uniq_claims_settlement_reference")) await queryInterface.removeIndex("Claims", "uniq_claims_settlement_reference");
      const c = await cols("Claims");
      for (const col of ["settled_by_admin_id", "settled_at", "settlement_reference"]) if (c.includes(col)) await queryInterface.removeColumn("Claims", col);
    }
    if (tables.includes("Customers") && (await cols("Customers")).includes("credit_limit")) await queryInterface.removeColumn("Customers", "credit_limit");
    if (tables.includes("PaymentAllocations")) await queryInterface.dropTable("PaymentAllocations");
    if (tables.includes("Payments")) {
      await queryInterface.dropTable("Payments");
      if (queryInterface.sequelize.getDialect() === "postgres") {
        await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Payments_mode"; DROP TYPE IF EXISTS "enum_Payments_status";');
      }
    }
  },
};
