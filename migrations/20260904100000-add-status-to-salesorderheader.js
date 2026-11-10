"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesOrderHeaders");

    if (!table.status) {
      await queryInterface.addColumn("SalesOrderHeaders", "status", {
        type: Sequelize.ENUM(
          "DRAFT",
          "CONFIRMED",
          "PARTIALLY_DELIVERED",
          "FULLY_DELIVERED",
          "CANCELLED",
          "CLOSED"
        ),
        allowNull: false,
        defaultValue: "DRAFT",
      });
    }
    if (!table.expectedDeliveryDate) {
      await queryInterface.addColumn("SalesOrderHeaders", "expectedDeliveryDate", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table.billingAddress) {
      await queryInterface.addColumn("SalesOrderHeaders", "billingAddress", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!table.shippingAddress) {
      await queryInterface.addColumn("SalesOrderHeaders", "shippingAddress", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    // Backfill: every pre-existing order (created before this migration) had
    // no lifecycle concept at all. Treat it as CONFIRMED so it keeps
    // behaving the way the app already treated it (deliverable), rather
    // than silently becoming un-deliverable DRAFT stock. Only relevant if
    // the column was just added without a default already applying to
    // existing rows (MySQL backfills the DEFAULT on ADD COLUMN, so this is
    // a no-op safety net for other dialects).
    await queryInterface.sequelize.query(
      "UPDATE SalesOrderHeaders SET status = 'CONFIRMED' WHERE status IS NULL"
    ).catch(() => {});

    await queryInterface.addIndex("SalesOrderHeaders", ["status"], {
      name: "idx_salesorderheader_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("SalesOrderHeaders", "idx_salesorderheader_status");
    await queryInterface.removeColumn("SalesOrderHeaders", "shippingAddress");
    await queryInterface.removeColumn("SalesOrderHeaders", "billingAddress");
    await queryInterface.removeColumn("SalesOrderHeaders", "expectedDeliveryDate");
    await queryInterface.removeColumn("SalesOrderHeaders", "status");
    // MySQL's ENUM is stored inline on the column (not a separate type),
    // so there is no separate type object to drop, unlike Postgres.
  },
};
