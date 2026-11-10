// Phase 11 — Claims. A claim is a Distributor's request to be compensated for a scheme benefit it already gave on a posted
// invoice. Only SCHEME claims exist (see docs). Distributor / customer / scheme / invoice / product are referenced by ID;
// nothing from those masters is copied except the immutable snapshot of what was true when the claim was submitted.
module.exports = (sequelize, DataTypes) => {
  const STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "NEEDS_CORRECTION", "RESUBMITTED"];

  const Claim = sequelize.define(
    "Claim",
    {
      claim_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      claim_type: { type: DataTypes.ENUM("SCHEME"), allowNull: false, defaultValue: "SCHEME" },
      distributor_id: { type: DataTypes.INTEGER, allowNull: false }, // tenant owner — always derived from the session
      customer_id: { type: DataTypes.INTEGER, allowNull: true }, // retailer (a Customer) of the invoice; no login exists for it
      scheme_id: { type: DataTypes.INTEGER, allowNull: false },
      invoice_id: { type: DataTypes.INTEGER, allowNull: false },
      claim_date: { type: DataTypes.DATEONLY, allowNull: false },
      period_from: { type: DataTypes.DATEONLY, allowNull: false },
      period_to: { type: DataTypes.DATEONLY, allowNull: false },
      claim_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 }, // server-calculated, never client-supplied
      description: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: "DRAFT" },
      submitted_at: { type: DataTypes.DATE, allowNull: true },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      decided_at: { type: DataTypes.DATE, allowNull: true },
      decided_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      decision_reason: { type: DataTypes.STRING(1000), allowNull: true }, // rejection reason or approval comment
      correction_reason: { type: DataTypes.STRING(1000), allowNull: true },
      required_information: { type: DataTypes.STRING(1000), allowNull: true },
      // What the scheme looked like when the claim was last (re)submitted — later scheme edits never rewrite it.
      scheme_snapshot: { type: DataTypes.TEXT, allowNull: true },
      // Phase 12 — financial settlement. settlement_reference is the journal reference_no of the CLAIM_SETTLEMENT entries; unique so a claim
      // can never be settled twice even if two requests race. NULL = not settled (rejected / in-flight / approved before Phase 12).
      settlement_reference: { type: DataTypes.STRING(40), allowNull: true, unique: true },
      settled_at: { type: DataTypes.DATE, allowNull: true },
      settled_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "Claims",
      indexes: [
        { fields: ["distributor_id", "status"] },
        { fields: ["scheme_id"] },
        { fields: ["invoice_id"] },
        { fields: ["customer_id"] },
        { fields: ["claim_date"] },
      ],
    }
  );

  const ClaimItem = sequelize.define(
    "ClaimItem",
    {
      claim_id: { type: DataTypes.INTEGER, allowNull: false },
      invoice_line_id: { type: DataTypes.INTEGER, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false }, // purchased quantity the scheme is claimed on
      unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      benefit_type: { type: DataTypes.STRING(20), allowNull: true },
      free_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      eligible_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    },
    { tableName: "ClaimItems", timestamps: false, indexes: [{ fields: ["claim_id"] }, { fields: ["invoice_line_id"] }, { fields: ["product_id"] }] }
  );

  // Append-only trail. Rows are inserted, never updated or deleted by application code.
  const ClaimStatusHistory = sequelize.define(
    "ClaimStatusHistory",
    {
      claim_id: { type: DataTypes.INTEGER, allowNull: false },
      from_status: { type: DataTypes.STRING(20), allowNull: true },
      to_status: { type: DataTypes.STRING(20), allowNull: false },
      actor_type: { type: DataTypes.ENUM("ADMIN", "DISTRIBUTOR"), allowNull: false },
      actor_id: { type: DataTypes.INTEGER, allowNull: false },
      comment: { type: DataTypes.STRING(1000), allowNull: true },
    },
    { tableName: "ClaimStatusHistories", updatedAt: false, indexes: [{ fields: ["claim_id", "createdAt"] }] }
  );

  Claim.hasMany(ClaimItem, { foreignKey: "claim_id", as: "items", onDelete: "CASCADE" });
  Claim.hasMany(ClaimStatusHistory, { foreignKey: "claim_id", as: "history", onDelete: "CASCADE" });
  return { Claim, ClaimItem, ClaimStatusHistory, STATUSES };
};
