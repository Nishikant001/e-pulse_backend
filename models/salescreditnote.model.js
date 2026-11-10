module.exports = (sequelize, DataTypes) => {
  const SalesCreditNote = sequelize.define("SalesCreditNote", {
    invoiceId: { type: DataTypes.INTEGER, allowNull: false },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    credit_note_number: { type: DataTypes.STRING, allowNull: true },
    customerId: { type: DataTypes.INTEGER, allowNull: true },
    // Set when this credit note was generated automatically by a Sales
    // Return, rather than created standalone (e.g. a price correction).
    sourceReturnId: { type: DataTypes.INTEGER, allowNull: true },
    reason: DataTypes.STRING,

    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },

    netValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    sgstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    igstAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    totalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    amount: DataTypes.DECIMAL(10, 2), // legacy field, kept for backward compatibility; mirrors totalAmount
    postedAt: { type: DataTypes.DATE, allowNull: true },
  }, {
    indexes: [
      { unique: true, name: "uniq_creditnote_number_per_distributor", fields: ["distributor_id", "credit_note_number"] },
    ],
  });

  SalesCreditNote.associate = (models) => {
    SalesCreditNote.belongsTo(models.SalesInvoiceHeader, {
      foreignKey: "invoiceId",
      as: "invoice",
    });
  };

  return SalesCreditNote;
};
