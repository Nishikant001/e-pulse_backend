"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("SalesCreditNoteLines")) return;

    await queryInterface.createTable("SalesCreditNoteLines", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      creditNoteId: { type: Sequelize.INTEGER, allowNull: false },
      invoiceLineId: { type: Sequelize.INTEGER, allowNull: false },
      productId: { type: Sequelize.INTEGER, allowNull: false },
      batchId: { type: Sequelize.INTEGER, allowNull: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      pricePerUnit: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      taxableValue: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      cgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      sgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      igstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      lineTotal: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex("SalesCreditNoteLines", ["creditNoteId"], { name: "idx_cnline_creditnote" });
    await queryInterface.addIndex("SalesCreditNoteLines", ["invoiceLineId"], { name: "idx_cnline_invoiceline" });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("SalesCreditNoteLines");
  },
};
