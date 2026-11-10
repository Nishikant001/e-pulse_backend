// models/erpsyncschedule.model.js — Phase 15. "Run capability X of ERP connection Y every N minutes". One row per connection + capability.
// The scheduler only reads these rows and CREATES jobs (services/erpScheduler.service.js); the generic sync engine runs them.
//   next_run_at    the regular due time. Advanced atomically when a run is claimed, so two processes can never both fire the same slot.
//   next_retry_at  set only while an automatic retry (exponential backoff, bounded) is pending; wins over next_run_at.
//   retry_count / last_retry_at   automatic retries since the last regular run — visible to operators; capped, never infinite.
//   scope          the same admin-chosen scope a manual sync needs (distributor, HSN, customer group …); validated by the target each run.
module.exports = (sequelize, DataTypes) => {
  const ErpSyncSchedule = sequelize.define(
    "ErpSyncSchedule",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      capability: { type: DataTypes.STRING(30), allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      frequency: { type: DataTypes.STRING(20), allowNull: false }, // EVERY_15_MIN | EVERY_30_MIN | HOURLY | DAILY
      scope: { type: DataTypes.JSON, allowNull: true },
      next_run_at: { type: DataTypes.DATE, allowNull: true },
      next_retry_at: { type: DataTypes.DATE, allowNull: true },
      last_run_at: { type: DataTypes.DATE, allowNull: true },
      last_job_id: { type: DataTypes.INTEGER, allowNull: true },
      last_status: { type: DataTypes.STRING(12), allowNull: true }, // status of the last scheduled job, or SKIPPED when it could not even be queued
      last_error_code: { type: DataTypes.STRING(40), allowNull: true },
      last_error_message: { type: DataTypes.STRING(255), allowNull: true },
      retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_retry_at: { type: DataTypes.DATE, allowNull: true },
      created_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      updated_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "erp_sync_schedules",
      indexes: [
        { unique: true, fields: ["connection_id", "capability"], name: "uq_erp_sched_conn_cap" },
        { fields: ["enabled", "next_run_at"], name: "ix_erp_sched_due" },
        { fields: ["enabled", "next_retry_at"], name: "ix_erp_sched_retry" }, // Phase 17: retry branch of the due query
        { fields: ["tenant_key"], name: "ix_erp_sched_tenant" },
      ],
    }
  );
  return ErpSyncSchedule;
};
