"use strict";

// JournalEntry.reference_no stores a document's numeric id, but different
// document types (SalesInvoiceHeader, SalesCreditNote, PurchaseInvoiceHeader,
// etc.) each have their own independent auto-increment counter — so a
// Sales Invoice #1 and a Sales Credit Note #1 can both legitimately exist,
// and a query filtering only by reference_no would silently merge their
// journal entries. This adds a discriminator so queries can (and, from
// this phase forward, do) filter by both.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("JournalEntries");
    if (!table.reference_type) {
      await queryInterface.addColumn("JournalEntries", "reference_type", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    await queryInterface.addIndex("JournalEntries", ["reference_type", "reference_no"], {
      name: "idx_journalentry_reference",
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("JournalEntries", "idx_journalentry_reference");
    await queryInterface.removeColumn("JournalEntries", "reference_type");
  },
};
