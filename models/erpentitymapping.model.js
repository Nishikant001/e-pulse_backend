// models/erpentitymapping.model.js — field-level mapping of ONE ERP connection + capability: ERP source field → DMS target field.
// (Phase 13 foundation; Phase 14 uses it. Columns renamed sap_* → source_* so the table is vendor-neutral.)
//   ERP A: MaterialCode → external_id   ERP B: ItemNumber → external_id   ERP C: MATNR → external_id
// The row marked is_key identifies the record across systems (stored as the external id in erp_external_links); every other row
// writes one DMS field. Mappings belong to a connection, so they inherit its tenant. `transform` = comma-separated names from the
// fixed allow-list in services/erp/sync/transforms.js (never code).
module.exports = (sequelize, DataTypes) => {
  const ErpEntityMapping = sequelize.define(
    "ErpEntityMapping",
    {
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      capability: { type: DataTypes.STRING(30), allowNull: false },
      source_entity: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      source_field: { type: DataTypes.STRING(120), allowNull: false },
      dms_entity: { type: DataTypes.STRING(60), allowNull: false },
      dms_field: { type: DataTypes.STRING(60), allowNull: false },
      is_key: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      transform: { type: DataTypes.STRING(120), allowNull: true },
    },
    { tableName: "erp_entity_mappings", indexes: [{ fields: ["connection_id", "capability"], name: "ix_erp_map_conn_cap" }] }
  );
  return ErpEntityMapping;
};
