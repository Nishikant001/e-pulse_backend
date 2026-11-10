"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes("SalesReturns")) {
      await queryInterface.createTable("SalesReturns", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        return_number: { type: Sequelize.STRING, allowNull: true },
        distributor_id: { type: Sequelize.INTEGER, allowNull: false },
        distributor_code: { type: Sequelize.STRING, allowNull: true },
        customerId: { type: Sequelize.INTEGER, allowNull: false },
        invoiceId: { type: Sequelize.INTEGER, allowNull: false },
        returnDate: { type: Sequelize.DATE, allowNull: false },
        reason: { type: Sequelize.STRING, allowNull: true },
        status: {
          type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
          allowNull: false,
          defaultValue: "DRAFT",
        },
        creditNoteId: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex("SalesReturns", ["distributor_id", "return_number"], {
        name: "uniq_salesreturn_number_per_distributor",
        unique: true,
      });
      await queryInterface.addIndex("SalesReturns", ["invoiceId"], { name: "idx_salesreturn_invoice" });
      await queryInterface.addIndex("SalesReturns", ["status"], { name: "idx_salesreturn_status" });
    }

    if (!tables.includes("SalesReturnLines")) {
      await queryInterface.createTable("SalesReturnLines", {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        returnId: { type: Sequelize.INTEGER, allowNull: false },
        invoiceLineId: { type: Sequelize.INTEGER, allowNull: false },
        productId: { type: Sequelize.INTEGER, allowNull: false },
        batchId: { type: Sequelize.INTEGER, allowNull: true },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        pricePerUnit: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
        reason: { type: Sequelize.STRING, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex("SalesReturnLines", ["returnId"], { name: "idx_srline_return" });
      await queryInterface.addIndex("SalesReturnLines", ["invoiceLineId"], { name: "idx_srline_invoiceline" });
      // Idempotency: same StockLedger reference (SalesReturn.id as reference_id,
      // reference_line_id = this row's id) is already guarded by the
      // uniq_stockledger_movement index from Phase 2 — no extra constraint
      // needed here.
    }
  },
  async down(queryInterface) {
    await queryInterface.dropTable("SalesReturnLines");
    await queryInterface.dropTable("SalesReturns");
  },
};
