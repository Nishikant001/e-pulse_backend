"use strict";

// Phase 16 — ownership, code mappings, persistent audit, outbound foundation, imported-order identity. ADDITIVE, idempotent and reversible.
//   erp_connection_capabilities + ownership        (ERP_OWNED | DMS_OWNED | SHARED, NULL = undecided)
//   erp_external_links          + dms_value        (value-type code mappings, e.g. payment mode)
//   NEW erp_audit_events        (append-only audit)      NEW erp_outbound_events (DMS → ERP writes, UNIQUE idempotency key)
//   SalesOrderHeaders           + external_source_type / external_source_id and a UNIQUE (distributor_id, source type, source id)
// No existing column is altered or dropped; no data is changed. `down` removes only what this migration created.
module.exports = {
  async up(qi, Sequelize) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = async (t) => (await tables()).includes(t);
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const indexes = async (t) => (await qi.showIndex(t)).map((i) => i.name);
    const addCol = async (t, c, def) => { if ((await has(t)) && !(await cols(t)).includes(c)) await qi.addColumn(t, c, def); };
    const addIx = async (t, f, o) => { if ((await has(t)) && !(await indexes(t)).includes(o.name)) await qi.addIndex(t, f, o); };

    await addCol("erp_connection_capabilities", "ownership", { type: Sequelize.STRING(12), allowNull: true });
    await addCol("erp_external_links", "dms_value", { type: Sequelize.STRING(120), allowNull: true });

    if (!(await has("erp_audit_events"))) {
      await qi.createTable("erp_audit_events", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        actor_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        event: { type: Sequelize.STRING(40), allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: true },
        erp_code: { type: Sequelize.STRING(60), allowNull: true },
        provider: { type: Sequelize.STRING(30), allowNull: true },
        capability: { type: Sequelize.STRING(30), allowNull: true },
        entity_type: { type: Sequelize.STRING(30), allowNull: true },
        entity_id: { type: Sequelize.STRING(190), allowNull: true },
        status: { type: Sequelize.STRING(12), allowNull: true },
        correlation_id: { type: Sequelize.STRING(40), allowNull: true },
        metadata: { type: Sequelize.JSON, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
    }
    await addIx("erp_audit_events", ["tenant_key", "createdAt"], { name: "ix_erp_audit_tenant_time" });
    await addIx("erp_audit_events", ["tenant_key", "event"], { name: "ix_erp_audit_tenant_event" });
    await addIx("erp_audit_events", ["tenant_key", "connection_id", "capability"], { name: "ix_erp_audit_tenant_conn_cap" });
    await addIx("erp_audit_events", ["correlation_id"], { name: "ix_erp_audit_corr" });

    if (!(await has("erp_outbound_events"))) {
      await qi.createTable("erp_outbound_events", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        tenant_key: { type: Sequelize.STRING(40), allowNull: false },
        connection_id: { type: Sequelize.INTEGER, allowNull: false },
        capability: { type: Sequelize.STRING(30), allowNull: false },
        entity_type: { type: Sequelize.STRING(30), allowNull: false },
        entity_id: { type: Sequelize.STRING(60), allowNull: false },
        operation: { type: Sequelize.STRING(8), allowNull: false },
        idempotency_key: { type: Sequelize.STRING(190), allowNull: false },
        status: { type: Sequelize.STRING(12), allowNull: false, defaultValue: "PENDING" },
        attempt: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        external_id: { type: Sequelize.STRING(190), allowNull: true },
        error_code: { type: Sequelize.STRING(40), allowNull: true },
        error_message: { type: Sequelize.STRING(255), allowNull: true },
        correlation_id: { type: Sequelize.STRING(40), allowNull: true },
        requested_by_admin_id: { type: Sequelize.INTEGER, allowNull: true },
        sent_at: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
    }
    await addIx("erp_outbound_events", ["idempotency_key"], { unique: true, name: "uq_erp_outbound_idem" });
    await addIx("erp_outbound_events", ["tenant_key", "connection_id", "status"], { name: "ix_erp_outbound_tenant_conn" });

    await addCol("SalesOrderHeaders", "external_source_type", { type: Sequelize.STRING(40), allowNull: true });
    await addCol("SalesOrderHeaders", "external_source_id", { type: Sequelize.STRING(190), allowNull: true });
    await addIx("SalesOrderHeaders", ["distributor_id", "external_source_type", "external_source_id"], { unique: true, name: "uq_sales_order_external_source" });
  },

  async down(qi) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    const has = async (t) => (await tables()).includes(t);
    const cols = async (t) => Object.keys(await qi.describeTable(t));
    const indexes = async (t) => (await qi.showIndex(t)).map((i) => i.name);
    if (await has("SalesOrderHeaders")) {
      if ((await indexes("SalesOrderHeaders")).includes("uq_sales_order_external_source")) await qi.removeIndex("SalesOrderHeaders", "uq_sales_order_external_source");
      for (const c of ["external_source_id", "external_source_type"]) if ((await cols("SalesOrderHeaders")).includes(c)) await qi.removeColumn("SalesOrderHeaders", c);
    }
    if (await has("erp_outbound_events")) await qi.dropTable("erp_outbound_events");
    if (await has("erp_audit_events")) await qi.dropTable("erp_audit_events");
    if ((await has("erp_external_links")) && (await cols("erp_external_links")).includes("dms_value")) await qi.removeColumn("erp_external_links", "dms_value");
    if ((await has("erp_connection_capabilities")) && (await cols("erp_connection_capabilities")).includes("ownership")) await qi.removeColumn("erp_connection_capabilities", "ownership");
  },
};
