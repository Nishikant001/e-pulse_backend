// services/inventory.service.js
//
// StockLedger is the SINGLE SOURCE OF TRUTH for physical inventory.
// Current stock for a batch/product = SUM(IN) - SUM(OUT) + SUM(ADJUST,
// where ADJUST quantity can be signed via movement direction encoded in
// reference_type/quantity — here we keep it simple: IN increases, OUT
// decreases, and adjustments are posted as IN or OUT with an ADJUSTMENT-
// family reference_type).
//
// Batch.quantity (if the column still physically exists in the database
// from a legacy migration) is NOT part of the Sequelize model and MUST
// NEVER be read or written by application code. It is dead/deprecated
// and non-authoritative. Do not resurrect it.

//
// Phase 5 (additive) — pharma-ready without a second engine:
//   * StockLedger rows now optionally carry `warehouse_id` (NULL = the distributor's default/dispatch warehouse) and
//     `stock_state` (SALEABLE | NON_SALEABLE, default SALEABLE). "Available" everywhere in this file means SALEABLE-state stock,
//     so non-saleable stock can never be allocated to a sale, yet it stays on the ledger and is fully traceable.
//   * Existing callers pass no warehouse and post SALEABLE stock, so their behaviour is unchanged.
//   * Sales ship from the distributor's default (dispatch) warehouse unless a warehouse is given.

const db = require("../models");
const { Op } = require("sequelize");
const rules = require("./inventoryRules.service");

const SALEABLE = "SALEABLE";
const NON_SALEABLE = "NON_SALEABLE";

class InsufficientStockError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "InsufficientStockError";
    this.statusCode = 400;
    this.details = details;
  }
}

class InventoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryValidationError";
    this.statusCode = 400;
  }
}

const ADJUSTMENT_REFERENCE_TYPES = [
  "OPENING",
  "DAMAGE",
  "EXPIRY",
  "BREAKAGE",
  "PHYSICAL_COUNT",
  "CORRECTION",
  "ADJUSTMENT",
];

/**
 * Sum signed stock movements for a set of ledger rows.
 */
function sumMovements(rows) {
  let balance = 0;
  for (const r of rows) {
    balance += r.movement_type === "OUT" ? -r.quantity : r.quantity;
  }
  return balance;
}

// ── Warehouses ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The distributor's default (dispatch) warehouse, created on first use. Race-safe: a concurrent creator hits the
 * (distributor_id, code) unique index and we simply re-read.
 */
async function ensureDefaultWarehouse({ distributorId, transaction }) {
  let wh = await db.Warehouse.findOne({ where: { distributor_id: distributorId, is_default: true }, transaction });
  if (wh) return wh;
  const main = await db.Warehouse.findOne({ where: { distributor_id: distributorId, code: "MAIN" }, transaction });
  if (main) {
    await main.update({ is_default: true, status: "active" }, { transaction });
    return main;
  }
  try {
    wh = await db.Warehouse.create(
      { distributor_id: distributorId, code: "MAIN", name: "Main Warehouse", is_default: true, status: "active" },
      { transaction }
    );
  } catch (err) {
    wh = await db.Warehouse.findOne({ where: { distributor_id: distributorId, code: "MAIN" }, transaction });
    if (!wh) throw err;
  }
  return wh;
}

/** Validate a warehouse belongs to the distributor and is active; without an id, the default warehouse. */
async function resolveWarehouse({ distributorId, warehouseId = null, transaction }) {
  if (warehouseId === null || warehouseId === undefined || warehouseId === "") {
    return ensureDefaultWarehouse({ distributorId, transaction });
  }
  const wh = await db.Warehouse.findOne({ where: { id: warehouseId, distributor_id: distributorId }, transaction });
  if (!wh) throw new InventoryValidationError("Invalid warehouse for this distributor");
  if (wh.status !== "active") throw new InventoryValidationError(`Warehouse ${wh.code} is not active`);
  return wh;
}

/**
 * Read-only lookup of the dispatch warehouse id (never creates one). null = the distributor has no warehouse rows yet, in
 * which case every ledger row is legacy/NULL and "all warehouses" == "the default warehouse".
 */
async function getDispatchWarehouseId({ distributorId, transaction }) {
  const wh = await db.Warehouse.findOne({ where: { distributor_id: distributorId, is_default: true }, attributes: ["id"], transaction });
  return wh ? wh.id : null;
}

