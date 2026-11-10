// models/erpauditevent.model.js — Phase 16. PERSISTENT, APPEND-ONLY audit trail of ERP activity (connections, syncs, schedules, outbound).
// Append-only is enforced here (update / destroy hooks refuse) AND by the API (there is no edit or delete route). Never holds credentials:
// `metadata` is passed through the safe-metadata filter in services/erpAudit.service.js before it is written.
module.exports = (sequelize, DataTypes) => {
  const refuse = () => { throw new Error("ERP audit events are append-only."); };
  const ErpAuditEvent = sequelize.define(
    "ErpAuditEvent",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      actor_admin_id: { type: DataTypes.INTEGER, allowNull: true }, // NULL = system (scheduler / worker)
      event: { type: DataTypes.STRING(40), allowNull: false },
      connection_id: { type: DataTypes.INTEGER, allowNull: true },
      erp_code: { type: DataTypes.STRING(60), allowNull: true }, // the connection's code, kept even if the connection is later deleted
      provider: { type: DataTypes.STRING(30), allowNull: true },
      capability: { type: DataTypes.STRING(30), allowNull: true },
      entity_type: { type: DataTypes.STRING(30), allowNull: true },
      entity_id: { type: DataTypes.STRING(190), allowNull: true },
      status: { type: DataTypes.STRING(12), allowNull: true }, // OK | FAILED | PARTIAL | INFO
      correlation_id: { type: DataTypes.STRING(40), allowNull: true },
      metadata: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: "erp_audit_events",
      updatedAt: false,
      indexes: [
        { fields: ["tenant_key", "createdAt"], name: "ix_erp_audit_tenant_time" },
        { fields: ["tenant_key", "event"], name: "ix_erp_audit_tenant_event" },
        { fields: ["tenant_key", "connection_id", "capability"], name: "ix_erp_audit_tenant_conn_cap" },
        { fields: ["correlation_id"], name: "ix_erp_audit_corr" },
        { fields: ["tenant_key", "actor_admin_id"], name: "ix_erp_audit_tenant_actor" }, // Phase 17: "who did it" filter
      ],
      hooks: { beforeUpdate: refuse, beforeDestroy: refuse, beforeBulkUpdate: refuse, beforeBulkDestroy: refuse },
    }
  );
  return ErpAuditEvent;
};
