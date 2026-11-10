module.exports = (sequelize, DataTypes) => {
  const PurchaseInvoiceHeader = sequelize.define("PurchaseInvoiceHeader", {
    invoiceDate: { type: DataTypes.DATE, allowNull: false },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    invoice_number: { type: DataTypes.STRING, allowNull: true },
    vendor_id: { type: DataTypes.INTEGER, allowNull: false },
    deliveryId: { type: DataTypes.INTEGER, allowNull: false },
    paymentTerms: DataTypes.STRING,

    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },

    netValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    sgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    igstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    roundOff: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    totalAmount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.0 },

    dueDate: { type: DataTypes.DATE, allowNull: true },
    outstandingAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    postedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    indexes: [
      // One invoice per delivery (duplicate-invoice protection)
      { unique: true, name: "uniq_purchaseinvoice_delivery", fields: ["deliveryId"] },
      // Invoice numbers are unique per distributor, not globally
      { unique: true, name: "uniq_purchaseinvoice_number_per_distributor", fields: ["distributor_id", "invoice_number"] },
    ],
  });

  PurchaseInvoiceHeader.associate = (models) => {
    PurchaseInvoiceHeader.belongsTo(models.Distributor, {
      foreignKey: "distributor_id",
      as: "distributor",
    });

    PurchaseInvoiceHeader.belongsTo(models.Vendor, {
      foreignKey: "vendor_id",
      as: "vendor",
    });

    PurchaseInvoiceHeader.belongsTo(models.PurchaseDeliveryHeader, {
      foreignKey: "deliveryId",
      as: "delivery",
    });
  };

  return PurchaseInvoiceHeader;
};
