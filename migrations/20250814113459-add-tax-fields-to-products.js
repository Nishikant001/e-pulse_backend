'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Products', 'gst', { type: Sequelize.DECIMAL(5, 2) });
    await queryInterface.addColumn('Products', 'sgst', { type: Sequelize.DECIMAL(5, 2) });
    await queryInterface.addColumn('Products', 'cgst', { type: Sequelize.DECIMAL(5, 2) });
    await queryInterface.addColumn('Products', 'igst', { type: Sequelize.DECIMAL(5, 2) });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Products', 'gst');
    await queryInterface.removeColumn('Products', 'sgst');
    await queryInterface.removeColumn('Products', 'cgst');
    await queryInterface.removeColumn('Products', 'igst');
  }
};
