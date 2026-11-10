module.exports = (sequelize, DataTypes) => {
  const PurchaseReturnLine = sequelize.define("PurchaseReturnLine", {
    returnId: { type: DataTypes.INTEGER, allowNull: false },
    invoiceLineId: { type: DataTypes.INTEGER, allowNull: false },
    productId: { type: DataTypes.INTEGER, allowNull: false },
    batchId: { type: DataTypes.INTEGER, allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    pricePerUnit: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: true },
  });

  PurchaseReturnLine.associate = (models) => {
    PurchaseReturnLine.belongsTo(models.PurchaseReturn, { foreignKey: "returnId", as: "return" });
    PurchaseReturnLine.belongsTo(models.Product, { foreignKey: "productId", as: "product" });
    PurchaseReturnLine.belongsTo(models.Batch, { foreignKey: "batchId", as: "batch" });
  };

  return PurchaseReturnLine;
};
