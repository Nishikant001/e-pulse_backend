// controllers/inventory.controller.js — Phase 5 Inventory HTTP layer, shared by BOTH portals.
//
//   Distributor API (/api/inventory/*, authMiddleware): scope is ALWAYS the caller's own id from the verified token. Any
//   `distributorId` in the request is ignored, and every batch / warehouse id is checked against that tenant → a foreign id is a 404.
//   Admin API (/api/admin/inventory/*, requireAdmin): read-only, across tenants, optional `distributorId` filter.
//
// Logic lives in services/inventoryQuery.service.js (reads) and services/inventory.service.js (writes); this file only parses
// the request and maps errors to responses (no SQL / stack details ever reach the client).
const db = require("../models");
const reads = require("../services/inventoryQuery.service");
const inventory = require("../services/inventory.service");
const { BatchValidationError } = require("../services/batchValidation.service");
const { QueryError } = require("../services/salesQuery");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    const known = err instanceof QueryError || err instanceof BatchValidationError || err instanceof inventory.InventoryValidationError || err instanceof inventory.InsufficientStockError;
    const status = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if ((known || status < 500) && status >= 400 && status < 500) {
      return res.status(status).json({ message: err.message, code: err.code || (err instanceof inventory.InsufficientStockError ? "INSUFFICIENT_STOCK" : "REJECTED"), details: err.details });
    }
    console.error("inventory error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

const positiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new QueryError(`${name} must be a positive integer`);
  return n;
};

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function buildReads(scopeOf) {
  return {
    lookups: (req, res) => handle(res, () => reads.getLookups(db, scopeOf(req))),
    summary: (req, res) => handle(res, () => reads.getSummary(db, req.query, scopeOf(req))),
    current: (req, res) => handle(res, () => reads.listCurrentStock(db, req.query, scopeOf(req))),
    batches: (req, res) => handle(res, () => reads.listBatchStock(db, req.query, scopeOf(req))),
    batchDetail: (req, res) => handle(res, () => reads.getBatchDetail(db, req.params.id, scopeOf(req))),
    ledger: (req, res) => handle(res, () => reads.listLedger(db, req.query, scopeOf(req))),
    movement: (req, res) => handle(res, () => reads.getMovement(db, req.query, scopeOf(req))),
    transfers: (req, res) => handle(res, () => reads.listTransfers(db, req.query, scopeOf(req))),
    // Phase 6 (FEFO & Expiry Management) ------------------------------------------------------------------------
    // Expiry bucket rollup (critical/high/medium/healthy/expired) — same optional-distributorId convention as every
    // other read here: a Distributor session is always scoped to itself; an unscoped (Admin) caller may pass
    // `distributorId` to look at one tenant, or omit it to see the total across every tenant.
    expirySummary: (req, res) =>
      handle(res, () => {
        const scope = scopeOf(req);
        const distributorId = scope.distributorId != null ? Number(scope.distributorId) : req.query.distributorId ? positiveInt(req.query.distributorId, "distributorId") : null;
        return reads.getExpiryBucketSummary(db, { distributorId });
      }),
    // Read-only "FEFO Allocation Preview" (item 8): what automatic FEFO allocation would do for `quantity` units of
    // `productId` right now — no stock is reserved or changed. A Distributor session is always previewed for itself;
    // Admin must name a distributorId (there is no "preview across every tenant" for a specific product).
    fefoPreview: (req, res) =>
      handle(res, () => {
        const scope = scopeOf(req);
        const distributorId = scope.distributorId != null ? Number(scope.distributorId) : positiveInt(req.query.distributorId, "distributorId");
        return inventory.previewFefoAllocation({
          distributorId,
          productId: positiveInt(req.query.productId, "productId"),
          quantity: positiveInt(req.query.quantity, "quantity"),
          warehouseId: req.query.warehouseId ? positiveInt(req.query.warehouseId, "warehouseId") : null,
        });
      }),
  };
}
exports.distributorReads = buildReads((req) => ({ distributorId: req.user.id }));
exports.adminReads = buildReads(() => ({ distributorId: null }));

