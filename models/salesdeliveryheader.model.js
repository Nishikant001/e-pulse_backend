module.exports = (sequelize, DataTypes) => {
  const SalesDeliveryHeader = sequelize.define("SalesDeliveryHeader", {
    deliveryDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    distributor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    remarks: DataTypes.STRING,
    status: {
      type: DataTypes.ENUM("Pending", "Dispatched", "Delivered", "Cancelled"),
      defaultValue: "Pending",
    },
  });

  SalesDeliveryHeader.associate = (models) => {
    SalesDeliveryHeader.belongsTo(models.SalesOrderHeader, {
      foreignKey: "orderId",
      as: "order",
      onDelete: "CASCADE",
    });
    SalesDeliveryHeader.hasMany(models.SalesDeliveryLine, {
      foreignKey: "deliveryId",
      as: "lines",
      onDelete: "CASCADE",
    });
  };

  return SalesDeliveryHeader;
};
