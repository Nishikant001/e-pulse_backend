// models/sapsyncrecord.model.js
//
// SAP synchronisation STATUS for a sales document (Phase 4). There was no SAP status structure in the data model, so this
// is the minimal additive table the Sales screens read. Nothing writes to it yet: real SAP transmission, jobs and retries
// are a later phase. A document with NO row is reported as PENDING (never sent) — it is never reported as synced by guesswork.
module.exports = (sequelize, DataTypes) => {
  const SapSyncRecord = sequelize.define(
    "SapSyncRecord",
    {
      distributor_id: { type: DataTypes.INTEGER, allowNull: false },
      entity_type: { type: DataTypes.STRING(30), allowNull: false }, // SALES_ORDER | SALES_INVOICE
      entity_id: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING" }, // PENDING | SYNCED | FAILED | PARTIAL
      sap_document_no: { type: DataTypes.STRING(40), allowNull: true },
      last_attempt_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      tableName: "sap_sync_records",
      indexes: [{ unique: true, fields: ["entity_type", "entity_id"] }, { fields: ["status"] }],
    }
  );
  return SapSyncRecord;
};
