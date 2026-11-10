"use strict";

// Phase 17 — production hardening. ADDITIVE, idempotent and reversible: ONLY indexes (no table, column or data is created, altered or removed).
// Each index serves a query that Phase 17 identified in the audit (PHASE17_AUDIT.md §Database):
//   ix_erp_job_status_heartbeat   erp_sync_jobs (status, heartbeat_at)       stale-job reaper + readiness "stale jobs" (status IN (...) AND heartbeat_at < cutoff)
//   ix_erp_sched_retry            erp_sync_schedules (enabled, next_retry_at) due-schedule query's retry branch
//   ix_erp_audit_tenant_actor     erp_audit_events (tenant_key, actor_admin_id) the audit search "who did it" filter
// `down` removes only these three. Verified on sqlite (up / up / down / up); NOT verified against MySQL here (no MySQL available).
const INDEXES = [
  { table: "erp_sync_jobs", name: "ix_erp_job_status_heartbeat", fields: ["status", "heartbeat_at"] },
  { table: "erp_sync_schedules", name: "ix_erp_sched_retry", fields: ["enabled", "next_retry_at"] },
  { table: "erp_audit_events", name: "ix_erp_audit_tenant_actor", fields: ["tenant_key", "actor_admin_id"] },
];

module.exports = {
  async up(qi) {
    const tables = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    for (const ix of INDEXES) {
      if (!tables.includes(ix.table)) continue;
      const have = (await qi.showIndex(ix.table)).map((i) => i.name);
      if (!have.includes(ix.name)) await qi.addIndex(ix.table, ix.fields, { name: ix.name });
    }
  },

  async down(qi) {
    const tables = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    for (const ix of INDEXES) {
      if (!tables.includes(ix.table)) continue;
      const have = (await qi.showIndex(ix.table)).map((i) => i.name);
      if (have.includes(ix.name)) await qi.removeIndex(ix.table, ix.name);
    }
  },
};
