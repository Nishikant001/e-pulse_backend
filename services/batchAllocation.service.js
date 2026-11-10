// services/batchAllocation.service.js
//
// DEPRECATED: superseded by services/inventory.service.js, which is now the
// single source of truth for stock availability and FEFO allocation
// (tenant-scoped, excludes expired/inactive batches, transaction-aware).
// This shim is kept only for backward compatibility with any external
// caller of the old function signature.
const inventory = require("./inventory.service");

exports.getAvailableBatchesFEFO = async (productId, distributorId, transaction) => {
  const results = await inventory.getAvailableBatches({
    productId,
    distributorId,
    transaction,
  });
  return results.map(({ batch, available }) => ({ batch, available_qty: available }));
};