// ── writes (Distributor portal only) ──────────────────────────────────────────────────────────────────────────────
async function inTransaction(fn) {
  const t = await db.sequelize.transaction();
  try {
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// POST /api/inventory/non-saleable  { batchId, quantity, action: "MARK" | "RELEASE", reasonCode, reason?, warehouseId? }
// Moves quantity between saleable and non-saleable state. Both ledger rows are posted in one transaction.
exports.changeSaleability = (req, res) =>
  handle(res, () =>
    inTransaction(async (t) => {
      const distributorId = req.user.id;
      const b = req.body || {};
      const batchId = positiveInt(b.batchId, "batchId");
      const quantity = Number(b.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) throw new inventory.InventoryValidationError("Invalid batch quantity: quantity must be a positive whole number");
      if (!["MARK", "RELEASE"].includes(b.action)) throw new QueryError("action must be MARK or RELEASE");
      const batch = await db.Batch.findOne({ where: { id: batchId, distributor_id: distributorId }, transaction: t });
      if (!batch) throw Object.assign(new QueryError("Batch not found"), { statusCode: 404, code: "NOT_FOUND" });
      const args = {
        distributorId, productId: batch.productId, batchId, quantity, reasonCode: b.reasonCode, reason: b.reason || null,
        warehouseId: b.warehouseId ? positiveInt(b.warehouseId, "warehouseId") : null, userId: req.user.id, transaction: t,
      };
      await (b.action === "MARK" ? inventory.markNonSaleable(args) : inventory.releaseNonSaleable(args));
      return { message: b.action === "MARK" ? "Stock marked non-saleable" : "Stock released to saleable", batchId, quantity };
    })
  , 201);

// POST /api/inventory/transfers  { batchId, quantity, fromWarehouseId, toWarehouseId, reason? }   (foundation — posts immediately)
exports.createTransfer = (req, res) =>
  handle(res, () =>
    inTransaction(async (t) => {
      const distributorId = req.user.id;
      const b = req.body || {};
      const batch = await db.Batch.findOne({ where: { id: positiveInt(b.batchId, "batchId"), distributor_id: distributorId }, transaction: t });
      if (!batch) throw Object.assign(new QueryError("Batch not found"), { statusCode: 404, code: "NOT_FOUND" });
      const transfer = await inventory.transferStock({
        distributorId, productId: batch.productId, batchId: batch.id, quantity: Number(b.quantity),
        fromWarehouseId: positiveInt(b.fromWarehouseId, "fromWarehouseId"), toWarehouseId: positiveInt(b.toWarehouseId, "toWarehouseId"),
        reason: b.reason || null, userId: req.user.id, transaction: t,
      });
      return { id: transfer.id, transferNo: transfer.transfer_no, status: transfer.status, quantity: transfer.quantity };
    })
  , 201);

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
exports.createWarehouse = (req, res) =>
  handle(res, () =>
    inTransaction(async (t) => {
      const distributorId = req.user.id;
      const code = String((req.body || {}).code || "").trim().toUpperCase();
      const name = String((req.body || {}).name || "").trim();
      if (!CODE.test(code)) throw new QueryError("Warehouse code must be 2–20 characters: letters, digits, - or _");
      if (name.length < 2 || name.length > 120) throw new QueryError("Warehouse name must be 2–120 characters");
      await inventory.ensureDefaultWarehouse({ distributorId, transaction: t }); // the default always exists before a second warehouse
      if (await db.Warehouse.count({ where: { distributor_id: distributorId, code }, transaction: t })) {
        throw Object.assign(new QueryError(`Warehouse code ${code} already exists`), { code: "DUPLICATE_WAREHOUSE" });
      }
      const wh = await db.Warehouse.create({ distributor_id: distributorId, code, name, is_default: false, status: "active" }, { transaction: t });
      return { id: wh.id, code: wh.code, name: wh.name, isDefault: false, status: wh.status };
    })
  , 201);

exports.updateWarehouse = (req, res) =>
  handle(res, () =>
    inTransaction(async (t) => {
      const wh = await db.Warehouse.findOne({ where: { id: positiveInt(req.params.id, "id"), distributor_id: req.user.id }, transaction: t });
      if (!wh) throw Object.assign(new QueryError("Warehouse not found"), { statusCode: 404, code: "NOT_FOUND" });
      const patch = {};
      if (req.body && req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (name.length < 2 || name.length > 120) throw new QueryError("Warehouse name must be 2–120 characters");
        patch.name = name;
      }
      if (req.body && req.body.status !== undefined) {
        if (!["active", "inactive"].includes(req.body.status)) throw new QueryError("status must be active or inactive");
        if (req.body.status === "inactive" && wh.is_default) throw new QueryError("The default (dispatch) warehouse cannot be deactivated");
        patch.status = req.body.status;
      }
      await wh.update(patch, { transaction: t });
      return { id: wh.id, code: wh.code, name: wh.name, isDefault: !!wh.is_default, status: wh.status };
    })
  );
