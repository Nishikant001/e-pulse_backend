"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("PurchaseInvoiceHeaders");
    const addIfMissing = async (name, spec) => {
      if (!table[name]) {
        await queryInterface.addColumn("PurchaseInvoiceHeaders", name, spec);
      }
    };

    await addIfMissing("invoice_number", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("distributor_code", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("status", {
      type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
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

    // Existing rows (created by the pre-Phase-4 controller, which posted
    // accounting synchronously on create) are backfilled to POSTED so they
    // aren't stuck as an un-postable DRAFT with accounting entries already
    // sitting in JournalEntries for them.
    await queryInterface.sequelize.query(
      "UPDATE PurchaseInvoiceHeaders SET status = 'POSTED', outstandingAmount = totalAmount WHERE status IS NULL OR status = 'DRAFT'"
    ).catch(() => {});

    await queryInterface.addIndex("PurchaseInvoiceHeaders", ["deliveryId"], {
      name: "uniq_purchaseinvoice_delivery",
      unique: true,
    });
    await queryInterface.addIndex("PurchaseInvoiceHeaders", ["distributor_id", "invoice_number"], {
      name: "uniq_purchaseinvoice_number_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("PurchaseInvoiceHeaders", ["status"], {
      name: "idx_purchaseinvoice_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("PurchaseInvoiceHeaders", "idx_purchaseinvoice_status");
    await queryInterface.removeIndex("PurchaseInvoiceHeaders", "uniq_purchaseinvoice_number_per_distributor");
    await queryInterface.removeIndex("PurchaseInvoiceHeaders", "uniq_purchaseinvoice_delivery");
    for (const col of [
      "postedAt", "outstandingAmount", "dueDate", "roundOff", "igstAmount",
      "sgstAmount", "cgstAmount", "netValue", "status", "distributor_code", "invoice_number",
    ]) {
      await queryInterface.removeColumn("PurchaseInvoiceHeaders", col);
    }
  },
};
