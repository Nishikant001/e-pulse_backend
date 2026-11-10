module.exports = (sequelize, DataTypes) => {
  const SalesReturn = sequelize.define("SalesReturn", {
    return_number: { type: DataTypes.STRING, allowNull: true },
    distributor_id: { type: DataTypes.INTEGER, allowNull: false },
    distributor_code: { type: DataTypes.STRING, allowNull: true },
    customerId: { type: DataTypes.INTEGER, allowNull: false },
    invoiceId: { type: DataTypes.INTEGER, allowNull: false },
    returnDate: { type: DataTypes.DATE, allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    },
    // The Credit Note generated when this return is posted — the return
    // carries the physical (stock) detail, the credit note carries the
    // financial rollup. One is not a duplicate of the other.
    creditNoteId: { type: DataTypes.INTEGER, allowNull: true },
    // Phase 18 FOUNDATION ONLY (return sync is blocked): the stable external identity an ERP return would carry.
    external_source_type: { type: DataTypes.STRING(40), allowNull: true },
    external_source_id: { type: DataTypes.STRING(190), allowNull: true },
  }, {
    indexes: [
      { unique: true, name: "uniq_salesreturn_number_per_distributor", fields: ["distributor_id", "return_number"] },
      { unique: true, name: "uq_sales_return_external_source", fields: ["distributor_id", "external_source_type", "external_source_id"] },
    ],
  });

  SalesReturn.associate = (models) => {
    SalesReturn.belongsTo(models.SalesInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
    SalesReturn.belongsTo(models.Customer, { foreignKey: "customerId", as: "customer" });
    SalesReturn.belongsTo(models.SalesCreditNote, { foreignKey: "creditNoteId", as: "creditNote" });
    SalesReturn.hasMany(models.SalesReturnLine, { foreignKey: "returnId", as: "lines" });
  };

  return SalesReturn;
};
