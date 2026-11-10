"use strict";

// This migration makes StockLedger the fully auditable single source of
// truth for physical inventory:
//  - adds reference_line_id (which order/delivery LINE a movement belongs to,
//    needed because a single delivery line can be fulfilled from multiple
//    batches under FEFO)
//  - adds created_by (the authenticated user/distributor who posted the
//    movement) and reason (free-text, used for adjustments)
//  - widens reference_type to cover all adjustment reasons required by the
//    business (damage, expiry, breakage, physical count, correction) plus a
//    generic ADJUSTMENT type
//  - adds indexes on every column the inventory queries filter/sort by
//  - adds a uniqueness guard so the exact same movement (same reference,
//    same line, same batch, same direction) can never be posted twice,
//    which is our DB-level duplicate-movement/idempotency protection
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("StockLedgers");

    if (!table.reference_line_id) {
      await queryInterface.addColumn("StockLedgers", "reference_line_id", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (!table.created_by) {
      await queryInterface.addColumn("StockLedgers", "created_by", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (!table.reason) {
      await queryInterface.addColumn("StockLedgers", "reason", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    // Widen reference_type ENUM to cover all adjustment reasons.
    await queryInterface.changeColumn("StockLedgers", "reference_type", {
      type: Sequelize.ENUM(
        "OPENING",
        "PURCHASE",
        "SALES",
        "RETURN",
        "DAMAGE",
        "EXPIRY",
        "BREAKAGE",
        "PHYSICAL_COUNT",
        "CORRECTION",
        "ADJUSTMENT"
      ),
      allowNull: true,
    });

    await queryInterface.addIndex("StockLedgers", ["distributor_id"], {
      name: "idx_stockledger_distributor",
    });
    await queryInterface.addIndex("StockLedgers", ["productId"], {
      name: "idx_stockledger_product",
    });
    await queryInterface.addIndex("StockLedgers", ["batchId"], {
      name: "idx_stockledger_batch",
    });
    await queryInterface.addIndex("StockLedgers", ["movement_type"], {
      name: "idx_stockledger_movement_type",
    });
    await queryInterface.addIndex(
      "StockLedgers",
      ["reference_type", "reference_id"],
      { name: "idx_stockledger_reference" }
    );
    await queryInterface.addIndex("StockLedgers", ["createdAt"], {
      name: "idx_stockledger_createdat",
    });

    // Idempotency guard: the same batch cannot be moved twice for the exact
    // same reference line + direction.
    await queryInterface.addIndex(
      "StockLedgers",
      ["reference_type", "reference_id", "reference_line_id", "batchId", "movement_type"],
      {
        name: "uniq_stockledger_movement",
        unique: true,
      }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex("StockLedgers", "uniq_stockledger_movement");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_createdat");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_reference");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_movement_type");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_batch");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_product");
    await queryInterface.removeIndex("StockLedgers", "idx_stockledger_distributor");

    await queryInterface.changeColumn("StockLedgers", "reference_type", {
      type: Sequelize.ENUM("OPENING", "PURCHASE", "SALES", "RETURN", "DAMAGE"),
      allowNull: true,
    });

    await queryInterface.removeColumn("StockLedgers", "reason");
    await queryInterface.removeColumn("StockLedgers", "created_by");
    await queryInterface.removeColumn("StockLedgers", "reference_line_id");
  },
};
