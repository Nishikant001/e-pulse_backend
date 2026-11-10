module.exports = (sequelize, DataTypes) => {
  const SalesCreditNoteLine = sequelize.define("SalesCreditNoteLine", {
    creditNoteId: { type: DataTypes.INTEGER, allowNull: false },
    invoiceLineId: { type: DataTypes.INTEGER, allowNull: false },
    productId: { type: DataTypes.INTEGER, allowNull: false },
    batchId: { type: DataTypes.INTEGER, allowNull: true },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    pricePerUnit: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    taxableValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    sgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    igstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    lineTotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  });

  SalesCreditNoteLine.associate = (models) => {
    SalesCreditNoteLine.belongsTo(models.SalesCreditNote, { foreignKey: "creditNoteId", as: "creditNote" });
    SalesCreditNoteLine.belongsTo(models.Product, { foreignKey: "productId", as: "product" });
  };

  return SalesCreditNoteLine;
};