// Ledger predicate for "stock that is in this warehouse": legacy NULL rows belong to the default warehouse.
function warehouseClause(wh) {
  if (!wh) return {};
  return wh.is_default
    ? { [Op.or]: [{ warehouse_id: wh.id }, { warehouse_id: null }] }
    : { warehouse_id: wh.id };
}
async function warehouseClauseFor({ distributorId, warehouseId, transaction }) {
  if (warehouseId === null || warehouseId === undefined) return {}; // all warehouses (legacy behaviour)
  const wh = await db.Warehouse.findOne({ where: { id: warehouseId, distributor_id: distributorId }, transaction });
  if (!wh) throw new InventoryValidationError("Invalid warehouse for this distributor");
  return warehouseClause(wh);
}

async function stateBalance({ where, transaction }) {
  const rows = await db.StockLedger.findAll({
    where,
    attributes: ["movement_type", "quantity"],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  return sumMovements(rows);
}

/**
 * SALEABLE-state quantity for a single batch, scoped to a distributor (and optionally one warehouse; omitted = all).
 * Uses a row lock on the ledger rows within the given transaction to reduce race conditions between concurrent OUT postings.
 * This is the quantity a sale may consume — non-saleable stock is excluded by construction.
 */
async function getBatchAvailableQty({ batchId, distributorId, warehouseId = null, transaction }) {
  const wc = await warehouseClauseFor({ distributorId, warehouseId, transaction });
  return stateBalance({
    where: { [Op.and]: [{ batchId, distributor_id: distributorId, stock_state: SALEABLE }, wc] },
    transaction,
  });
}

/** NON_SALEABLE-state quantity for a batch (optionally one warehouse and/or one reason). */
async function getBatchNonSaleableQty({ batchId, distributorId, warehouseId = null, reason = null, transaction }) {
  const wc = await warehouseClauseFor({ distributorId, warehouseId, transaction });
  const base = { batchId, distributor_id: distributorId, stock_state: NON_SALEABLE };
  if (reason) base.non_saleable_reason = reason;
  return stateBalance({ where: { [Op.and]: [base, wc] }, transaction });
}

/**
 * SALEABLE-state quantity for a product across all its batches, scoped to a distributor.
 */
async function getProductAvailableQty({ productId, distributorId, warehouseId = null, transaction }) {
  const wc = await warehouseClauseFor({ distributorId, warehouseId, transaction });
  const rows = await db.StockLedger.findAll({
    where: { [Op.and]: [{ productId, distributor_id: distributorId, stock_state: SALEABLE }, wc] },
    attributes: ["movement_type", "quantity"],
    transaction,
  });
  return sumMovements(rows);
}

/**
 * Per-batch available stock for a product, ordered by expiry (FEFO order),
 * excluding expired and inactive batches by default.
 */
async function getAvailableBatches({
  productId,
  distributorId,
  transaction,
  includeInactive = false,
  includeExpired = false,
  warehouseId = null,
}) {
  const where = { productId, distributor_id: distributorId };
  if (!includeInactive) where.status = "active";
  if (!includeExpired) {
    where[Op.or] = [{ exp_date: null }, { exp_date: { [Op.gte]: new Date() } }];
  }

  const batches = await db.Batch.findAll({
    where,
    // FEFO order, made fully deterministic (Phase 6):
    //  1. a batch WITH a recorded expiry date is always considered before one without — an unknown expiry must never
    //     jump ahead of a known, sooner one (some SQL dialects sort NULL first in ASC order, which would do exactly that).
    //  2. ascending expiry date — the FEFO principle itself.
    //  3. ascending batch id — the tie-break for batches sharing the same expiry date. No such rule existed before
    //     Phase 6 (order was expiry-only, so ties fell back to whatever order the database happened to return them
    //     in); batch id (creation order) was chosen as the simplest deterministic, auditable rule: of two batches
    //     expiring on the same day, the one recorded first is consumed first.
    order: [
      [db.Sequelize.literal("(exp_date IS NULL)"), "ASC"],
      ["exp_date", "ASC"],
      ["id", "ASC"],
    ],
    transaction,
  });

  const result = [];
  for (const batch of batches) {
    const available = await getBatchAvailableQty({
      batchId: batch.id,
      distributorId,
      warehouseId,
      transaction,
    });
    if (available > 0) {
      result.push({ batch, available });
    }
  }
  return result;
}

/**
 * Allocate `quantity` units of a product across batches.
 *
 * - If `batchId` is provided, allocation is manual: all quantity must come
 *   from that single batch (must belong to the distributor, be active, not
 *   expired, and have enough available stock).
 * - Otherwise, allocation is automatic FEFO: earliest-expiry batches are
 *   consumed first, splitting across as many batches as needed.
 *
 * Returns an array of { batchId, quantity } allocations covering the full
 * requested quantity, or throws InsufficientStockError.
 */
async function allocateStock({
  productId,
  distributorId,
  quantity,
  batchId = null,
  warehouseId = null,
  transaction,
}) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryValidationError("quantity must be a positive integer");
  }
  // Sales allocate from ONE warehouse: the given one, else the distributor's default (dispatch) warehouse.
  const wh = await resolveWarehouse({ distributorId, warehouseId, transaction });

  if (batchId) {
    const batch = await db.Batch.findOne({
      where: { id: batchId, productId, distributor_id: distributorId },
      transaction,
    });
    if (!batch) {
      throw new InventoryValidationError("Invalid batch for this product/distributor");
    }
    if (batch.status !== "active") {
      throw new InventoryValidationError(`Batch ${batch.batch_no} is not active`);
    }
    if (batch.exp_date && new Date(batch.exp_date) < new Date()) {
      throw new InventoryValidationError(`Batch ${batch.batch_no} is expired`);
    }
    const available = await getBatchAvailableQty({ batchId, distributorId, warehouseId: wh.id, transaction });
    if (available < quantity) {
      throw new InsufficientStockError(
        `Insufficient stock in batch ${batch.batch_no}: available ${available}, requested ${quantity}`,
        { batchId, available, requested: quantity }
      );
    }
    return [{ batchId, quantity }];
  }

  // Automatic FEFO across all eligible batches
  const batches = await getAvailableBatches({ productId, distributorId, warehouseId: wh.id, transaction });
  const plan = planFefoAllocation(batches, quantity);

  if (!plan.fulfilled) {
    // All-or-nothing: this is the existing, unchanged partial-fulfilment policy. planFefoAllocation only PLANS —
    // nothing has been posted yet (postSalesOut posts each allocation only after allocateStock returns successfully) —
    // so a shortfall here throws before a single ledger row is written; the caller's transaction has nothing to roll back.
    throw new InsufficientStockError(
      `Insufficient saleable stock to fulfill requested quantity for product ${productId}: available ${plan.totalAllocated}, requested ${quantity}`,
      { productId, available: plan.totalAllocated, requested: quantity }
    );
  }

  return plan.allocations.map((a) => ({ batchId: a.batchId, quantity: a.quantity }));
}

