"use strict";

// Phase 6 — FEFO & Expiry Management. No new tables and no new columns: everything Phase 6 needed (an extra
// non-saleable reason, expiry buckets, FEFO priority ranking) is derived in application code from data Phase 5
// already stores. The ONLY database change is one additive composite index that the new query patterns benefit from:
//
//   - inventory.service.getAvailableBatches (FEFO order) filters Batches by (distributor_id, productId) and orders by
//     exp_date — already indexed individually (Phase 5), but not as one composite.
//   - inventoryQuery.service's new `priority` column (FEFO Monitor) and `bucket`/expFrom/expTo filters (Near Expiry
//     page) filter/sort on the same three columns together.
//
// Rollback removes exactly this index.
module.exports = {
  async up(queryInterface) {
    const existing = await queryInterface.showIndex("Batches");
    if (!existing.some((i) => i.name === "idx_batches_dist_product_exp")) {
      await queryInterface.addIndex("Batches", ["distributor_id", "productId", "exp_date"], { name: "idx_batches_dist_product_exp" });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("Batches", "idx_batches_dist_product_exp");
  },
};
