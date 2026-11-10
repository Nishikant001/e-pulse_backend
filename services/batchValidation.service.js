// services/batchValidation.service.js — server-side validation for creating / updating a Batch (the frontend is never trusted).
//
// Compatibility (documented): rules are applied to what is being written. A legacy batch without dates, or one that already
// violates a rule, is not rejected merely for existing — only when the offending field is set/changed.
const db = require("../models");
const { Op } = require("sequelize");

class BatchValidationError extends Error {
  constructor(message, code = "BATCH_INVALID") {
    super(message);
    this.name = "BatchValidationError";
    this.statusCode = 400;
    this.code = code;
  }
}

function toDate(v, label) {
  if (v === undefined || v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new BatchValidationError(`${label} is not a valid date`, "INVALID_DATE");
  return d;
}
function toMoney(v, label) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 99999999.99) throw new BatchValidationError(`${label} must be a non-negative amount`, "INVALID_AMOUNT");
  return Math.round(n * 100) / 100;
}

/**
 * Validate batch input for a distributor. `existing` (a Batch instance) is passed on update so unchanged legacy values are
 * not re-validated. Returns the normalised values to persist. Throws BatchValidationError (400) or a 404-style error.
 */
async function validateBatchInput({ distributorId, productId, input, existing = null, now = new Date(), transaction }) {
  const product = await db.Product.findOne({ where: { id: productId, distributor_id: distributorId }, transaction });
  if (!product) throw Object.assign(new BatchValidationError("Product not found", "PRODUCT_NOT_FOUND"), { statusCode: 404 });

  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  if (!existing || has("batch_no")) {
    const batchNo = String(input.batch_no ?? "").trim();
    if (!batchNo) throw new BatchValidationError("Batch number is required", "BATCH_NO_REQUIRED");
    if (batchNo.length > 50) throw new BatchValidationError("Batch number is too long (max 50 characters)", "BATCH_NO_TOO_LONG");
    const dupWhere = { distributor_id: distributorId, productId, batch_no: batchNo };
    if (existing) dupWhere.id = { [Op.ne]: existing.id };
    // Case-insensitive on MySQL (default collation); exact-match elsewhere. Application-level rule — no DB unique index (legacy dupes).
    if (await db.Batch.count({ where: dupWhere, transaction })) {
      throw new BatchValidationError(`Batch ${batchNo} already exists for this product`, "DUPLICATE_BATCH");
    }
    out.batch_no = batchNo;
  }

  const mfgChanged = !existing || has("mfg_date");
  const expChanged = !existing || has("exp_date");
  if (mfgChanged) out.mfg_date = toDate(input.mfg_date, "Manufacturing date");
  if (expChanged) out.exp_date = toDate(input.exp_date, "Expiry date");
  if (mfgChanged || expChanged) {
    const mfg = mfgChanged ? out.mfg_date : existing.mfg_date ? new Date(existing.mfg_date) : null;
    const exp = expChanged ? out.exp_date : existing.exp_date ? new Date(existing.exp_date) : null;
    if (mfgChanged && mfg && mfg > now) throw new BatchValidationError("Manufacturing date cannot be in the future", "MFG_IN_FUTURE");
    if (mfg && exp && exp <= mfg) throw new BatchValidationError("Expiry date must be after the manufacturing date", "EXPIRY_BEFORE_MFG");
  }

  if (!existing || has("purchase_price")) out.purchase_price = toMoney(input.purchase_price, "Purchase price") ?? 0;
  if (!existing || has("mrp")) out.mrp = toMoney(input.mrp, "MRP");

  if (has("status")) {
    if (!["active", "inactive"].includes(input.status)) throw new BatchValidationError("Status must be active or inactive", "INVALID_STATUS");
    out.status = input.status;
  }
  return { product, values: out };
}

module.exports = { BatchValidationError, validateBatchInput };
