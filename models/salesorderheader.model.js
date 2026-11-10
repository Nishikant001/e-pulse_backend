// models/salesorderheader.model.js
module.exports = (sequelize, DataTypes) => {
  const SalesOrderHeader = sequelize.define("SalesOrderHeader", {
    orderDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    customerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    distributor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    order_number: {
  type: DataTypes.STRING,
  unique: true
},
distributor_code: {
  type: DataTypes.STRING,
  allowNull: false
},

    customerName: DataTypes.STRING,
    address: DataTypes.STRING,
    billingAddress: DataTypes.STRING,
    shippingAddress: DataTypes.STRING,
    expectedDeliveryDate: DataTypes.DATE,
    paymentMethod: DataTypes.STRING,
    description: DataTypes.TEXT,

    // Phase 16 (generic, vendor-neutral): where an imported order came from. NULL for every order created in the DMS.
    external_source_type: { type: DataTypes.STRING(40), allowNull: true },
    external_source_id: { type: DataTypes.STRING(190), allowNull: true },

    status: {
      type: DataTypes.ENUM(
        "DRAFT",
        "CONFIRMED",
        "PARTIALLY_DELIVERED",
        "FULLY_DELIVERED",
        "CANCELLED",
        "CLOSED"
      ),
      allowNull: false,
      defaultValue: "DRAFT",
    },

    // Financials
    netValue: DataTypes.DECIMAL(10, 2),
    cgst: DataTypes.DECIMAL(5, 2),
    sgst: DataTypes.DECIMAL(5, 2),
    igst: DataTypes.DECIMAL(5, 2),
    cgstAmount: DataTypes.DECIMAL(10, 2),
    sgstAmount: DataTypes.DECIMAL(10, 2),
    igstAmount: DataTypes.DECIMAL(10, 2),
    totalAmount: DataTypes.DECIMAL(10, 2),
  }, {
    // Idempotency for imported orders: one DMS order per (distributor, source, source id). NULLs (all DMS-created orders) never clash.
    indexes: [{ unique: true, fields: ["distributor_id", "external_source_type", "external_source_id"], name: "uq_sales_order_external_source" }],
  });

  SalesOrderHeader.associate = (models) => {
    SalesOrderHeader.belongsTo(models.Customer, { foreignKey: "customerId", as: "customer" ,onDelete: "CASCADE", });
    SalesOrderHeader.hasMany(models.SalesOrderLine, { foreignKey: "orderId", as: "lines", onDelete: "CASCADE" });
    
  };

  return SalesOrderHeader;
};
