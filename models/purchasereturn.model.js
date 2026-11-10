module.exports = (sequelize, DataTypes) => {
  const PurchaseReturn = sequelize.define("PurchaseReturn", {
    return_number: { type: DataTypes.STRING, allowNull: true },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    vendor_id: { type: DataTypes.INTEGER, allowNull: false },
    invoiceId: { type: DataTypes.INTEGER, allowNull: false },
    returnDate: { type: DataTypes.DATE, allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },
    debitNoteId: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    indexes: [
      { unique: true, name: "uniq_purchasereturn_number_per_distributor", fields: ["distributor_id", "return_number"] },
    ],
  });

  PurchaseReturn.associate = (models) => {
    PurchaseReturn.belongsTo(models.PurchaseInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
    PurchaseReturn.belongsTo(models.Vendor, { foreignKey: "vendor_id", as: "vendor" });
    PurchaseReturn.belongsTo(models.PurchaseDebitNote, { foreignKey: "debitNoteId", as: "debitNote" });
    PurchaseReturn.hasMany(models.PurchaseReturnLine, { foreignKey: "returnId", as: "lines" });
  };

  return PurchaseReturn;
};
