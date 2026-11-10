// models/salesorderline.model.js
module.exports = (sequelize, DataTypes) => {
  const SalesOrderLine = sequelize.define("SalesOrderLine", {
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    batchId: {
      type: DataTypes.INTEGER, // optional, if batch-wise deduction
      allowNull: true,
    },
    material_code: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    pricePerUnit: {
      type: DataTypes.DECIMAL(10, 2),
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

  SalesOrderLine.associate = (models) => {
    SalesOrderLine.belongsTo(models.SalesOrderHeader, { foreignKey: "orderId", as: "order" ,onDelete: "CASCADE", });
    SalesOrderLine.belongsTo(models.Product, { foreignKey: "productId", as: "product",onDelete: "CASCADE",  });
    SalesOrderLine.belongsTo(models.Batch, { foreignKey: "batchId", as: "batch" ,onDelete: "CASCADE", });
  };

  return SalesOrderLine;
};
