"use strict";

// Phase 13 — SAP / ERP Integration Architecture. ADDITIVE ONLY. Idempotent and reversible.
//   • erp_connections               (new — no ERP/SAP configuration existed; many per tenant)
//   • erp_connection_capabilities   (new — data domains + direction + endpoint per connection)
//   • erp_entity_mappings           (new — field-mapping foundation for Phase 14)
// Nothing existing is altered or dropped; sap_sync_records (Phase 4) is untouched. `down` drops ONLY these three tables.
// Uniqueness of the default ERP per tenant is enforced by the unique index on erp_connections.default_marker.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = (n) => tables.includes(n);
    const ts = { createdAt: { type: Sequelize.DATE, allowNull: false }, updatedAt: { type: Sequelize.DATE, allowNull: false } };

    if (!has("erp_connections")) {
      await queryInterface.createTable("erp_connections", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false, defaultValue: "DEFAULT" },
        code: { type: Sequelize.STRING(40), allowNull: false },
        name: { type: Sequelize.STRING(120), allowNull: false },
        erp_type: { type: Sequelize.STRING(20), allowNull: false },
        environment: { type: Sequelize.STRING(20), allowNull: false },
        odata_version: { type: Sequelize.STRING(2), allowNull: false, defaultValue: "V2" },
        base_url: { type: Sequelize.STRING(500), allowNull: false },
        odata_service_path: { type: Sequelize.STRING(255), allowNull: true },
        sap_client: { type: Sequelize.STRING(3), allowNull: true },
        company_code: { type: Sequelize.STRING(10), allowNull: true },
        auth_type: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "BASIC" },
        credential_ref: { type: Sequelize.STRING(40), allowNull: true },
        timeout_ms: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10000 },
        status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: "ACTIVE" },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        default_marker: { type: Sequelize.STRING(40), allowNull: true },
        description: { type: Sequelize.STRING(500), allowNull: true },
        last_test_at: { type: Sequelize.DATE, allowNull: true },
        last_test_ok: { type: Sequelize.BOOLEAN, allowNull: true },
        last_test_code: { type: Sequelize.STRING(40), allowNull: true },
        last_test_message: { type: Sequelize.STRING(255), allowNull: true },
        last_test_latency_ms: { type: Sequelize.INTEGER, allowNull: true },
        created_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        updated_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        ...ts,
      });
      await queryInterface.addIndex("erp_connections", ["tenant_key", "code"], { unique: true, name: "uq_erp_conn_tenant_code" });
      await queryInterface.addIndex("erp_connections", ["default_marker"], { unique: true, name: "uq_erp_conn_default_per_tenant" });
      await queryInterface.addIndex("erp_connections", ["tenant_key", "status"], { name: "ix_erp_conn_tenant_status" });
    }

    if (!has("erp_connection_capabilities")) {
      await queryInterface.createTable("erp_connection_capabilities", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_connections", key: "id" } },
        capability: { type: Sequelize.STRING(30), allowNull: false },
        direction: { type: Sequelize.STRING(20), allowNull: false },
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        endpoint_path: { type: Sequelize.STRING(255), allowNull: true },
        ...ts,
      });
      await queryInterface.addIndex("erp_connection_capabilities", ["connection_id", "capability"], { unique: true, name: "uq_erp_cap_conn_capability" });
    }

    if (!has("erp_entity_mappings")) {
      await queryInterface.createTable("erp_entity_mappings", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_connections", key: "id" } },
        capability: { type: Sequelize.STRING(30), allowNull: false },
        sap_entity: { type: Sequelize.STRING(120), allowNull: false },
        sap_field: { type: Sequelize.STRING(120), allowNull: false },
        dms_entity: { type: Sequelize.STRING(60), allowNull: false },
        dms_field: { type: Sequelize.STRING(60), allowNull: false },
        is_key: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        transform: { type: Sequelize.STRING(60), allowNull: true },
        ...ts,
      });
      await queryInterface.addIndex("erp_entity_mappings", ["connection_id", "capability"], { name: "ix_erp_map_conn_cap" });
    }
  },

  async down(queryInterface) {
    // children first (foreign keys). Only the three Phase 13 tables are touched.
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    for (const t of ["erp_entity_mappings", "erp_connection_capabilities", "erp_connections"]) if (tables.includes(t)) await queryInterface.dropTable(t);
  },
};