/**
 * Pure FEFO planning shared by `allocateStock` (which posts the result) and `previewFefoAllocation` (which does not).
 * There is exactly one allocation algorithm in the codebase; both callers use this function so a preview can never
 * disagree with what an actual allocation would do against the same batch list.
 *
 * `batches` must already be in FEFO order (as returned by `getAvailableBatches`): earliest eligible expiry first,
 * deterministic tie-break on batch id. Greedily consumes each batch's available quantity before moving to the next.
 */
function planFefoAllocation(batches, quantity) {
  let remaining = quantity;
  const allocations = [];
  for (const { batch, available } of batches) {
    if (remaining <= 0) break;
    const take = Math.min(available, remaining);
    if (take > 0) {
      allocations.push({
        batchId: batch.id,
        batchNo: batch.batch_no,
        expDate: batch.exp_date,
        available,
        quantity: take,
      });
      remaining -= take;
    }
  }
  return { allocations, remaining, totalAllocated: quantity - remaining, fulfilled: remaining <= 0 };
}

/**
 * Read-only preview of what automatic FEFO allocation WOULD do for `quantity` units of a product, without posting
 * anything. Used by the Sales Order preview and the FEFO Monitor's "FEFO Allocation Preview" tool (Phase 6, item 8).
 *
 * This calls the exact same `getAvailableBatches` + `planFefoAllocation` that `allocateStock` uses for automatic
 * allocation, so the preview and the real allocation can only differ if eligible stock changes between the preview
 * call and the actual sale (a concurrent sale, a batch expiring, stock being marked non-saleable, etc.) — the caller
 * should treat this as informational, not a reservation, and the backend re-validates and re-allocates authoritatively
 * at delivery time regardless of what a preview showed.
 *
 * Pass `transaction` to preview against a specific transaction's view of stock (e.g. from inside another operation);
 * omitted, this reads the current committed state with no row lock — appropriate for a UI preview.
 */
