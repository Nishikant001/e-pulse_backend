"use strict";

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex("Batches", ["distributor_id"], {
      name: "idx_batches_distributor",
    });
    await queryInterface.addIndex("Batches", ["productId"], {
      name: "idx_batches_product",
    });
    await queryInterface.addIndex("Batches", ["exp_date"], {
      name: "idx_batches_exp_date",
    });
    await queryInterface.addIndex("Batches", ["status"], {
      name: "idx_batches_status",
    });
    // Composite index matching the exact FEFO query pattern:
    // WHERE productId = ? AND distributor_id = ? AND status = 'active'
    // ORDER BY exp_date ASC
    await queryInterface.addIndex(
      "Batches",
      ["productId", "distributor_id", "status", "exp_date"],
      { name: "idx_batches_fefo" }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("Batches", "idx_batches_fefo");
    await queryInterface.removeIndex("Batches", "idx_batches_status");
    await queryInterface.removeIndex("Batches", "idx_batches_exp_date");
    await queryInterface.removeIndex("Batches", "idx_batches_product");
    await queryInterface.removeIndex("Batches", "idx_batches_distributor");
  },
};
