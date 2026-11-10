// controllers/admin.masters.controller.js — Phase 7 Admin Masters HTTP layer.
//
//   Reads: services/adminMasters.service.js (raw SQL, cross-distributor, paginated — same shape as Admin Sales/Inventory).
//   Writes: the EXISTING Distributor controllers (product / stock(batch) / pricingmaster / hsngroup), invoked with the
//           TARGET distributor as the tenant context via services/distributorContext.js — exactly like
//           services/adminSalesOrder.service.js already does for Sales Orders. Every ownership check, validation rule
//           and auto-generated field (material_code, batch duplicate/date rules, pricing uniqueness) inside those
//           controllers therefore applies unchanged; nothing is re-implemented here.
//
// On CREATE, the caller (Admin) explicitly names which distributor owns the new record (`distributorId` in the body).
// On UPDATE / deactivate / reactivate, the target distributor is instead RESOLVED from the existing record — a
// client-supplied distributorId is never trusted to redirect a write to a different tenant.
const db = require("../models");
const reads = require("../services/adminMasters.service");
const inventory = require("../services/inventory.service");
const { QueryError } = require("../services/salesQuery");
const { loadDistributor, invokeAsDistributor, unwrap } = require("../services/distributorContext");

const productCtrl = () => require("./product.controller");
const batchCtrl = () => require("./stock.controller");
const pricingCtrl = () => require("./pricingmaster.controller");
const hsnCtrl = () => require("./hsngroup.controller");
const groupCtrl = () => require("./customergroup.controller");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    }
    console.error("admin masters error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

const positiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new QueryError(`${name} must be a positive integer`);
  return n;
};

const trace = (req, what) => console.info(`[admin-masters] admin=${req.admin && req.admin.id} ${what}`);

// ── lookups ──────────────────────────────────────────────────────────────────────────────────────────────────────
exports.lookups = (req, res) =>
  handle(res, () => reads.getMastersLookups(db, { distributorId: req.query.distributorId ? positiveInt(req.query.distributorId, "distributorId") : null }));

// ══════════════════════════════════ Product Master ══════════════════════════════════

exports.listProducts = (req, res) => handle(res, () => reads.listProducts(db, req.query));
exports.getProduct = (req, res) => handle(res, () => reads.getProductDetail(db, req.params.id));

exports.createProduct = (req, res) =>
  handle(
    res,
    async () => {
      const distributorId = positiveInt(req.body && req.body.distributorId, "distributorId");
      const distributor = await loadDistributor(db, distributorId);
      const { distributorId: _drop, ...body } = req.body || {};
      const result = await invokeAsDistributor(distributor, productCtrl().create, { body });
      const out = unwrap(result, "Unable to create product");
      trace(req, `created product ${out && out.material_code} for distributor ${distributorId}`);
      return out;
    },
    201
  );

exports.updateProduct = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolveProductDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const { distributorId: _drop, id: _dropId, material_code: _dropCode, ...changes } = req.body || {};
    const result = await invokeAsDistributor(distributor, productCtrl().update, { params: { id }, body: changes });
    const out = unwrap(result, "Unable to update product");
    trace(req, `updated product ${id}`);
    return out;
  });

exports.setProductStatus = (status) => (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolveProductDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const result = await invokeAsDistributor(distributor, productCtrl().update, { params: { id }, body: { status } });
    const out = unwrap(result, `Unable to set product status to ${status}`);
    trace(req, `set product ${id} status=${status}`);
    return out;
  });

// ══════════════════════════════════ Batch Master ══════════════════════════════════

exports.listBatches = (req, res) => handle(res, () => reads.listBatches(db, req.query));
// Batch Master reuses the EXISTING Inventory Batch Detail (stock + expiry + FEFO priority) unscoped across tenants —
// the exact same read the Admin Inventory > Batch Stock screen already uses (Phase 5/6) — rather than building a
// second "batch detail" query.
exports.getBatch = (req, res) =>
  handle(res, () => require("../services/inventoryQuery.service").getBatchDetail(db, req.params.id, { distributorId: null }));

exports.createBatch = (req, res) =>
  handle(
    res,
    async () => {
      const distributorId = positiveInt(req.body && req.body.distributorId, "distributorId");
      const distributor = await loadDistributor(db, distributorId);
      const { distributorId: _drop, openingQty, ...body } = req.body || {};
      const result = await invokeAsDistributor(distributor, batchCtrl().createBatch, { body });
      const out = unwrap(result, "Unable to create batch");
      const batch = out && out.batch;
      trace(req, `created batch ${batch && batch.batch_no} for distributor ${distributorId}`);

      if (batch && openingQty !== undefined && openingQty !== null && Number(openingQty) > 0) {
        const t = await db.sequelize.transaction();
        try {
          await inventory.postAdjustment({
            distributorId,
            productId: batch.productId,
            batchId: batch.id,
            quantity: Math.trunc(Number(openingQty)),
            direction: "IN",
            reasonType: "OPENING",
            reason: "Opening stock (Batch Master)",
            userId: null,
            transaction: t,
          });
          await t.commit();
          return { ...out, openingStockPosted: true };
        } catch (err) {
          await t.rollback();
          // The batch itself was already created successfully; only the opening-stock posting failed — surface
          // that as a warning rather than rolling back a batch that already exists and has a valid identity.
          return { ...out, openingStockPosted: false, openingStockError: err.message };
        }
      }
      return out;
    },
    201
  );

