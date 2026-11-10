"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("PurchaseOrderHeaders");

    if (!table.status) {
      await queryInterface.addColumn("PurchaseOrderHeaders", "status", {
        type: Sequelize.ENUM(
          "DRAFT",
          "CONFIRMED",
          "PARTIALLY_RECEIVED",
          "FULLY_RECEIVED",
          "CANCELLED",
          "CLOSED"
        ),
        allowNull: false,
        defaultValue: "DRAFT",
      });
    }

    // Backfill: pre-existing POs had no lifecycle concept and were already
    // deliverable in production, so treat them as CONFIRMED rather than
    // silently making them un-deliverable DRAFT stock (mirrors the same
    // backfill done for SalesOrderHeader in Phase 3).
    await queryInterface.sequelize.query(
      "UPDATE PurchaseOrderHeaders SET status = 'CONFIRMED' WHERE status IS NULL"
    ).catch(() => {});

    await queryInterface.addIndex("PurchaseOrderHeaders", ["status"], {
      name: "idx_purchaseorderheader_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("PurchaseOrderHeaders", "idx_purchaseorderheader_status");
    await queryInterface.removeColumn("PurchaseOrderHeaders", "status");
  },
};