async function previewFefoAllocation({ productId, distributorId, quantity, warehouseId = null, transaction }) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryValidationError("quantity must be a positive integer");
  }
  const wh = await resolveWarehouse({ distributorId, warehouseId, transaction });
  const batches = await getAvailableBatches({ productId, distributorId, warehouseId: wh.id, transaction });
  const plan = planFefoAllocation(batches, quantity);
  return {
    productId,
    distributorId,
    warehouseId: wh.id,
    requested: quantity,
    allocations: plan.allocations.map((a) => ({
      batchId: a.batchId,
      batchNo: a.batchNo,
      expDate: a.expDate,
      available: a.available,
      allocated: a.quantity,
    })),
    totalAllocated: plan.totalAllocated,
    remaining: plan.remaining,
    sufficient: plan.fulfilled,
  };
}

/**
 * Post a single stock movement row. This is the ONLY function in the
 * codebase that should call StockLedger.create — all stock-affecting
 * controllers must go through here so validation/tenant-isolation is
 * consistent.
 */
async function postMovement({
  distributorId,
  productId,
  batchId,
  movementType, // "IN" | "OUT"
  quantity,
  referenceType,
  referenceId = null,
  referenceLineId = null,
  userId = null,
  reason = null,
  allowNegative = false,
  warehouseId = null, // Phase 5: omitted = the distributor's default (dispatch) warehouse
  stockState = SALEABLE, // Phase 5: SALEABLE | NON_SALEABLE
  nonSaleableReason = null, // required when stockState is NON_SALEABLE
  transaction,
}) {
  if (!["IN", "OUT"].includes(movementType)) {
    throw new InventoryValidationError("movementType must be IN or OUT");
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryValidationError("quantity must be a positive integer");
  }
  if (!rules.STOCK_STATES.includes(stockState)) {
    throw new InventoryValidationError("stockState must be SALEABLE or NON_SALEABLE");
  }
  if (stockState === NON_SALEABLE && !rules.isNonSaleableReason(nonSaleableReason)) {
    throw new InventoryValidationError(`nonSaleableReason must be one of: ${Object.keys(rules.NON_SALEABLE_REASONS).join(", ")}`);
  }
  if (stockState === SALEABLE) nonSaleableReason = null;
  const wh = await resolveWarehouse({ distributorId, warehouseId, transaction });

  const batch = await db.Batch.findOne({
    where: { id: batchId, productId, distributor_id: distributorId },
    transaction,
  });
  if (!batch) {
    throw new InventoryValidationError("Invalid batch for this product/distributor");
  }

  if (movementType === "OUT" && !allowNegative) {
    const available =
      stockState === SALEABLE
        ? await getBatchAvailableQty({ batchId, distributorId, warehouseId: wh.id, transaction })
        : await getBatchNonSaleableQty({ batchId, distributorId, warehouseId: wh.id, reason: nonSaleableReason, transaction });
    if (available < quantity) {
      throw new InsufficientStockError(
        `Insufficient stock in batch ${batch.batch_no}: available ${available}, requested ${quantity}`,
        { batchId, available, requested: quantity }
      );
    }
  }

  return db.StockLedger.create(
    {
      movement_type: movementType,
      quantity,
      reference_type: referenceType,
      reference_id: referenceId,
      reference_line_id: referenceLineId,
      created_by: userId,
      reason,
      batchId,
      productId,
      distributor_id: distributorId,
      warehouse_id: wh.id,
      stock_state: stockState,
      non_saleable_reason: nonSaleableReason,
    },
    { transaction }
  );
}

/**
 * Post stock IN for a confirmed purchase delivery line.
 */
