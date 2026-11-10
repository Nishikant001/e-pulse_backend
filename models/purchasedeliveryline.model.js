module.exports = (sequelize, DataTypes) => {
  const PurchaseDeliveryLine = sequelize.define("PurchaseDeliveryLine", {
    deliveryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    orderLineId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    batchId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    material_code: DataTypes.STRING(20),
    quantityReceived: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // This was always sent by purchasedelivery.controller.js but never
    // declared here, so Sequelize silently dropped it on every insert
    // (see migration 20260906090200) — purchase invoice totals were being
    // computed from `undefined` (NaN) as a result.
    pricePerUnit: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
  });

  PurchaseDeliveryLine.associate = (models) => {
    PurchaseDeliveryLine.belongsTo(models.PurchaseDeliveryHeader, {
      foreignKey: "deliveryId",
      as: "delivery",
    });
    PurchaseDeliveryLine.belongsTo(models.PurchaseOrderLine, {
      foreignKey: "orderLineId",
      as: "orderLine",
    });
    PurchaseDeliveryLine.belongsTo(models.Product, {
      foreignKey: "productId",
      as: "product",
    });
    PurchaseDeliveryLine.belongsTo(models.Batch, {
      foreignKey: "batchId",
      as: "batch",
    });
  };

  return PurchaseDeliveryLine;
};
