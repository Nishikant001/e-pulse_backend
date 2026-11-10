"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("PurchaseDebitNotes")) return;

    await queryInterface.createTable("PurchaseDebitNotes", {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      debit_note_number: { type: Sequelize.STRING, allowNull: true },
      distributor_id: { type: Sequelize.INTEGER, allowNull: false },
      distributor_code: { type: Sequelize.STRING, allowNull: true },
      vendor_id: { type: Sequelize.INTEGER, allowNull: false },
      invoiceId: { type: Sequelize.INTEGER, allowNull: true },
      sourceReturnId: { type: Sequelize.INTEGER, allowNull: true },
      reason: { type: Sequelize.STRING, allowNull: true },
      status: {
        type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
        allowNull: false,
        defaultValue: "DRAFT",
      },
      taxableValue: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      cgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      sgstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      igstAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      totalAmount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      postedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex("PurchaseDebitNotes", ["distributor_id", "debit_note_number"], {
      name: "uniq_purchase_debitnote_number_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("PurchaseDebitNotes", ["status"], { name: "idx_purchase_debitnote_status" });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("PurchaseDebitNotes");
  },
};
