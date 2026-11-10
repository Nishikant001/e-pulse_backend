'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Batches', 'material_code', {
      type: Sequelize.STRING,
      allowNull: false,
    });

    await queryInterface.addColumn('Batches', 'quantity', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.addColumn('Batches', 'status', {
      type: Sequelize.ENUM("available", "sold", "damaged"),
      allowNull: false,
      defaultValue: "available",
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Batches', 'material_code');
    await queryInterface.removeColumn('Batches', 'quantity');
    await queryInterface.removeColumn('Batches', 'status');

    // Drop ENUM type explicitly (important for Postgres, safe for MySQL too)
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Batches_status";');
  }
};
