module.exports = (sequelize, DataTypes) => {
  const PurchaseDebitNote = sequelize.define("PurchaseDebitNote", {
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    debit_note_number: { type: DataTypes.STRING, allowNull: true },
    vendor_id: { type: DataTypes.INTEGER, allowNull: false },
    invoiceId: { type: DataTypes.INTEGER, allowNull: true },
    sourceReturnId: { type: DataTypes.INTEGER, allowNull: true },
    reason: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },
    taxableValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    sgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    igstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    totalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    postedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    indexes: [
      { unique: true, name: "uniq_purchase_debitnote_number_per_distributor", fields: ["distributor_id", "debit_note_number"] },
    ],
  });

  PurchaseDebitNote.associate = (models) => {
    PurchaseDebitNote.belongsTo(models.PurchaseInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
    PurchaseDebitNote.belongsTo(models.Vendor, { foreignKey: "vendor_id", as: "vendor" });
  };

  return PurchaseDebitNote;
};
