"use strict";

// PurchaseDeliveryLine's controller has always passed `pricePerUnit` on
// create, but the Sequelize model never declared that column, so it was
// silently dropped (Sequelize only persists declared attributes). This
// meant purchase-invoice totals downstream were computed from `undefined`
// (i.e. NaN) even though the data looked fine in the delivery response.
// This migration adds the real column and backfills existing rows from
// their originating PurchaseOrderLine so historical data isn't left null.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("PurchaseDeliveryLines");
    if (!table.pricePerUnit) {
      await queryInterface.addColumn("PurchaseDeliveryLines", "pricePerUnit", {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE PurchaseDeliveryLines pdl
      JOIN PurchaseOrderLines pol ON pdl.orderLineId = pol.id
      SET pdl.pricePerUnit = pol.pricePerUnit
      WHERE pdl.pricePerUnit IS NULL
    `).catch(() => {
      // Non-MySQL test dialects (sqlite) don't support multi-table UPDATE
      // JOIN syntax; backfill is a no-op there since tests always create
      // pricePerUnit explicitly going forward.
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("PurchaseDeliveryLines", "pricePerUnit");
  },
};
