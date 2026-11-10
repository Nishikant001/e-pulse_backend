// models/erpsyncerror.model.js — Phase 14. One failed RECORD of a sync job (never credentials, never raw ERP payloads).
module.exports = (sequelize, DataTypes) => {
  const ErpSyncError = sequelize.define(
    "ErpSyncError",
    {
      job_id: { type: DataTypes.INTEGER, allowNull: false },
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      // Phase 15: denormalised from the job so the error monitor can filter by ERP / capability without a join.
      connection_id: { type: DataTypes.INTEGER, allowNull: true },
      capability: { type: DataTypes.STRING(30), allowNull: true },
      record_index: { type: DataTypes.INTEGER, allowNull: true },
      external_id: { type: DataTypes.STRING(190), allowNull: true },
      error_code: { type: DataTypes.STRING(40), allowNull: false },
      message: { type: DataTypes.STRING(500), allowNull: false },
      retryable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: "erp_sync_errors", indexes: [{ fields: ["job_id"], name: "ix_erp_err_job" }, { fields: ["tenant_key", "connection_id", "capability"], name: "ix_erp_err_tenant_conn_cap" }, { fields: ["tenant_key", "error_code"], name: "ix_erp_err_tenant_code" }] }
  );
  return ErpSyncError;
};
