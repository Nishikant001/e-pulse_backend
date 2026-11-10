module.exports = (sequelize, DataTypes) => {
  const SalesDebitNote = sequelize.define("SalesDebitNote", {
    invoiceId: { type: DataTypes.INTEGER, allowNull: false },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    debit_note_number: { type: DataTypes.STRING, allowNull: true },
    customerId: { type: DataTypes.INTEGER, allowNull: true },
    reason: DataTypes.STRING,

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
    amount: DataTypes.DECIMAL(10, 2), // legacy field, kept for backward compatibility; mirrors totalAmount
    postedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    indexes: [
      { unique: true, name: "uniq_debitnote_number_per_distributor", fields: ["distributor_id", "debit_note_number"] },
    ],
  });

  SalesDebitNote.associate = (models) => {
    SalesDebitNote.belongsTo(models.SalesInvoiceHeader, {
      foreignKey: "invoiceId",
      as: "invoice",
    });
  };

  return SalesDebitNote;
};