exports.updateBatch = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const { distributorId } = await reads.resolveBatchDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const { distributorId: _drop, id: _dropId, productId: _dropProduct, ...changes } = req.body || {};
    const result = await invokeAsDistributor(distributor, batchCtrl().updateBatch, { params: { id }, body: changes });
    const out = unwrap(result, "Unable to update batch");
    trace(req, `updated batch ${id}`);
    return out;
  });

exports.setBatchStatus = (status) => (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const { distributorId } = await reads.resolveBatchDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const result = await invokeAsDistributor(distributor, batchCtrl().updateBatch, { params: { id }, body: { status } });
    const out = unwrap(result, `Unable to set batch status to ${status}`);
    trace(req, `set batch ${id} status=${status}`);
    return out;
  });

// ══════════════════════════════════ Pricing Master ══════════════════════════════════

exports.listPricing = (req, res) => handle(res, () => reads.listPricing(db, req.query));
exports.getPricing = (req, res) => handle(res, () => reads.getPricingDetail(db, req.params.id));

exports.createPricing = (req, res) =>
  handle(
    res,
    async () => {
      const distributorId = positiveInt(req.body && req.body.distributorId, "distributorId");
      const distributor = await loadDistributor(db, distributorId);
      const { distributorId: _drop, ...body } = req.body || {};
      const result = await invokeAsDistributor(distributor, pricingCtrl().create, { body });
      const out = unwrap(result, "Unable to create pricing record");
      trace(req, `created pricing for distributor ${distributorId}`);
      return out;
    },
    201
  );

exports.updatePricing = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolvePricingDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const { distributorId: _drop, id: _dropId, ...changes } = req.body || {};
    const result = await invokeAsDistributor(distributor, pricingCtrl().update, { params: { id }, body: changes });
    const out = unwrap(result, "Unable to update pricing record");
    trace(req, `updated pricing ${id}`);
    return out;
  });

// Ends validity as of today rather than deleting the row, so price history stays intact (see getPricingDetail).
exports.deactivatePricing = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolvePricingDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const today = new Date().toISOString().slice(0, 10);
    const result = await invokeAsDistributor(distributor, pricingCtrl().update, { params: { id }, body: { valid_to: today } });
    const out = unwrap(result, "Unable to deactivate pricing record");
    trace(req, `deactivated pricing ${id}`);
    return out;
  });

// ══════════════════════════════════ Tax Master (HSN) ══════════════════════════════════

exports.listTaxes = (req, res) => handle(res, () => reads.listTaxes(db, req.query));
exports.getTax = (req, res) => handle(res, () => reads.getTaxDetail(db, req.params.id));

exports.createTax = (req, res) =>
  handle(
    res,
    async () => {
      const distributorId = positiveInt(req.body && req.body.distributorId, "distributorId");
      const distributor = await loadDistributor(db, distributorId);
      const { distributorId: _drop, ...body } = req.body || {};
      const result = await invokeAsDistributor(distributor, hsnCtrl().create, { body });
      const out = unwrap(result, "Unable to create tax record");
      trace(req, `created HSN ${out && out.hsn_code} for distributor ${distributorId}`);
      return out;
    },
    201
  );

exports.updateTax = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolveTaxDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const { distributorId: _drop, id: _dropId, ...changes } = req.body || {};
    const result = await invokeAsDistributor(distributor, hsnCtrl().update, { params: { id }, body: changes });
    const out = unwrap(result, "Unable to update tax record");
    trace(req, `updated HSN ${id}`);
    return out;
  });

// ══════════════════════════════════ Customer Group Master ══════════════════════════════════
// Same model as Tax Master: reads are cross-distributor; create names the owning distributor; update resolves it from the record.
// The existing distributor controller enforces the unique (code, distributor) rule. Only the NAME can change after creation
// (the code is the group's identity — pricing and customers reference the group by id, but codes appear in exports/ERP mapping).
// There is deliberately no delete: customers and pricing records reference the group.

exports.listCustomerGroups = (req, res) => handle(res, () => reads.listCustomerGroups(db, req.query));
exports.getCustomerGroup = (req, res) => handle(res, () => reads.getCustomerGroupDetail(db, req.params.id));

exports.createCustomerGroup = (req, res) =>
  handle(
    res,
    async () => {
      const distributorId = positiveInt(req.body && req.body.distributorId, "distributorId");
      const distributor = await loadDistributor(db, distributorId);
      const { distributorId: _drop, ...body } = req.body || {};
      if (body.code) body.code = String(body.code).trim().toUpperCase();
      if (body.name) body.name = String(body.name).trim();
      const result = await invokeAsDistributor(distributor, groupCtrl().create, { body });
      const out = unwrap(result, "Unable to create customer group");
      trace(req, `created customer group ${out && out.code} for distributor ${distributorId}`);
      return out;
    },
    201
  );

exports.updateCustomerGroup = (req, res) =>
  handle(res, async () => {
    const id = positiveInt(req.params.id, "id");
    const distributorId = await reads.resolveCustomerGroupDistributor(db, id);
    const distributor = await loadDistributor(db, distributorId);
    const name = req.body && req.body.name ? String(req.body.name).trim() : "";
    if (!name) throw new QueryError("name is required");
    const result = await invokeAsDistributor(distributor, groupCtrl().update, { params: { id }, body: { name } });
    const out = unwrap(result, "Unable to update customer group");
    trace(req, `updated customer group ${id}`);
    return out;
  });
