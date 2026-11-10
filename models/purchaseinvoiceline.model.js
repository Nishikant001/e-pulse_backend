module.exports = (sequelize, DataTypes) => {
  const PurchaseInvoiceLine = sequelize.define("PurchaseInvoiceLine", {
    invoiceId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    orderLineId: { type: DataTypes.INTEGER, allowNull: true },
    deliveryLineId: { type: DataTypes.INTEGER, allowNull: true },

    quantity: DataTypes.INTEGER,
    pricePerUnit: DataTypes.DECIMAL(10, 2),
    discount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    taxableValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    sgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    igstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    lineTotal: DataTypes.DECIMAL(10, 2),
  });

  PurchaseInvoiceLine.associate = (models) => {
    PurchaseInvoiceLine.belongsTo(models.PurchaseInvoiceHeader, {
      foreignKey: "invoiceId",
      as: "invoice",
    });
    PurchaseInvoiceLine.belongsTo(models.Product, {
      foreignKey: "productId",
      as: "product",
    });
  };

  return PurchaseInvoiceLine;
};
