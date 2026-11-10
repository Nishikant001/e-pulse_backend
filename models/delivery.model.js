// models/delivery.model.js
module.exports = (sequelize, DataTypes) => {
  const Delivery = sequelize.define("Delivery", {
    deliveryDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    status: {
      type: DataTypes.ENUM("Pending", "Shipped", "Delivered", "Cancelled"),
      defaultValue: "Pending",
    },
    customerName: {
      type: DataTypes.STRING,
      allowNull: true,
    }
  });

  Delivery.associate = (models) => {
    Delivery.belongsTo(models.SalesOrderHeader, {
      foreignKey: "salesOrderId",
      as: "salesOrder",
    });

    // optional: if you want delivery at line level
    Delivery.belongsTo(models.SalesOrderLine, {
      foreignKey: "salesOrderLineId",
      as: "salesOrderLine",
    });
  };

  return Delivery;
};
