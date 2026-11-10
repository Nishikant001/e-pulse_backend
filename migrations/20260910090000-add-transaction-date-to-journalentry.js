"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("JournalEntries");
    if (!table.transaction_date) {
      await queryInterface.addColumn("JournalEntries", "transaction_date", {
        type: Sequelize.DATE,
        allowNull: true,
      });
      // Backfill existing rows from createdAt so historical data isn't
      // left null — going forward every JournalEntry.create() call sets
      // this explicitly from the source document's own date.
      await queryInterface.sequelize.query(
        "UPDATE JournalEntries SET transaction_date = createdAt WHERE transaction_date IS NULL"
      ).catch(() => {});
    }
    await queryInterface.addIndex("JournalEntries", ["distributor_code", "transaction_date"], {
      name: "idx_journalentry_distributor_date",
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("JournalEntries", "idx_journalentry_distributor_date");
    await queryInterface.removeColumn("JournalEntries", "transaction_date");
  },
};
