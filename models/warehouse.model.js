// models/warehouse.model.js
//
// A storage location owned by ONE distributor (tenant). Phase 5 foundation: every distributor has exactly one DEFAULT
// warehouse ("MAIN") which acts as the dispatch warehouse for sales; more can be added. Stock is never stored here — it is
// derived from StockLedger rows carrying `warehouse_id` (NULL on legacy rows = the distributor's default warehouse).
module.exports = (sequelize, DataTypes) => {
  const Warehouse = sequelize.define(
    "Warehouse",
    {
      distributor_id: { type: DataTypes.INTEGER, allowNull: false },
      code: { type: DataTypes.STRING(20), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
    },
    { indexes: [{ unique: true, name: "uniq_warehouse_code_per_distributor", fields: ["distributor_id", "code"] }] }
  );
  Warehouse.associate = (models) => {
    Warehouse.belongsTo(models.Distributor, { foreignKey: "distributor_id", as: "distributor" });
  };
  return Warehouse;
};
