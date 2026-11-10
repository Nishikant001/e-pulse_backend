// models/erpconnectioncapability.model.js — Phase 13. Which data domains an ERP connection serves, in which DIRECTION, and
// (optionally) the OData entity set / path used for it. Configuration only: nothing is synchronised in Phase 13.
// Phase 14 reads these rows to decide: which ERP? which data? which direction? which endpoint?
module.exports = (sequelize, DataTypes) => {
  const ErpConnectionCapability = sequelize.define(
    "ErpConnectionCapability",
    {
      connection_id: { type: DataTypes.INTEGER, allowNull: false },
      capability: { type: DataTypes.STRING(30), allowNull: false }, // PRODUCT_MASTER | CUSTOMER_MASTER | …
      direction: { type: DataTypes.STRING(20), allowNull: false }, // ERP_TO_DMS | DMS_TO_ERP | BIDIRECTIONAL
      ownership: { type: DataTypes.STRING(12), allowNull: true }, // Phase 16: ERP_OWNED | DMS_OWNED | SHARED — NULL = the business has not decided
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      endpoint_path: { type: DataTypes.STRING(255), allowNull: true }, // this capability's endpoint on THIS ERP (entity set, REST path, …)
      config: { type: DataTypes.JSON, allowNull: true }, // provider-specific, allow-listed settings: response path, pagination, query, …
    },
    {
      tableName: "erp_connection_capabilities",
      indexes: [{ unique: true, fields: ["connection_id", "capability"], name: "uq_erp_cap_conn_capability" }],
    }
  );
  return ErpConnectionCapability;
};
