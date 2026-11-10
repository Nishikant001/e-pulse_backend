module.exports = (sequelize, DataTypes) => {
  const SalesInvoiceHeader = sequelize.define("SalesInvoiceHeader", {
    invoiceDate: { type: DataTypes.DATE, allowNull: false },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    invoice_number: { type: DataTypes.STRING, allowNull: true },
    customer_id: { type: DataTypes.INTEGER, allowNull: false },
    deliveryId: { type: DataTypes.INTEGER, allowNull: false },
    paymentTerms: DataTypes.STRING,

    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"),
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
    // Phase 18 FOUNDATION ONLY: the stable external identity an ERP invoice would carry. No sync reads or writes it yet (invoice sync is blocked).
    external_source_type: { type: DataTypes.STRING(40), allowNull: true },
    external_source_id: { type: DataTypes.STRING(190), allowNull: true },
  }, {
    indexes: [
      // One invoice per delivery (duplicate-invoice protection)
      { unique: true, name: "uniq_salesinvoice_delivery", fields: ["deliveryId"] },
      // Invoice numbers are unique per distributor, not globally
      { unique: true, name: "uniq_salesinvoice_number_per_distributor", fields: ["distributor_id", "invoice_number"] },
      { unique: true, name: "uq_sales_invoice_external_source", fields: ["distributor_id", "external_source_type", "external_source_id"] },
    ],
  });

  SalesInvoiceHeader.associate = (models) => {
    SalesInvoiceHeader.belongsTo(models.Distributor, {
      foreignKey: "distributor_id",
      as: "distributor",
    });

    SalesInvoiceHeader.belongsTo(models.Customer, {
      foreignKey: "customer_id",
      as: "customer",
    });

    SalesInvoiceHeader.belongsTo(models.SalesDeliveryHeader, {
      foreignKey: "deliveryId",
      as: "delivery",
    });
  };

  return SalesInvoiceHeader;
};
