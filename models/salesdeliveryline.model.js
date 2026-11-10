module.exports = (sequelize, DataTypes) => {
  const SalesDeliveryLine = sequelize.define("SalesDeliveryLine", {
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
    material_code: DataTypes.STRING(20),
    quantityDelivered: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  });
  SalesDeliveryLine.associate = (models) => {
    SalesDeliveryLine.belongsTo(models.SalesDeliveryHeader, {
      foreignKey: "deliveryId",
      as: "delivery",
    });
    SalesDeliveryLine.belongsTo(models.SalesOrderLine, {
      foreignKey: "orderLineId",
      as: "orderLine",
    });
    SalesDeliveryLine.belongsTo(models.Product, {
      foreignKey: "productId",
      as: "product",
    });
  };

  return SalesDeliveryLine;
};
