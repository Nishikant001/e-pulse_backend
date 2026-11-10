"use strict";

// e-Pulse Phase 1 — Purchase Orders no longer need a vendor. PurchaseOrderHeaders.vendorId becomes NULLable.
// Nothing else changes: existing rows keep their vendorId, the FK stays, no data is touched.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("PurchaseOrderHeaders");
    if (table.vendorId && table.vendorId.allowNull === false) {
      await queryInterface.changeColumn("PurchaseOrderHeaders", "vendorId", { type: Sequelize.INTEGER, allowNull: true });
    }
  },

  async down(queryInterface, Sequelize) {
    // Cannot restore NOT NULL while vendor-less POs exist; refuse rather than invent a vendor.
    const [rows] = await queryInterface.sequelize.query("SELECT COUNT(*) AS c FROM PurchaseOrderHeaders WHERE vendorId IS NULL");
    if (Number(rows[0] && rows[0].c) > 0) throw new Error("Cannot revert: vendor-less purchase orders exist");
    await queryInterface.changeColumn("PurchaseOrderHeaders", "vendorId", { type: Sequelize.INTEGER, allowNull: false });
  },
};
