// models/stocktransfer.model.js
//
// Phase 5 FOUNDATION for Stock Transfer: one immediately-posted transfer of one batch between two warehouses of the SAME
// distributor. The stock effect itself lives in StockLedger (an OUT + an IN row, reference_type TRANSFER, reference_id = this
// row's id). No approval / in-transit workflow yet, and no cross-distributor transfers (see docs, known limitations).
module.exports = (sequelize, DataTypes) => {
  const StockTransfer = sequelize.define(
    "StockTransfer",
    {
      transfer_no: { type: DataTypes.STRING(30), allowNull: true },
      distributor_id: { type: DataTypes.INTEGER, allowNull: false },
      from_warehouse_id: { type: DataTypes.INTEGER, allowNull: false },
      to_warehouse_id: { type: DataTypes.INTEGER, allowNull: false },
      productId: { type: DataTypes.INTEGER, allowNull: false },
      batchId: { type: DataTypes.INTEGER, allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
      transfer_date: { type: DataTypes.DATE, allowNull: false },
      status: { type: DataTypes.ENUM("POSTED", "CANCELLED"), allowNull: false, defaultValue: "POSTED" },
      reason: { type: DataTypes.STRING, allowNull: true },
      created_by: { type: DataTypes.INTEGER, allowNull: true },
    },
    { indexes: [{ unique: true, name: "uniq_stocktransfer_no_per_distributor", fields: ["distributor_id", "transfer_no"] }] }
  );
  StockTransfer.associate = (models) => {
    StockTransfer.belongsTo(models.Warehouse, { foreignKey: "from_warehouse_id", as: "fromWarehouse" });
    StockTransfer.belongsTo(models.Warehouse, { foreignKey: "to_warehouse_id", as: "toWarehouse" });
    StockTransfer.belongsTo(models.Product, { foreignKey: "productId", as: "product" });
    StockTransfer.belongsTo(models.Batch, { foreignKey: "batchId", as: "batch" });
  };
  return StockTransfer;
};
