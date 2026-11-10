// models/erpconnection.model.js — Phase 13. One row = one ERP / SAP OData connection of a tenant (many per tenant).
//
// NO secret is stored here. `credential_ref` is only a NAME (e.g. "SAP_PROD") that the server resolves from its environment
// / secret manager (see services/erp/secretResolver.js).
// `status` is the admin-controlled lifecycle (ACTIVE | INACTIVE | ERROR). It does NOT mean "SAP is reachable": reachability
// is only ever shown from the last real connection test (last_test_*), and a never-tested connection says so.
// Default ERP: `is_default` + `default_marker`. default_marker = tenant_key for the default row, NULL otherwise, and carries a
// UNIQUE index — so the database itself refuses a second default for the same tenant, even under concurrent writes.
module.exports = (sequelize, DataTypes) => {
  const ErpConnection = sequelize.define(
    "ErpConnection",
    {
      tenant_key: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "DEFAULT" },
      code: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      erp_type: { type: DataTypes.STRING(20), allowNull: false }, // what the ERP is (services/erp/erpConstants.js)
      // HOW we talk to it (Phase 14): a key of services/erp/providerRegistry.js. NULL = the default provider of erp_type (never a silent SAP fallback).
      provider: { type: DataTypes.STRING(30), allowNull: true },
      environment: { type: DataTypes.STRING(20), allowNull: false },
      odata_version: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "V2" },
      base_url: { type: DataTypes.STRING(500), allowNull: false },
      odata_service_path: { type: DataTypes.STRING(255), allowNull: true },
      sap_client: { type: DataTypes.STRING(3), allowNull: true },
      company_code: { type: DataTypes.STRING(10), allowNull: true },
      auth_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "BASIC" },
      auth_header_name: { type: DataTypes.STRING(64), allowNull: true }, // header an API key is sent in (non-secret)
      config: { type: DataTypes.JSON, allowNull: true }, // provider-specific, allow-listed, non-secret settings (e.g. REST testPath)
      credential_ref: { type: DataTypes.STRING(40), allowNull: true },
      timeout_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10000 },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "ACTIVE" },
      is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      default_marker: { type: DataTypes.STRING(40), allowNull: true },
      description: { type: DataTypes.STRING(500), allowNull: true },
      last_test_at: { type: DataTypes.DATE, allowNull: true },
      last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },
      last_test_code: { type: DataTypes.STRING(40), allowNull: true },
      last_test_message: { type: DataTypes.STRING(255), allowNull: true },
      last_test_latency_ms: { type: DataTypes.INTEGER, allowNull: true },
      created_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      updated_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "erp_connections",
      indexes: [
        { unique: true, fields: ["tenant_key", "code"], name: "uq_erp_conn_tenant_code" },
        { unique: true, fields: ["default_marker"], name: "uq_erp_conn_default_per_tenant" },
        { fields: ["tenant_key", "status"], name: "ix_erp_conn_tenant_status" },
      ],
    }
  );
  return ErpConnection;
};
