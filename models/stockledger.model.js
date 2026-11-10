module.exports = (sequelize, DataTypes) => {
  const StockLedger = sequelize.define("StockLedger", {
    movement_type: {
      type: DataTypes.ENUM("IN", "OUT", "ADJUST"),
      allowNull: false
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 }
    },
    reference_type: {
      type: DataTypes.ENUM(
        "OPENING",
        "PURCHASE",
        "SALES",
        "RETURN",
        "DAMAGE",
        "EXPIRY",
        "BREAKAGE",
        "PHYSICAL_COUNT",
        "CORRECTION",
        "ADJUSTMENT",
        // Phase 5 (additive): inter-warehouse transfer, and saleable <-> non-saleable reclassification.
        "TRANSFER",
        "RECLASSIFY"
      )
    },
    reference_id: {
      type: DataTypes.INTEGER
    },
    // Which order/delivery LINE this movement fulfills. Needed because a
    // single delivery line can be split across multiple batches (FEFO).
    reference_line_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    // The authenticated user who posted this movement (audit trail).
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    // Free-text reason, primarily used for manual adjustments.
    reason: {
      type: DataTypes.STRING,
      allowNull: true
    },
    distributor_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    // Phase 5 (additive). Where the stock physically is. NULL on legacy rows = the distributor's default (dispatch)
    // warehouse; new rows always carry the resolved warehouse id.
    warehouse_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    // Phase 5 (additive). Quantity-level saleability. Legacy rows default to SALEABLE, so every existing balance is
    // unchanged. NON_SALEABLE stock stays on the ledger (never deleted) and is excluded from sales allocation.
    stock_state: {
      type: DataTypes.ENUM("SALEABLE", "NON_SALEABLE"),
      allowNull: false,
      defaultValue: "SALEABLE"
    },
    // Why NON_SALEABLE stock is non-saleable (DAMAGED, EXPIRED, QUALITY_ISSUE, RETURNED, BLOCKED, OTHER).
    non_saleable_reason: {
      type: DataTypes.STRING(30),
      allowNull: true
    }
  }, {
    indexes: [
      // DB-level idempotency guard: the same batch cannot be moved twice
      // for the exact same reference line + direction. Mirrors migration
      // 20260904090000-extend-stockledger-inventory-v2.js so `sequelize.sync()`
      // (used in local/dev per config/dbSync.js) and real migrations
      // (used for actual deployments) stay consistent.
      {
        unique: true,
        name: "uniq_stockledger_movement",
        fields: ["reference_type", "reference_id", "reference_line_id", "batchId", "movement_type"],
      },
    ],
  });

  StockLedger.associate = (models) => {
    StockLedger.belongsTo(models.Product, { foreignKey: "productId", as: "product" });
    StockLedger.belongsTo(models.Batch, { foreignKey: "batchId", as: "batch" });
  };

  return StockLedger;
};
