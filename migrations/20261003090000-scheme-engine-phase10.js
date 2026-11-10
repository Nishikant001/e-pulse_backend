"use strict";

// Phase 10 — Scheme Engine. ADDITIVE ONLY: four new tables, no existing table is altered, nothing is rewritten.
// Idempotent (skips tables that exist) and reversible (down drops the link tables first, then Schemes).
// Link tables carry no FK to Products/Distributors/Customers on purpose: those tables are shared by the legacy flows and a
// scheme reference must never block their maintenance; integrity is validated by the service on every write instead.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = (n) => existing.includes(n);

    if (!has("Schemes")) {
      await queryInterface.createTable("Schemes", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        scheme_code: { type: Sequelize.STRING(30), allowNull: false, unique: true },
        name: { type: Sequelize.STRING(150), allowNull: false },
        description: { type: Sequelize.STRING(500), allowNull: true },
        scheme_type: { type: Sequelize.ENUM("QUANTITY_FREE", "PERCENT_DISCOUNT", "FIXED_DISCOUNT"), allowNull: false },
        product_scope: { type: Sequelize.ENUM("PRODUCTS", "CATEGORY"), allowNull: false, defaultValue: "PRODUCTS" },
        category: { type: Sequelize.STRING(100), allowNull: true },
        distributor_scope: { type: Sequelize.ENUM("ALL", "SPECIFIC"), allowNull: false, defaultValue: "ALL" },
        retailer_scope: { type: Sequelize.ENUM("ALL", "SPECIFIC"), allowNull: false, defaultValue: "ALL" },
        min_quantity: { type: Sequelize.INTEGER, allowNull: true },
        max_quantity: { type: Sequelize.INTEGER, allowNull: true },
        buy_quantity: { type: Sequelize.INTEGER, allowNull: true },
        free_quantity: { type: Sequelize.INTEGER, allowNull: true },
        discount_percent: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
        discount_amount: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        max_discount: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        valid_from: { type: Sequelize.DATEONLY, allowNull: false },
        valid_to: { type: Sequelize.DATEONLY, allowNull: true },
        status: { type: Sequelize.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
        priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 100 },
        created_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        updated_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        status_changed_at: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex("Schemes", ["status", "valid_from", "valid_to"], { name: "schemes_status_validity" });
      await queryInterface.addIndex("Schemes", ["scheme_type"], { name: "schemes_type" });
      await queryInterface.addIndex("Schemes", ["category"], { name: "schemes_category" });
    }

    const link = async (table, col) => {
      if (has(table)) return;
      await queryInterface.createTable(table, {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        scheme_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "Schemes", key: "id" }, onDelete: "CASCADE" },
        [col]: { type: Sequelize.INTEGER, allowNull: false },
      });
      await queryInterface.addIndex(table, ["scheme_id", col], { unique: true, name: `${table.toLowerCase()}_scheme_${col}` });
      await queryInterface.addIndex(table, [col], { name: `${table.toLowerCase()}_${col}` });
    };
    await link("SchemeProducts", "product_id");
    await link("SchemeDistributors", "distributor_id");
    await link("SchemeRetailers", "customer_id");
  },

  async down(queryInterface) {
    for (const t of ["SchemeRetailers", "SchemeDistributors", "SchemeProducts", "Schemes"]) {
      await queryInterface.dropTable(t);
    }
    if (queryInterface.sequelize.getDialect() === "postgres") {
      for (const e of ["scheme_type", "product_scope", "distributor_scope", "retailer_scope", "status"]) {
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_Schemes_${e}";`);
      }
    }
  },
};
