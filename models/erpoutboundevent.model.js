// models/erpoutboundevent.model.js — Phase 16. One DMS → ERP write. `idempotency_key` is UNIQUE: the same business record is never sent twice
// by this DMS, and the same key is sent to the ERP so a retry cannot create a second ERP document. Vendor-neutral.
module.exports = (sequelize, DataTypes) => {
  const ErpOutboundEvent = sequelize.define(
    "ErpOutboundEvent",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      capability: { type: DataTypes.STRING(30), allowNull: false },
      entity_type: { type: DataTypes.STRING(30), allowNull: false },
      entity_id: { type: DataTypes.STRING(60), allowNull: false },
      operation: { type: DataTypes.STRING(8), allowNull: false }, // CREATE | UPDATE
      idempotency_key: { type: DataTypes.STRING(190), allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "PENDING" }, // PENDING | SENT | FAILED | BLOCKED
      attempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      external_id: { type: DataTypes.STRING(190), allowNull: true },
      error_code: { type: DataTypes.STRING(40), allowNull: true },
      error_message: { type: DataTypes.STRING(255), allowNull: true },
      correlation_id: { type: DataTypes.STRING(40), allowNull: true },
      requested_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "erp_outbound_events",
      indexes: [
        { unique: true, fields: ["idempotency_key"], name: "uq_erp_outbound_idem" },
        { fields: ["tenant_key", "connection_id", "status"], name: "ix_erp_outbound_tenant_conn" },
      ],
    }
  );
  return ErpOutboundEvent;
};
