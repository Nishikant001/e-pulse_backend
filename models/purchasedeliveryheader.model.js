module.exports = (sequelize, DataTypes) => {
  const PurchaseDeliveryHeader = sequelize.define("PurchaseDeliveryHeader", {
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
      type: DataTypes.ENUM("Pending", "Received", "Cancelled"),
      defaultValue: "Pending",
    },
  });

  PurchaseDeliveryHeader.associate = (models) => {
    PurchaseDeliveryHeader.belongsTo(models.PurchaseOrderHeader, {
      foreignKey: "orderId",
      as: "order",
      onDelete: "CASCADE",
    });
    PurchaseDeliveryHeader.hasMany(models.PurchaseDeliveryLine, {
      foreignKey: "deliveryId",
      as: "lines",
      onDelete: "CASCADE",
    });
  };

  return PurchaseDeliveryHeader;
};
