"use strict";

// PHASE 4 — additive migration: SAP synchronisation status for sales documents.
// Creates one new table; reads/alters/deletes nothing that exists. `down` drops only this table.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("sap_sync_records")) return; // idempotent

    await queryInterface.createTable("sap_sync_records", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      distributor_id: { type: Sequelize.INTEGER, allowNull: false },
      entity_type: { type: Sequelize.STRING(30), allowNull: false },
      entity_id: { type: Sequelize.INTEGER, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "PENDING" },
      sap_document_no: { type: Sequelize.STRING(40), allowNull: true },
      last_attempt_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("sap_sync_records", ["entity_type", "entity_id"], { unique: true, name: "uq_sap_sync_entity" });
    await queryInterface.addIndex("sap_sync_records", ["status"], { name: "ix_sap_sync_status" });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("sap_sync_records");
  },
};
