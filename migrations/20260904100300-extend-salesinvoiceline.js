"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesInvoiceLines");
    const addIfMissing = async (name, spec) => {
      if (!table[name]) {
        await queryInterface.addColumn("SalesInvoiceLines", name, spec);
      }
    };

    await addIfMissing("orderLineId", { type: Sequelize.INTEGER, allowNull: true });
    await addIfMissing("deliveryLineId", { type: Sequelize.INTEGER, allowNull: true });
    await addIfMissing("discount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("taxableValue", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("cgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("sgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("igstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
  },
  async down(queryInterface) {
    for (const col of [
      "igstAmount", "sgstAmount", "cgstAmount", "taxableValue", "discount", "deliveryLineId", "orderLineId",
    ]) {
      await queryInterface.removeColumn("SalesInvoiceLines", col);
    }
  },
};