async function postPurchaseIn({
  distributorId,
  productId,
  batchId,
  quantity,
  deliveryId,
  deliveryLineId,
  userId,
  transaction,
}) {
  return postMovement({
    distributorId,
    productId,
    batchId,
    movementType: "IN",
    quantity,
    referenceType: "PURCHASE",
    referenceId: deliveryId,
    referenceLineId: deliveryLineId,
    userId,
    transaction,
  });
}

/**
 * Post stock OUT for a confirmed sales delivery line, using either a
 * manually chosen batch or automatic FEFO allocation. Returns the array of
 * created StockLedger rows (one per batch consumed).
 */
async function postSalesOut({
  distributorId,
  productId,
  quantity,
  batchId = null,
  warehouseId = null,
  deliveryId,
  deliveryLineId,
  userId,
  transaction,
}) {
  // Resolve the dispatch warehouse ONCE so allocation and posting use the same one.
  const wh = await resolveWarehouse({ distributorId, warehouseId, transaction });
  const allocations = await allocateStock({
    productId,
    distributorId,
    quantity,
    batchId,
    warehouseId: wh.id,
    transaction,
  });

  const movements = [];
  for (const alloc of allocations) {
    const movement = await postMovement({
      distributorId,
      productId,
      batchId: alloc.batchId,
      warehouseId: wh.id,
      movementType: "OUT",
      quantity: alloc.quantity,
      referenceType: "SALES",
      referenceId: deliveryId,
      referenceLineId: deliveryLineId,
      userId,
      transaction,
    });
    movements.push(movement);
  }
  return movements;
}

/**
 * Post a manual stock adjustment (damage, expiry, breakage, physical count,
 * opening stock, correction). Direction is IN or OUT depending on whether
 * the adjustment increases or decreases stock.
 */
async function postAdjustment({
  distributorId,
  productId,
  batchId,
  quantity,
  direction, // "IN" | "OUT"
  reasonType, // one of ADJUSTMENT_REFERENCE_TYPES
  reason,
  warehouseId = null,
  userId,
  transaction,
}) {
  if (!ADJUSTMENT_REFERENCE_TYPES.includes(reasonType)) {
    throw new InventoryValidationError(
      `reasonType must be one of: ${ADJUSTMENT_REFERENCE_TYPES.join(", ")}`
    );
  }
  return postMovement({
    distributorId,
    productId,
    batchId,
    movementType: direction,
    quantity,
    referenceType: reasonType,
    reason,
    warehouseId,
    userId,
    transaction,
  });
}

/**
 * Reverse previously-posted movements for a given reference (e.g. a
 * delivery being deleted, or a return against a sale). Creates
 * compensating movements in the opposite direction rather than mutating
 * history, so the ledger stays a true audit trail.
 */
async function reverseMovementsForReference({
  distributorId,
  referenceType,
  referenceId,
  reversalReferenceType,
  userId,
  reason,
  transaction,
}) {
  const originalMovements = await db.StockLedger.findAll({
    where: { distributor_id: distributorId, reference_type: referenceType, reference_id: referenceId },
    transaction,
  });

  const reversed = [];
  for (const m of originalMovements) {
    const opposite = m.movement_type === "IN" ? "OUT" : "IN";
    const created = await postMovement({
      distributorId,
      productId: m.productId,
      batchId: m.batchId,
      movementType: opposite,
      quantity: m.quantity,
      referenceType: reversalReferenceType,
      referenceId,
      referenceLineId: m.reference_line_id,
      userId,
      reason,
      warehouseId: m.warehouse_id, // the compensating row goes back to where the original moved stock
      stockState: m.stock_state,
      nonSaleableReason: m.non_saleable_reason,
      allowNegative: true, // reversing a real prior movement must always succeed
      transaction,
    });
    reversed.push(created);
  }
  return reversed;
}

// ── Non-saleable stock (Phase 5) ─────────────────────────────────────────────────────────────────────────────────
/**
 * Move quantity between SALEABLE and NON_SALEABLE state inside one warehouse. Two ledger rows (OUT of the old state, IN to the
 * new one, reference_type RECLASSIFY) — on-hand is unchanged, nothing is deleted, and the reason stays on the ledger.
 * The caller supplies the transaction, so both rows and any surrounding work commit or roll back together.
 */
