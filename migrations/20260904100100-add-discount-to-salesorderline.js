"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesOrderLines");
    if (!table.discount) {
      await queryInterface.addColumn("SalesOrderLines", "discount", {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("SalesOrderLines", "discount");
  },
};
