// models/erpexternallink.model.js — Phase 14 IDEMPOTENCY. Links "this ERP's record X" to "that DMS row", per connection.
// Product 1001 of ERP A and product 1001 of ERP B are different rows (different connection), so ERPs never collide; re-running a
// sync finds the link and updates/skips instead of duplicating. content_hash = hash of the last mapped values: unchanged → SKIPPED.
// scope_key separates the same ERP record synced to different targets (e.g. "distributor:5"). The ERP's own code is stored HERE,
// not in a DMS column (Product.material_code is DMS-generated).
module.exports = (sequelize, DataTypes) => {
  const ErpExternalLink = sequelize.define(
    "ErpExternalLink",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false },
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      entity_type: { type: DataTypes.STRING(30), allowNull: false },
      external_id: { type: DataTypes.STRING(190), allowNull: false },
      scope_key: { type: DataTypes.STRING(60), allowNull: false, defaultValue: "" },
      dms_entity_id: { type: DataTypes.INTEGER, allowNull: false },
      dms_value: { type: DataTypes.STRING(120), allowNull: true }, // Phase 16: VALUE-type code mappings (e.g. payment mode); dms_entity_id is 0 for those
      content_hash: { type: DataTypes.STRING(64), allowNull: true },
      last_synced_at: { type: DataTypes.DATE, allowNull: true },
      last_job_id: { type: DataTypes.INTEGER, allowNull: true },
      // Phase 18: provenance + last reconciliation outcome. origin = which system CREATED the record ("ERP" | "DMS"): the echo-prevention marker.
      origin: { type: DataTypes.STRING(8), allowNull: true },
      reconcile_status: { type: DataTypes.STRING(20), allowNull: true }, // MATCHED | MISMATCH | MISSING_IN_DMS | MISSING_IN_ERP | BLOCKED | PENDING_REVIEW
      reconciled_at: { type: DataTypes.DATE, allowNull: true },
      reconcile_detail: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: "erp_external_links",
      indexes: [
        { unique: true, fields: ["connection_id", "entity_type", "external_id", "scope_key"], name: "uq_erp_link_identity" },
        { fields: ["entity_type", "dms_entity_id"], name: "ix_erp_link_dms" },
        { fields: ["connection_id", "entity_type", "reconcile_status"], name: "ix_erp_link_reconcile" },
      ],
    }
  );
  return ErpExternalLink;
};
