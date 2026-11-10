"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("PurchaseInvoiceLines")) return;

    await queryInterface.createTable("PurchaseInvoiceLines", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      invoiceId: { type: Sequelize.INTEGER, allowNull: false },
      productId: { type: Sequelize.INTEGER, allowNull: false },
      orderLineId: { type: Sequelize.INTEGER, allowNull: true },
      deliveryLineId: { type: Sequelize.INTEGER, allowNull: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      pricePerUnit: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      discount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      taxableValue: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      cgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      sgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      igstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      lineTotal: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex("PurchaseInvoiceLines", ["invoiceId"], { name: "idx_pinvline_invoice" });
    await queryInterface.addIndex("PurchaseInvoiceLines", ["productId"], { name: "idx_pinvline_product" });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("PurchaseInvoiceLines");
  },
};
