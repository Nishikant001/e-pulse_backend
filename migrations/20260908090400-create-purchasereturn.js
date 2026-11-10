"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes("PurchaseReturns")) {
      await queryInterface.createTable("PurchaseReturns", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        return_number: { type: Sequelize.STRING, allowNull: true },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        distributor_code: { type: Sequelize.STRING, allowNull: true },
        vendor_id: { type: Sequelize.INTEGER, allowNull: false },
        invoiceId: { type: Sequelize.INTEGER, allowNull: false },
        returnDate: { type: Sequelize.DATE, allowNull: false },
        reason: { type: Sequelize.STRING, allowNull: true },
        status: {
          type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
          allowNull: false,
          defaultValue: "DRAFT",
        },
        debitNoteId: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex("PurchaseReturns", ["distributor_id", "return_number"], {
        name: "uniq_purchasereturn_number_per_distributor",
        unique: true,
      });
      await queryInterface.addIndex("PurchaseReturns", ["invoiceId"], { name: "idx_purchasereturn_invoice" });
      await queryInterface.addIndex("PurchaseReturns", ["status"], { name: "idx_purchasereturn_status" });
    }

    if (!tables.includes("PurchaseReturnLines")) {
      await queryInterface.createTable("PurchaseReturnLines", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        returnId: { type: Sequelize.INTEGER, allowNull: false },
        invoiceLineId: { type: Sequelize.INTEGER, allowNull: false },
        productId: { type: Sequelize.INTEGER, allowNull: false },
        batchId: { type: Sequelize.INTEGER, allowNull: false },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        pricePerUnit: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
        reason: { type: Sequelize.STRING, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex("PurchaseReturnLines", ["returnId"], { name: "idx_prline_return" });
      await queryInterface.addIndex("PurchaseReturnLines", ["invoiceLineId"], { name: "idx_prline_invoiceline" });
    }
  },
  async down(queryInterface) {
    await queryInterface.dropTable("PurchaseReturnLines");
    await queryInterface.dropTable("PurchaseReturns");
  },
};
