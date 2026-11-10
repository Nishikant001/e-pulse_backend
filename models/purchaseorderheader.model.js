// models/purchaseorderheader.model.js
module.exports = (sequelize, DataTypes) => {
  const PurchaseOrderHeader = sequelize.define("PurchaseOrderHeader", {
    orderDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    // e-Pulse Phase 1: a distributor's PO no longer names a vendor — it is addressed to the distributor's admin (tenant admin).
    // Nullable via migration 20261013090000-po-optional-vendor-phase1. Legacy POs keep their vendor.
    vendorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    vendorName: DataTypes.STRING,
    address: DataTypes.STRING,
    paymentMethod: DataTypes.STRING,
    description: DataTypes.TEXT,

    status: {
      type: DataTypes.ENUM(
        "DRAFT",
        "CONFIRMED",
        "PARTIALLY_RECEIVED",
        "FULLY_RECEIVED",
        "CANCELLED",
        "CLOSED"
      ),
      allowNull: false,
      defaultValue: "DRAFT",
    },

    // Financials
    netValue: DataTypes.DECIMAL(10, 2),

    cgstAmount: DataTypes.DECIMAL(10, 2),
    sgstAmount: DataTypes.DECIMAL(10, 2),
    igstAmount: DataTypes.DECIMAL(10, 2),
    totalAmount: DataTypes.DECIMAL(10, 2),
  });

  PurchaseOrderHeader.associate = (models) => {
    PurchaseOrderHeader.belongsTo(models.Vendor, {
      foreignKey: "vendorId",
      as: "vendor",
      onDelete: "CASCADE",
    });
    PurchaseOrderHeader.hasMany(models.PurchaseOrderLine, {
      foreignKey: "orderId",
      as: "lines",
      onDelete: "CASCADE",
    });
  };

  return PurchaseOrderHeader;
};
