// models/erpsyncjob.model.js — Phase 14. One generic synchronisation run: tenant + ERP connection + capability. Vendor-neutral.
// `active_key` has a UNIQUE index and is set ("tenant:connection:capability") only while the job is QUEUED/RUNNING, NULL afterwards —
// so the database itself refuses two concurrent syncs of the same ERP + capability.
module.exports = (sequelize, DataTypes) => {
  const ErpSyncJob = sequelize.define(
    "ErpSyncJob",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      provider: { type: DataTypes.STRING(30), allowNull: true },
      erp_type: { type: DataTypes.STRING(20), allowNull: true },
      capability: { type: DataTypes.STRING(30), allowNull: false },
      direction: { type: DataTypes.STRING(20), allowNull: false },
      trigger_type: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "MANUAL" }, // MANUAL | SCHEDULED | RETRY
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "QUEUED" }, // QUEUED | RUNNING | SUCCESS | PARTIAL | FAILED
      correlation_id: { type: DataTypes.STRING(40), allowNull: true },
      scope: { type: DataTypes.JSON, allowNull: true },
      retry_of_job_id: { type: DataTypes.INTEGER, allowNull: true },
      attempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      active_key: { type: DataTypes.STRING(120), allowNull: true },
      heartbeat_at: { type: DataTypes.DATE, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      total_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      processed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      success_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updated_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      skipped_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error_code: { type: DataTypes.STRING(40), allowNull: true },
      error_message: { type: DataTypes.STRING(255), allowNull: true },
      requested_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "erp_sync_jobs",
      indexes: [
        { unique: true, fields: ["active_key"], name: "uq_erp_job_active_key" },
        { fields: ["tenant_key", "connection_id"], name: "ix_erp_job_tenant_conn" },
        { fields: ["tenant_key", "status"], name: "ix_erp_job_tenant_status" },
        { fields: ["status", "heartbeat_at"], name: "ix_erp_job_status_heartbeat" }, // Phase 17: stale-job reaper
      ],
    }
  );
  return ErpSyncJob;
};