async function reclassifyStock({
  distributorId, productId, batchId, quantity, to, reasonCode, reason = null, warehouseId = null, userId = null, transaction,
}) {
  if (!transaction) throw new InventoryValidationError("A database transaction is required to change stock status");
  if (![SALEABLE, NON_SALEABLE].includes(to)) throw new InventoryValidationError("to must be SALEABLE or NON_SALEABLE");
  if (!rules.isNonSaleableReason(reasonCode)) {
    throw new InventoryValidationError(`reasonCode must be one of: ${Object.keys(rules.NON_SALEABLE_REASONS).join(", ")}`);
  }
  if (reasonCode === "OTHER" && !String(reason || "").trim()) {
    throw new InventoryValidationError("A reason is required when the non-saleable reason is OTHER");
  }
  if (reason && String(reason).length > 255) throw new InventoryValidationError("reason is too long (max 255 characters)");

  const wh = await resolveWarehouse({ distributorId, warehouseId, transaction });
  const from = to === NON_SALEABLE ? SALEABLE : NON_SALEABLE;
  const label = reason ? String(reason).trim() : rules.NON_SALEABLE_REASONS[reasonCode];
  const common = { distributorId, productId, batchId, quantity, referenceType: "RECLASSIFY", userId, reason: label, warehouseId: wh.id, transaction };

  const out = await postMovement({ ...common, movementType: "OUT", stockState: from, nonSaleableReason: from === NON_SALEABLE ? reasonCode : null });
  const inn = await postMovement({ ...common, movementType: "IN", stockState: to, nonSaleableReason: to === NON_SALEABLE ? reasonCode : null });
  return { out, in: inn };
}
const markNonSaleable = (args) => reclassifyStock({ ...args, to: NON_SALEABLE });
const releaseNonSaleable = (args) => reclassifyStock({ ...args, to: SALEABLE });

// ── Stock transfer foundation (Phase 5) ──────────────────────────────────────────────────────────────────────────
/**
 * Immediately-posted transfer of SALEABLE stock of one batch between two warehouses of the SAME distributor. Records a
 * StockTransfer and posts OUT (from) + IN (to) ledger rows in the caller's transaction. No approval / in-transit workflow.
 */
async function transferStock({
  distributorId, productId, batchId, quantity, fromWarehouseId, toWarehouseId, reason = null, transferDate = new Date(), userId = null, transaction,
}) {
  if (!transaction) throw new InventoryValidationError("A database transaction is required to transfer stock");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new InventoryValidationError("quantity must be a positive integer");
  const from = await resolveWarehouse({ distributorId, warehouseId: fromWarehouseId, transaction });
  const to = await resolveWarehouse({ distributorId, warehouseId: toWarehouseId, transaction });
  if (from.id === to.id) throw new InventoryValidationError("Source and destination warehouse must be different");

  const transfer = await db.StockTransfer.create(
    {
      distributor_id: distributorId, from_warehouse_id: from.id, to_warehouse_id: to.id, productId, batchId, quantity,
      transfer_date: transferDate, status: "POSTED", reason: reason ? String(reason).slice(0, 255) : null, created_by: userId,
    },
    { transaction }
  );
  await transfer.update({ transfer_no: `TRF-${String(transfer.id).padStart(6, "0")}` }, { transaction });

  const note = reason ? String(reason).slice(0, 255) : `Transfer ${transfer.transfer_no}`;
  const common = { distributorId, productId, batchId, quantity, referenceType: "TRANSFER", referenceId: transfer.id, referenceLineId: 1, userId, reason: note, transaction };
  // OUT first: it validates the source has enough saleable stock in the source warehouse (and locks its ledger rows).
  await postMovement({ ...common, movementType: "OUT", warehouseId: from.id });
  await postMovement({ ...common, movementType: "IN", warehouseId: to.id });
  return transfer;
}

module.exports = {
  InsufficientStockError,
  InventoryValidationError,
  ADJUSTMENT_REFERENCE_TYPES,
  getBatchAvailableQty,
  getBatchNonSaleableQty,
  getProductAvailableQty,
  ensureDefaultWarehouse,
  resolveWarehouse,
  getDispatchWarehouseId,
  reclassifyStock,
  markNonSaleable,
  releaseNonSaleable,
  transferStock,
  getAvailableBatches,
  allocateStock,
  planFefoAllocation,
  previewFefoAllocation,
  postMovement,
  postPurchaseIn,
  postSalesOut,
  postAdjustment,
  reverseMovementsForReference,
};
