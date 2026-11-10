module.exports = (sequelize, DataTypes) => {
  const JournalEntry = sequelize.define("JournalEntry", {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
distributor_code: {
  type: DataTypes.STRING,
  allowNull: false
},

    gl_id: { type: DataTypes.INTEGER, allowNull: false },
    reference_no: { type: DataTypes.STRING },
    // Discriminates which document type reference_no refers to, since
    // each document table has its own independent auto-increment id
    // space (a SalesInvoiceHeader #1 and a SalesCreditNote #1 can both
    // exist). Always set this alongside reference_no from this phase on.
    reference_type: { type: DataTypes.STRING, allowNull: true },

    debit: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    credit: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    // The actual business date of the underlying transaction (invoice
    // date, return date, payment date, etc.) — NOT necessarily the same
    // moment the journal row was inserted (createdAt). Always set this
    // explicitly from the source document; never leave it to default.
    transaction_date: { type: DataTypes.DATE, allowNull: true },

    customer_id: { type: DataTypes.INTEGER },
    vendor_id: { type: DataTypes.INTEGER },
    customer_code: {
  type: DataTypes.STRING,
  allowNull: true
},
vendor_code: {
  type: DataTypes.STRING,
  allowNull: true
}
,


    narration: { type: DataTypes.STRING },
  });

  return JournalEntry;
};
