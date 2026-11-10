// models/purchaseorderline.model.js
module.exports = (sequelize, DataTypes) => {
  const PurchaseOrderLine = sequelize.define("PurchaseOrderLine", {
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    pricePerUnit: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    material_code: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    discount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    lineNetValue: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
  });

  PurchaseOrderLine.associate = (models) => {
    PurchaseOrderLine.belongsTo(models.PurchaseOrderHeader, {
      foreignKey: "orderId",
      as: "order",
      onDelete: "CASCADE",
    });
    PurchaseOrderLine.belongsTo(models.Product, {
      foreignKey: "productId",
      as: "product",
      onDelete: "CASCADE",
    });
  };

  return PurchaseOrderLine;
};
