"use strict";

// Phase 14 — Generic ERP Sync Management. ADDITIVE except two vendor-neutral RENAMES; idempotent and reversible.
//   erp_connections + provider, auth_header_name, config · erp_connection_capabilities + config
//   erp_entity_mappings: sap_entity → source_entity, sap_field → source_field (no API/UI/data existed in Phase 13)
//   NEW erp_sync_jobs, erp_sync_errors, erp_external_links
//   DATA: directions SAP_TO_DMS/DMS_TO_SAP → ERP_TO_DMS/DMS_TO_ERP; stored last_test_code values → neutral error names
// sap_sync_records (Phase 4) is untouched. `down` restores the Phase 13 shape and drops only what this migration created.
const DIR = [["SAP_TO_DMS", "ERP_TO_DMS"], ["DMS_TO_SAP", "DMS_TO_ERP"]];
const CODES = [["CONFIGURATION_ERROR", "INVALID_CONFIGURATION"], ["CONNECTION_TIMEOUT", "TIMEOUT"], ["NETWORK_ERROR", "CONNECTION_ERROR"], ["SAP_SERVER_ERROR", "SERVER_ERROR"], ["SAP_REQUEST_REJECTED", "REQUEST_REJECTED"]];

module.exports = {
  async up(qi, Sequelize) {
    const tables = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const ts = { createdAt: { type: Sequelize.DATE, allowNull: false }, updatedAt: { type: Sequelize.DATE, allowNull: false } };
    const addCol = async (t, c, def) => { if (tables.includes(t) && !(await cols(t)).includes(c)) await qi.addColumn(t, c, def); };

    await addCol("erp_connections", "provider", { type: Sequelize.STRING(30), allowNull: true });
    await addCol("erp_connections", "auth_header_name", { type: Sequelize.STRING(64), allowNull: true });
    await addCol("erp_connections", "config", { type: Sequelize.JSON, allowNull: true });
    await addCol("erp_connection_capabilities", "config", { type: Sequelize.JSON, allowNull: true });

    if (tables.includes("erp_entity_mappings")) {
      const c = await cols("erp_entity_mappings");
      if (c.includes("sap_entity") && !c.includes("source_entity")) await qi.renameColumn("erp_entity_mappings", "sap_entity", "source_entity");
      if (c.includes("sap_field") && !c.includes("source_field")) await qi.renameColumn("erp_entity_mappings", "sap_field", "source_field");
      if (c.includes("transform")) await qi.changeColumn("erp_entity_mappings", "transform", { type: Sequelize.STRING(120), allowNull: true });
    }

    if (!tables.includes("erp_sync_jobs")) {
      await qi.createTable("erp_sync_jobs", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_connections", key: "id" } },
        provider: { type: Sequelize.STRING(30), allowNull: true },
        erp_type: { type: Sequelize.STRING(20), allowNull: true },
        capability: { type: Sequelize.STRING(30), allowNull: false },
        direction: { type: Sequelize.STRING(20), allowNull: false },
        trigger_type: { type: Sequelize.STRING(12), allowNull: false, defaultValue: "MANUAL" },
        status: { type: Sequelize.STRING(12), allowNull: false, defaultValue: "QUEUED" },
        correlation_id: { type: Sequelize.STRING(40), allowNull: true },
        scope: { type: Sequelize.JSON, allowNull: true },
        retry_of_job_id: { type: Sequelize.INTEGER, allowNull: true },
        attempt: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        active_key: { type: Sequelize.STRING(120), allowNull: true },
        heartbeat_at: { type: Sequelize.DATE, allowNull: true },
        started_at: { type: Sequelize.DATE, allowNull: true },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        total_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        processed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        success_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        updated_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        failed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        skipped_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        error_code: { type: Sequelize.STRING(40), allowNull: true },
        error_message: { type: Sequelize.STRING(255), allowNull: true },
        requested_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        ...ts,
      });
      await qi.addIndex("erp_sync_jobs", ["active_key"], { unique: true, name: "uq_erp_job_active_key" });
      await qi.addIndex("erp_sync_jobs", ["tenant_key", "connection_id"], { name: "ix_erp_job_tenant_conn" });
      await qi.addIndex("erp_sync_jobs", ["tenant_key", "status"], { name: "ix_erp_job_tenant_status" });
    }
    if (!tables.includes("erp_sync_errors")) {
      await qi.createTable("erp_sync_errors", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        job_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_sync_jobs", key: "id" } },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        record_index: { type: Sequelize.INTEGER, allowNull: true },
        external_id: { type: Sequelize.STRING(190), allowNull: true },
        error_code: { type: Sequelize.STRING(40), allowNull: false },
        message: { type: Sequelize.STRING(500), allowNull: false },
        retryable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        ...ts,
      });
      await qi.addIndex("erp_sync_errors", ["job_id"], { name: "ix_erp_err_job" });
    }
    if (!tables.includes("erp_external_links")) {
      await qi.createTable("erp_external_links", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: "erp_connections", key: "id" } },
        entity_type: { type: Sequelize.STRING(30), allowNull: false },
        external_id: { type: Sequelize.STRING(190), allowNull: false },
        scope_key: { type: Sequelize.STRING(60), allowNull: false, defaultValue: "" },
        dms_entity_id: { type: Sequelize.INTEGER, allowNull: false },
        content_hash: { type: Sequelize.STRING(64), allowNull: true },
        last_synced_at: { type: Sequelize.DATE, allowNull: true },
        last_job_id: { type: Sequelize.INTEGER, allowNull: true },
        ...ts,
      });
      await qi.addIndex("erp_external_links", ["connection_id", "entity_type", "external_id", "scope_key"], { unique: true, name: "uq_erp_link_identity" });
      await qi.addIndex("erp_external_links", ["entity_type", "dms_entity_id"], { name: "ix_erp_link_dms" });
    }

    if (tables.includes("erp_connection_capabilities")) for (const [from, to] of DIR) await qi.bulkUpdate("erp_connection_capabilities", { direction: to }, { direction: from });
    if (tables.includes("erp_connections")) for (const [from, to] of CODES) await qi.bulkUpdate("erp_connections", { last_test_code: to }, { last_test_code: from });
  },

  async down(qi) {
    const tables = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    if (tables.includes("erp_connection_capabilities")) for (const [from, to] of DIR) await qi.bulkUpdate("erp_connection_capabilities", { direction: from }, { direction: to });
    if (tables.includes("erp_connections")) for (const [from, to] of CODES) await qi.bulkUpdate("erp_connections", { last_test_code: from }, { last_test_code: to });
    for (const t of ["erp_sync_errors", "erp_sync_jobs", "erp_external_links"]) if (tables.includes(t)) await qi.dropTable(t);
    if (tables.includes("erp_entity_mappings")) {
      const c = await cols("erp_entity_mappings");
      if (c.includes("source_entity") && !c.includes("sap_entity")) await qi.renameColumn("erp_entity_mappings", "source_entity", "sap_entity");
      if (c.includes("source_field") && !c.includes("sap_field")) await qi.renameColumn("erp_entity_mappings", "source_field", "sap_field");
    }
    const dropCol = async (t, c) => { if (tables.includes(t) && (await cols(t)).includes(c)) await qi.removeColumn(t, c); };
    await dropCol("erp_connection_capabilities", "config");
    for (const c of ["config", "auth_header_name", "provider"]) await dropCol("erp_connections", c);
  },
};
