"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesInvoiceHeaders");

    const addIfMissing = async (name, spec) => {
      if (!table[name]) {
        await queryInterface.addColumn("SalesInvoiceHeaders", name, spec);
      }
    };

    await addIfMissing("invoice_number", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("distributor_code", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("status", {
      type: Sequelize.ENUM("DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    });
    await addIfMissing("netValue", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("cgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("sgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("igstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("roundOff", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("dueDate", { type: Sequelize.DATE, allowNull: true });
    await addIfMissing("outstandingAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("postedAt", { type: Sequelize.DATE, allowNull: true });

    // One invoice per delivery — enforces the "duplicate invoice" business
    // rule at the DB level, not just in application code.
    await queryInterface.addIndex("SalesInvoiceHeaders", ["deliveryId"], {
      name: "uniq_salesinvoice_delivery",
      unique: true,
    });
    // invoice_number must be unique per distributor (not globally, since
    // multiple distributors number their own invoices independently).
    await queryInterface.addIndex("SalesInvoiceHeaders", ["distributor_id", "invoice_number"], {
      name: "uniq_salesinvoice_number_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("SalesInvoiceHeaders", ["status"], {
      name: "idx_salesinvoice_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("SalesInvoiceHeaders", "idx_salesinvoice_status");
    await queryInterface.removeIndex("SalesInvoiceHeaders", "uniq_salesinvoice_number_per_distributor");
    await queryInterface.removeIndex("SalesInvoiceHeaders", "uniq_salesinvoice_delivery");
    for (const col of [
      "postedAt", "outstandingAmount", "dueDate", "roundOff", "igstAmount",
      "sgstAmount", "cgstAmount", "netValue", "status", "distributor_code", "invoice_number",
    ]) {
      await queryInterface.removeColumn("SalesInvoiceHeaders", col);
    }
    // MySQL's ENUM is inline on the column; no separate type to drop.
  },
};
