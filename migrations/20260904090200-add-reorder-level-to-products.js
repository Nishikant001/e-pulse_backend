"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Products");
    if (!table.reorder_level) {
      await queryInterface.addColumn("Products", "reorder_level", {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 10,
      });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("Products", "reorder_level");
  },
};
