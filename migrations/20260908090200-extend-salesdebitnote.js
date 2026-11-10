"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("SalesDebitNotes");
    const addIfMissing = async (name, spec) => {
      if (!table[name]) await queryInterface.addColumn("SalesDebitNotes", name, spec);
    };

    await addIfMissing("debit_note_number", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("distributor_code", { type: Sequelize.STRING, allowNull: true });
    await addIfMissing("customerId", { type: Sequelize.INTEGER, allowNull: true });
    await addIfMissing("status", {
      type: Sequelize.ENUM("DRAFT", "POSTED", "CANCELLED"),
      allowNull: false,
      defaultValue: "DRAFT",
    });
    await addIfMissing("taxableValue", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("cgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("sgstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("igstAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("totalAmount", { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 });
    await addIfMissing("postedAt", { type: Sequelize.DATE, allowNull: true });

    await queryInterface.addIndex("SalesDebitNotes", ["distributor_id", "debit_note_number"], {
      name: "uniq_debitnote_number_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("SalesDebitNotes", ["status"], { name: "idx_debitnote_status" });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("SalesDebitNotes", "idx_debitnote_status");
    await queryInterface.removeIndex("SalesDebitNotes", "uniq_debitnote_number_per_distributor");
    for (const col of [
      "postedAt", "totalAmount", "igstAmount", "sgstAmount", "cgstAmount", "taxableValue",
      "status", "customerId", "distributor_code", "debit_note_number",
    ]) {
      await queryInterface.removeColumn("SalesDebitNotes", col);
    }
  },
};
