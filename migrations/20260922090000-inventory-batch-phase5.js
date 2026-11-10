"use strict";

// Phase 5 — Pharmaceutical Inventory & Batch Management. ADDITIVE ONLY: nothing is dropped, renamed, rewritten or
// recalculated, and no historical StockLedger row is modified.
//
//  - Warehouses            new table (one default "MAIN" warehouse is provisioned for every existing distributor)
//  - StockTransfers        new table (foundation for inter-warehouse transfers)
//  - StockLedgers          + warehouse_id (NULL = distributor's default warehouse)
//                          + stock_state  (default 'SALEABLE' → every existing balance is unchanged)
//                          + non_saleable_reason
//                          reference_type ENUM widened with TRANSFER, RECLASSIFY
//                          + composite indexes for the per-batch / per-warehouse balance and ledger queries
//  - Batches               + mrp (nullable) and a (distributor, product, batch_no) lookup index (NOT unique: legacy data may
//                          already contain duplicates; duplicate batch numbers are rejected by the application instead)
//
// Rollback (down) removes exactly what up added. Note: down() cannot be run safely once TRANSFER / RECLASSIFY /
// NON_SALEABLE rows exist, because those rows would lose their meaning — it refuses in that case.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));

    if (!tables.includes("Warehouses")) {
      await queryInterface.createTable("Warehouses", {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        code: { type: Sequelize.STRING(20), allowNull: false },
        name: { type: Sequelize.STRING(120), allowNull: false },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        status: { type: Sequelize.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex("Warehouses", ["distributor_id", "code"], { name: "uniq_warehouse_code_per_distributor", unique: true });

      // One default warehouse per existing distributor. Legacy ledger rows (warehouse_id NULL) are attributed to it at read time.
      await queryInterface.sequelize.query(
        `INSERT INTO Warehouses (distributor_id, code, name, is_default, status, createdAt, updatedAt)
         SELECT d.id, 'MAIN', 'Main Warehouse', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM Distributors d`
      );
    }

    if (!tables.includes("StockTransfers")) {
      await queryInterface.createTable("StockTransfers", {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        transfer_no: { type: Sequelize.STRING(30), allowNull: true },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        from_warehouse_id: { type: Sequelize.INTEGER, allowNull: false },
        to_warehouse_id: { type: Sequelize.INTEGER, allowNull: false },
        productId: { type: Sequelize.INTEGER, allowNull: false },
        batchId: { type: Sequelize.INTEGER, allowNull: false },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        transfer_date: { type: Sequelize.DATE, allowNull: false },
        status: { type: Sequelize.ENUM("POSTED", "CANCELLED"), allowNull: false, defaultValue: "POSTED" },
        reason: { type: Sequelize.STRING, allowNull: true },
        created_by: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex("StockTransfers", ["distributor_id", "transfer_no"], { name: "uniq_stocktransfer_no_per_distributor", unique: true });
      await queryInterface.addIndex("StockTransfers", ["distributor_id", "batchId"], { name: "idx_stocktransfer_dist_batch" });
    }

    const ledger = await queryInterface.describeTable("StockLedgers");
    if (!ledger.warehouse_id) await queryInterface.addColumn("StockLedgers", "warehouse_id", { type: Sequelize.INTEGER, allowNull: true });
    if (!ledger.stock_state) {
      await queryInterface.addColumn("StockLedgers", "stock_state", {
        type: Sequelize.ENUM("SALEABLE", "NON_SALEABLE"), allowNull: false, defaultValue: "SALEABLE",
      });
    }
    if (!ledger.non_saleable_reason) await queryInterface.addColumn("StockLedgers", "non_saleable_reason", { type: Sequelize.STRING(30), allowNull: true });

    await queryInterface.changeColumn("StockLedgers", "reference_type", {
      type: Sequelize.ENUM("OPENING", "PURCHASE", "SALES", "RETURN", "DAMAGE", "EXPIRY", "BREAKAGE", "PHYSICAL_COUNT", "CORRECTION", "ADJUSTMENT", "TRANSFER", "RECLASSIFY"),
      allowNull: true,
    });

    // Existing single-column indexes (distributor / product / batch / createdAt) are kept. These composites serve the new
    // per-batch balance and ledger-page queries (equality on tenant + batch, range/sort on createdAt).
    await queryInterface.addIndex("StockLedgers", ["distributor_id", "batchId", "createdAt"], { name: "idx_stockledger_dist_batch_created" });
    await queryInterface.addIndex("StockLedgers", ["distributor_id", "productId", "warehouse_id"], { name: "idx_stockledger_dist_product_wh" });

    const batches = await queryInterface.describeTable("Batches");
    if (!batches.mrp) await queryInterface.addColumn("Batches", "mrp", { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addIndex("Batches", ["distributor_id", "productId", "batch_no"], { name: "idx_batches_dist_product_batchno" });
  },

  async down(queryInterface, Sequelize) {
    const [[guard]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM StockLedgers WHERE reference_type IN ('TRANSFER','RECLASSIFY') OR stock_state = 'NON_SALEABLE'`
    );
    if (Number(guard.n) > 0) {
      throw new Error("Refusing to roll back: Phase 5 ledger rows (TRANSFER / RECLASSIFY / NON_SALEABLE) exist and would lose their meaning.");
    }
    await queryInterface.removeIndex("Batches", "idx_batches_dist_product_batchno");
    await queryInterface.removeColumn("Batches", "mrp");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_dist_product_wh");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_dist_batch_created");
    await queryInterface.changeColumn("StockLedgers", "reference_type", {
      type: Sequelize.ENUM("OPENING", "PURCHASE", "SALES", "RETURN", "DAMAGE", "EXPIRY", "BREAKAGE", "PHYSICAL_COUNT", "CORRECTION", "ADJUSTMENT"),
      allowNull: true,
    });
    await queryInterface.removeColumn("StockLedgers", "non_saleable_reason");
    await queryInterface.removeColumn("StockLedgers", "stock_state");
    await queryInterface.removeColumn("StockLedgers", "warehouse_id");
    await queryInterface.dropTable("StockTransfers");
    await queryInterface.dropTable("Warehouses");
  },
};
