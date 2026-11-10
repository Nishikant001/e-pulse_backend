"use strict";

// Phase 25 — Super Admin dashboard. ADDITIVE ONLY: one nullable column + index on Distributors.
// created_by_admin_id records which admin created a distributor through the Admin portal. Existing rows, self-signups
// and everything created before this migration stay NULL ("unassigned"). No foreign key (same style as the other
// Admin-portal columns), so removing an admin never touches distributor rows. Idempotent and reversible.
const INDEX = "distributors_created_by_admin_id";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Distributors");
    if (!table.created_by_admin_id) {
      await queryInterface.addColumn("Distributors", "created_by_admin_id", { type: Sequelize.INTEGER, allowNull: true });
    }
    const idx = (await queryInterface.showIndex("Distributors")).map((i) => i.name);
    if (!idx.includes(INDEX)) await queryInterface.addIndex("Distributors", ["created_by_admin_id"], { name: INDEX });
  },

  async down(queryInterface) {
    const idx = (await queryInterface.showIndex("Distributors")).map((i) => i.name);
    if (idx.includes(INDEX)) await queryInterface.removeIndex("Distributors", INDEX);
    const table = await queryInterface.describeTable("Distributors");
    if (table.created_by_admin_id) await queryInterface.removeColumn("Distributors", "created_by_admin_id");
  },
};
