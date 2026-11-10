"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesCreditNotes");
    const addIfMissing = async (name, spec) => {
      if (!table[name]) await queryInterface.addColumn("SalesCreditNotes", name, spec);
    };

    await addIfMissing("credit_note_number", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("distributor_code", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("customerId", { type: Sequelize.INTEGER, allowNull: true });
    await addIfMissing("sourceReturnId", { type: Sequelize.INTEGER, allowNull: true });
    await addIfMissing("status", {
      type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    });
    await addIfMissing("netValue", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("cgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("sgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("igstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("totalAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("postedAt", { type: Sequelize.DATE, allowNull: true });

    await queryInterface.addIndex("SalesCreditNotes", ["distributor_id", "credit_note_number"], {
      name: "uniq_creditnote_number_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("SalesCreditNotes", ["invoiceId"], { name: "idx_creditnote_invoice" });
    await queryInterface.addIndex("SalesCreditNotes", ["status"], { name: "idx_creditnote_status" });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("SalesCreditNotes", "idx_creditnote_status");
    await queryInterface.removeIndex("SalesCreditNotes", "idx_creditnote_invoice");
    await queryInterface.removeIndex("SalesCreditNotes", "uniq_creditnote_number_per_distributor");
    for (const col of [
      "postedAt", "totalAmount", "igstAmount", "sgstAmount", "cgstAmount", "netValue",
      "status", "sourceReturnId", "customerId", "distributor_code", "credit_note_number",
    ]) {
      await queryInterface.removeColumn("SalesCreditNotes", col);
    }
  },
};
