module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("Customers", "customer_group", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "RETAIL",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("Customers", "customer_group");
  },
};
