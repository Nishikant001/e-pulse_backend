module.exports = (sequelize, DataTypes) => {
  const SalesReturnLine = sequelize.define("SalesReturnLine", {
    returnId: { type: DataTypes.INTEGER, allowNull: false },
    invoiceLineId: { type: DataTypes.INTEGER, allowNull: false },
    productId: { type: DataTypes.INTEGER, allowNull: false },
    batchId: { type: DataTypes.INTEGER, allowNull: true },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    pricePerUnit: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: true },
  });

  SalesReturnLine.associate = (models) => {
    SalesReturnLine.belongsTo(models.SalesReturn, { foreignKey: "returnId", as: "return" });
    SalesReturnLine.belongsTo(models.Product, { foreignKey: "productId", as: "product" });
    SalesReturnLine.belongsTo(models.Batch, { foreignKey: "batchId", as: "batch" });
  };

  return SalesReturnLine;
};
