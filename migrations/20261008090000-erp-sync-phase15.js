"use strict";

// Phase 15 — ERP sync expansion, scheduler and monitoring. ADDITIVE, idempotent and reversible.
//   NEW erp_sync_schedules (recurring schedule per ERP connection + capability)
//   erp_sync_errors + connection_id, capability (denormalised from the job → fast error filters); existing rows are back-filled from their job
//   Indexes for the error monitor and the dashboard.
// No business table (Product, Customer, Distributor, PricingMaster, Payment …) is touched. `down` removes only what this migration created.
module.exports = {
  async up(qi, Sequelize) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = async (t) => (await tables()).includes(t);
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const indexes = async (t) => (await qi.showIndex(t)).map((i) => i.name);
    const ts = { createdAt: { type: Sequelize.DATE, allowNull: false }, updatedAt: { type: Sequelize.DATE, allowNull: false } };

    if (!(await has("erp_sync_schedules"))) {
      await qi.createTable("erp_sync_schedules", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_connections", key: "id" } },
        capability: { type: Sequelize.STRING(30), allowNull: false },
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        frequency: { type: Sequelize.STRING(20), allowNull: false },
        scope: { type: Sequelize.JSON, allowNull: true },
        next_run_at: { type: Sequelize.DATE, allowNull: true },
        next_retry_at: { type: Sequelize.DATE, allowNull: true },
        last_run_at: { type: Sequelize.DATE, allowNull: true },
        last_job_id: { type: Sequelize.INTEGER, allowNull: true },
        last_status: { type: Sequelize.STRING(12), allowNull: true },
        last_error_code: { type: Sequelize.STRING(40), allowNull: true },
        last_error_message: { type: Sequelize.STRING(255), allowNull: true },
        retry_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        last_retry_at: { type: Sequelize.DATE, allowNull: true },
        created_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        updated_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        ...ts,
      });
    }
    if (!(await indexes("erp_sync_schedules")).includes("uq_erp_sched_conn_cap")) await qi.addIndex("erp_sync_schedules", ["connection_id", "capability"], { unique: true, name: "uq_erp_sched_conn_cap" });
    if (!(await indexes("erp_sync_schedules")).includes("ix_erp_sched_due")) await qi.addIndex("erp_sync_schedules", ["enabled", "next_run_at"], { name: "ix_erp_sched_due" });
    if (!(await indexes("erp_sync_schedules")).includes("ix_erp_sched_tenant")) await qi.addIndex("erp_sync_schedules", ["tenant_key"], { name: "ix_erp_sched_tenant" });

    if (await has("erp_sync_errors")) {
      const c = await cols("erp_sync_errors");
      if (!c.includes("connection_id")) await qi.addColumn("erp_sync_errors", "connection_id", { type: Sequelize.INTEGER, allowNull: true });
      if (!c.includes("capability")) await qi.addColumn("erp_sync_errors", "capability", { type: Sequelize.STRING(30), allowNull: true });
      // Back-fill from the owning job (portable correlated sub-select: MySQL and sqlite).
      await qi.sequelize.query("UPDATE erp_sync_errors SET connection_id = (SELECT j.connection_id FROM erp_sync_jobs j WHERE j.id = erp_sync_errors.job_id) WHERE connection_id IS NULL");
      await qi.sequelize.query("UPDATE erp_sync_errors SET capability = (SELECT j.capability FROM erp_sync_jobs j WHERE j.id = erp_sync_errors.job_id) WHERE capability IS NULL");
      const ix = await indexes("erp_sync_errors");
      if (!ix.includes("ix_erp_err_tenant_conn_cap")) await qi.addIndex("erp_sync_errors", ["tenant_key", "connection_id", "capability"], { name: "ix_erp_err_tenant_conn_cap" });
      if (!ix.includes("ix_erp_err_tenant_code")) await qi.addIndex("erp_sync_errors", ["tenant_key", "error_code"], { name: "ix_erp_err_tenant_code" });
    }
    if (await has("erp_sync_jobs")) {
      const ix = await indexes("erp_sync_jobs");
      if (!ix.includes("ix_erp_job_tenant_conn_cap_done")) await qi.addIndex("erp_sync_jobs", ["tenant_key", "connection_id", "capability", "completed_at"], { name: "ix_erp_job_tenant_conn_cap_done" });
      if (!ix.includes("ix_erp_job_trigger_status")) await qi.addIndex("erp_sync_jobs", ["trigger_type", "status"], { name: "ix_erp_job_trigger_status" });
    }
  },

  async down(qi) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const indexes = async (t) => (await qi.showIndex(t)).map((i) => i.name);
    if ((await tables()).includes("erp_sync_jobs")) {
      for (const n of ["ix_erp_job_trigger_status", "ix_erp_job_tenant_conn_cap_done"]) if ((await indexes("erp_sync_jobs")).includes(n)) await qi.removeIndex("erp_sync_jobs", n);
    }
    if ((await tables()).includes("erp_sync_errors")) {
      for (const n of ["ix_erp_err_tenant_code", "ix_erp_err_tenant_conn_cap"]) if ((await indexes("erp_sync_errors")).includes(n)) await qi.removeIndex("erp_sync_errors", n);
      for (const c of ["capability", "connection_id"]) if ((await cols("erp_sync_errors")).includes(c)) await qi.removeColumn("erp_sync_errors", c);
    }
    if ((await tables()).includes("erp_sync_schedules")) await qi.dropTable("erp_sync_schedules");
  },
};
