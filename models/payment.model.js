// Phase 12 — Payments. A Payment is money received from a retailer (Customer) for a distributor's books, recorded by Admin.
// There was no payment table before this phase: legacy receipts (POST /api/payment/receive) exist only as CUSTOMER_PAYMENT journal rows.
// Journal rows stay the accounting truth; these tables add the business document (who/when/mode/reference) and the optional
// invoice-level allocation. Nothing here duplicates a ledger: amounts in the journal and here are written in one transaction.
module.exports = (sequelize, DataTypes) => {
  const MODES = ["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "OTHER"];

  const Payment = sequelize.define(
    "Payment",
    {
      payment_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      distributor_id: { type: DataTypes.INTEGER, allowNull: false }, // tenant — always derived from the retailer, never from the client
      customer_id: { type: DataTypes.INTEGER, allowNull: false }, // the retailer that paid
      payment_date: { type: DataTypes.DATEONLY, allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      mode: { type: DataTypes.ENUM(...MODES), allowNull: false },
      reference_no: { type: DataTypes.STRING(60), allowNull: true }, // bank / UPI / cheque reference
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      status: { type: DataTypes.ENUM("POSTED"), allowNull: false, defaultValue: "POSTED" }, // cancellation/reversal is future work
      created_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "Payments",
      indexes: [
        { unique: true, name: "uniq_payment_reference_per_distributor", fields: ["distributor_id", "reference_no"] }, // NULLs never collide
        { fields: ["distributor_id", "payment_date"] },
        { fields: ["customer_id"] },
      ],
    }
  );

  const PaymentAllocation = sequelize.define(
    "PaymentAllocation",
    {
      payment_id: { type: DataTypes.INTEGER, allowNull: false },
      invoice_id: { type: DataTypes.INTEGER, allowNull: false },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    },
    {
      tableName: "PaymentAllocations",
      indexes: [
        { unique: true, name: "uniq_allocation_payment_invoice", fields: ["payment_id", "invoice_id"] },
        { fields: ["invoice_id"] },
      ],
    }
  );

  Payment.hasMany(PaymentAllocation, { foreignKey: "payment_id", as: "allocations", onDelete: "CASCADE" });
  PaymentAllocation.belongsTo(Payment, { foreignKey: "payment_id", as: "payment" });

  return { Payment, PaymentAllocation, PAYMENT_MODES: MODES };
};
