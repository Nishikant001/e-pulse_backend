// services/adminSalesOrder.service.js
//
// Admin-side Sales Order / Invoice ACTIONS. It adds no business rules of its own; it composes the existing ones:
//   pricing  → services/pricing.service   (PricingMaster is authoritative; a client price is never accepted here)
//   GST      → services/tax.service via salesLineCalc.service
//   stock    → services/inventory.service (getBatchAvailableQty / getAvailableBatches — the same ledger balance the delivery uses)
//   writes   → the EXISTING controllers (salesOrder / salesdelivery / salesinvoice), run with the target distributor as the
//              tenant context (services/distributorContext) so their ownership checks, transactions, numbering, state
//              machines and accounting (invoice post → journal entries) remain the single implementation.
//   status   → services/salesStatus.service (central allowed-action rules)
//
// The database is only touched through those services/controllers. The frontend supplies IDs and quantities; everything
// else (prices, tax, stock, ownership, transitions) is decided here on the server.
const db = require("../models");
const pricing = require("./pricing.service");
const inventory = require("./inventory.service");
const status = require("./salesStatus.service");
const schemeEngine = require("./schemeEngine.service");
const { computeLineAmounts, computeTotals } = require("./salesLineCalc.service");
const { SalesError, loadDistributor, invokeAsDistributor, unwrap } = require("./distributorContext");
const q = require("./salesQuery");

const salesOrderCtrl = () => require("../controllers/salesOrder.controller");
const salesDeliveryCtrl = () => require("../controllers/salesdelivery.controller");
const salesInvoiceCtrl = () => require("../controllers/salesinvoice.controller");

const MAX_LINES = 100;
const ERR = {
  PRICING: { code: "PRICING_NOT_CONFIGURED", message: "Unable to calculate pricing: no price is configured for this product and retailer group." },
  EXPIRED: { code: "BATCH_EXPIRED", message: "Selected batch has expired." },
  NOT_SALEABLE: { code: "BATCH_NOT_SALEABLE", message: "Selected batch is not saleable." },
  BATCH_STOCK: { code: "INSUFFICIENT_STOCK", message: "Insufficient saleable stock for selected batch." },
  PRODUCT_STOCK: { code: "INSUFFICIENT_STOCK", message: "Insufficient saleable stock for the selected product." },
  PRODUCT_NOT_FOUND: { code: "PRODUCT_NOT_FOUND", message: "Product not found for this distributor." },
  BATCH_NOT_FOUND: { code: "BATCH_NOT_FOUND", message: "Selected batch does not belong to this product." },
};

const runner = () => (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
const tname = (m) => `\`${m.getTableName()}\``;
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// ───────────────────────── input validation (explicit whitelist — no mass assignment) ─────────────────────────
function parseOrderInput(body, { needDistributor = true } = {}) {
  if (!body || typeof body !== "object") throw new SalesError(400, "VALIDATION_FAILED", "Request body is required");
  const distributorId = needDistributor ? q.intId(body.distributorId, "distributorId") : null;
  if (needDistributor && !distributorId) throw new SalesError(400, "VALIDATION_FAILED", "Distributor is required");
  const customerId = q.intId(body.customerId, "customerId");
  if (!customerId) throw new SalesError(400, "VALIDATION_FAILED", "Retailer is required");
  const orderDate = body.orderDate ? q.day(body.orderDate, "orderDate") : new Date().toISOString().slice(0, 10);
  const paymentTerms = q.text(body.paymentTerms, "paymentTerms", 40);
  if (!paymentTerms) throw new SalesError(400, "VALIDATION_FAILED", "Payment terms are required");
  const remarks = q.text(body.remarks, "remarks", 500);
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new SalesError(400, "VALIDATION_FAILED", "Add at least one product line");
  if (body.lines.length > MAX_LINES) throw new SalesError(400, "VALIDATION_FAILED", `An order can have at most ${MAX_LINES} lines`);

  const lines = body.lines.map((l, i) => {
    if (!l || typeof l !== "object") throw new SalesError(400, "VALIDATION_FAILED", `Line ${i + 1} is invalid`);
    const productId = q.intId(l.productId, "productId");
    const quantity = Number(l.quantity);
    const discount = l.discount === undefined || l.discount === null || l.discount === "" ? 0 : Number(l.discount);
    if (!productId) throw new SalesError(400, "VALIDATION_FAILED", `Line ${i + 1}: product is required`);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) throw new SalesError(400, "VALIDATION_FAILED", `Line ${i + 1}: quantity must be a positive whole number`);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new SalesError(400, "VALIDATION_FAILED", `Line ${i + 1}: discount must be between 0 and 100`);
    return { productId, batchId: q.intId(l.batchId, "batchId"), quantity, discount };
  });
  return { distributorId, customerId, orderDate, paymentTerms, remarks, lines };
}

// ───────────────────────── preview (pricing + GST + stock validation, nothing saved) ─────────────────────────
async function previewOrder(rawInput, { distributorId: fixedDistributorId } = {}) {
  const input = parseOrderInput(rawInput, { needDistributor: !fixedDistributorId });
  const distributorId = fixedDistributorId || input.distributorId;
  const distributor = await loadDistributor(db, distributorId);
  const customer = await db.Customer.findOne({ where: { id: input.customerId, distributor_id: distributorId } });
  if (!customer) throw new SalesError(400, "RETAILER_NOT_FOUND", "Retailer not found for this distributor");

  const now = new Date();
  // Demand across the whole order, so two lines cannot together oversell the same batch / product.
  const batchDemand = new Map();
  const productBatchDemand = new Map();
  const productAutoDemand = new Map();
  for (const l of input.lines) {
    if (l.batchId) {
      batchDemand.set(l.batchId, (batchDemand.get(l.batchId) || 0) + l.quantity);
      productBatchDemand.set(l.productId, (productBatchDemand.get(l.productId) || 0) + l.quantity);
    } else productAutoDemand.set(l.productId, (productAutoDemand.get(l.productId) || 0) + l.quantity);
  }
  const productPool = new Map(); // saleable stock of a product across batches (cache)
  const productBatchRows = new Map(); // Phase 6: the same FEFO-ordered rows, kept for the allocation preview below

  const lines = [];
  for (let index = 0; index < input.lines.length; index += 1) {
    const l = input.lines[index];
    const errors = [];
    const out = { index, productId: l.productId, batchId: l.batchId, quantity: l.quantity, discountPercent: l.discount, mrp: null, errors };

    const product = await db.Product.findOne({ where: { id: l.productId, distributor_id: distributorId } });
    if (!product) {
      errors.push(ERR.PRODUCT_NOT_FOUND);
      lines.push(out);
      continue;
    }
    const hsn = product.hsn_id ? await db.HSNGroup.findOne({ where: { id: product.hsn_id } }) : null;
    Object.assign(out, { product: product.name, sku: product.material_code, unit: product.unit || null, hsn: hsn ? hsn.hsn_code : null });

    let batch = null;
    if (l.batchId) {
      batch = await db.Batch.findOne({ where: { id: l.batchId, productId: l.productId, distributor_id: distributorId } });
      if (!batch) errors.push(ERR.BATCH_NOT_FOUND);
    }
    if (batch) {
      out.batch = { id: batch.id, batchNo: batch.batch_no, mfgDate: batch.mfg_date ? new Date(batch.mfg_date).toISOString().slice(0, 10) : null, expDate: batch.exp_date ? new Date(batch.exp_date).toISOString().slice(0, 10) : null };
      const expired = batch.exp_date ? new Date(batch.exp_date) < now : false;
      const inactive = batch.status !== "active";
      out.available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId });
      if (expired) errors.push(ERR.EXPIRED);
      else if (inactive) errors.push(ERR.NOT_SALEABLE);
      else if ((batchDemand.get(batch.id) || 0) > out.available) errors.push(ERR.BATCH_STOCK);
    } else if (!l.batchId) {
      if (!productPool.has(l.productId)) {
        const rows = await inventory.getAvailableBatches({ productId: l.productId, distributorId });
        productPool.set(l.productId, rows.reduce((a, r) => a + r.available, 0));
        productBatchRows.set(l.productId, rows);
      }
      const pool = productPool.get(l.productId) - (productBatchDemand.get(l.productId) || 0);
      out.available = Math.max(pool, 0);
      if ((productAutoDemand.get(l.productId) || 0) > pool) errors.push(ERR.PRODUCT_STOCK);

      // Phase 6 (items 7/8) — "FEFO Allocation Preview": which batches automatic allocation would draw from for THIS
      // line, using the exact same algorithm (planFefoAllocation) inventory.service uses to actually allocate at
      // delivery time. Informational only — nothing is reserved. The rows are reduced by demand any batch-specific
      // line elsewhere in this same order already claims from that exact batch, so the preview reflects the rest of
      // the order; it does NOT reduce them further for other AUTO lines of the same product (each auto line's
      // preview is computed independently), so if an order has more than one auto line for the same product their
      // previews can overlap — real allocation at delivery time always accounts for what has actually been consumed.
      const rows = productBatchRows.get(l.productId);
      const adjusted = rows.map((r) => ({ batch: r.batch, available: Math.max(0, r.available - (batchDemand.get(r.batch.id) || 0)) }));
      const plan = inventory.planFefoAllocation(adjusted, l.quantity);
      out.fefoAllocation = plan.allocations.map((a) => ({
        batchId: a.batchId, batchNo: a.batchNo, expDate: a.expDate ? new Date(a.expDate).toISOString().slice(0, 10) : null, available: a.available, allocated: a.quantity,
      }));
      out.fefoSufficient = plan.fulfilled;
    }

    try {
      const price = await pricing.getFinalPriceForCustomer({ productId: l.productId, customerId: input.customerId, distributorId });
      const a = computeLineAmounts({ unitPrice: price.unitPrice, quantity: l.quantity, discountPercent: l.discount, product });
      Object.assign(out, {
        priceSource: "PricingMaster", listPrice: price.basePrice, masterDiscountPercent: price.discountPercent, dealerPrice: price.unitPrice,
        gstRate: a.cgstRate + a.sgstRate + a.igstRate, ...a,
      });
    } catch (err) {
      if (err instanceof pricing.PricingNotConfiguredError) errors.push(ERR.PRICING);
      else throw err;
    }
    lines.push(out);
  }

  // Phase 10 — informational scheme evaluation. It does NOT change price, discount, tax, totals, stock or the saved order;
  // free quantity is shown separately and no inventory is deducted for it (see docs, known limitations).
  try {
    const ev = await schemeEngine.evaluate({
      distributorId, customerId: input.customerId,
      lines: lines.filter((l) => !l.errors.some((e) => e.code === "PRODUCT_NOT_FOUND")).map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.dealerPrice ?? null, _i: l.index })),
    });
    const valid = lines.filter((l) => !l.errors.some((e) => e.code === "PRODUCT_NOT_FOUND"));
    ev.lines.forEach((r, i) => { valid[i].scheme = { applied: r.applied, conflict: r.conflict, conflictSchemes: r.conflictSchemes }; });
  } catch (err) {
    console.error("scheme evaluation skipped:", err && err.message); // never blocks order preview
  }

  const priced = lines.filter((l) => l.net !== undefined);
  return {
    distributor: { id: distributor.id, code: distributor.distributor_code, name: distributor.name },
    retailer: { id: customer.id, name: customer.name },
    lines,
    totals: computeTotals(priced),
    valid: lines.every((l) => l.errors.length === 0),
    credit: null, // integration point: no credit-limit mechanism exists yet (see checkCreditLimit)
  };
}

const validationFailure = (preview) =>
  new SalesError(422, "VALIDATION_FAILED", "Some order lines need attention.", { lines: preview.lines.filter((l) => l.errors.length).map((l) => ({ index: l.index, errors: l.errors })) });

const toControllerLines = (input) => input.lines.map((l) => ({ productId: l.productId, ...(l.batchId ? { batchId: l.batchId } : {}), quantity: l.quantity, discount: l.discount }));

// ───────────────────────── facts loaders ─────────────────────────
async function loadOrderFacts(id) {
  const orderId = q.intId(id, "id");
  if (!orderId) throw new SalesError(400, "VALIDATION_FAILED", "Order id is required");
  const line = tname(db.SalesOrderLine);
  const dl = tname(db.SalesDeliveryLine);
  const dh = tname(db.SalesDeliveryHeader);
  const inv = tname(db.SalesInvoiceHeader);
  const rows = await runner()(
    `SELECT o.id AS id, o.distributor_id AS distributor_id, o.order_number AS order_number, o.status AS status,
       ((SELECT COALESCE(SUM(l.quantity),0) FROM ${line} l WHERE l.orderId = o.id)
         - (SELECT COALESCE(SUM(x.quantityDelivered),0) FROM ${dl} x JOIN ${dh} h ON h.id = x.deliveryId WHERE h.orderId = o.id AND h.status <> 'Cancelled')) AS remaining_qty,
       (SELECT COUNT(*) FROM ${dh} h WHERE h.orderId = o.id AND h.status <> 'Cancelled'
          AND NOT EXISTS (SELECT 1 FROM ${inv} i WHERE i.deliveryId = h.id AND i.status <> 'CANCELLED')) AS uninvoiced_deliveries
     FROM ${tname(db.SalesOrderHeader)} o WHERE o.id = :id`,
    { id: orderId }
  );
  if (rows.length === 0) throw new SalesError(404, "NOT_FOUND", "Order not found");
  const r = rows[0];
  return { id: Number(r.id), distributorId: Number(r.distributor_id), orderNumber: r.order_number, status: r.status, remainingQty: num(r.remaining_qty), uninvoicedDeliveries: num(r.uninvoiced_deliveries) };
}

async function loadInvoiceFacts(id) {
  const invoiceId = q.intId(id, "id");
  if (!invoiceId) throw new SalesError(400, "VALIDATION_FAILED", "Invoice id is required");
  const rows = await runner()(`SELECT h.id AS id, h.distributor_id AS distributor_id, h.status AS status FROM ${tname(db.SalesInvoiceHeader)} h WHERE h.id = :id`, { id: invoiceId });
  if (rows.length === 0) throw new SalesError(404, "NOT_FOUND", "Invoice not found");
  return { id: Number(rows[0].id), distributorId: Number(rows[0].distributor_id), status: rows[0].status };
}

// Integration point for a future credit-limit mechanism (none exists in the data model today — nothing is invented here).
// A later phase returns { ok:false } when the applicable limit would be exceeded; confirm then answers 409 CREDIT_LIMIT_EXCEEDED.
async function checkCreditLimit() {
  return { ok: true };
}

// ───────────────────────── order actions ─────────────────────────
async function createOrder(rawInput) {
  const input = parseOrderInput(rawInput);
  const preview = await previewOrder(rawInput);
  if (!preview.valid) throw validationFailure(preview);
  const distributor = await loadDistributor(db, input.distributorId);
  const body = unwrap(
    await invokeAsDistributor(distributor, salesOrderCtrl().create, {
      body: { orderDate: input.orderDate, customerId: input.customerId, paymentMethod: input.paymentTerms, description: input.remarks, lines: toControllerLines(input) },
    }),
    "Unable to create the sales order"
  );
  return { id: body.header.id, orderNumber: body.order_number, status: body.header.status };
}

async function updateOrder(id, rawInput) {
  const facts = await loadOrderFacts(id);
  status.assertOrderActionAllowed("edit", facts);
  const input = parseOrderInput({ ...rawInput, distributorId: facts.distributorId }); // the order's distributor cannot be changed
  const preview = await previewOrder(rawInput, { distributorId: facts.distributorId });
  if (!preview.valid) throw validationFailure(preview);
  const distributor = await loadDistributor(db, facts.distributorId);
  unwrap(
    await invokeAsDistributor(distributor, salesOrderCtrl().update, {
      params: { id: String(facts.id) },
      body: { orderDate: input.orderDate, customerId: input.customerId, paymentMethod: input.paymentTerms, description: input.remarks, lines: toControllerLines(input) },
    }),
    "Unable to update the sales order"
  );
  return { id: facts.id, orderNumber: facts.orderNumber };
}

async function transition(id, action) {
  const facts = await loadOrderFacts(id);
  status.assertOrderActionAllowed(action, facts);
  if (action === "confirm") {
    const credit = await module.exports.checkCreditLimit(facts); // via exports so a later credit-limit phase (or a test) can replace it
    if (!credit.ok) throw new SalesError(409, "CREDIT_LIMIT_EXCEEDED", "Order cannot be confirmed because the applicable credit limit has been exceeded.");
  }
  const distributor = await loadDistributor(db, facts.distributorId);
  const handler = action === "confirm" ? salesOrderCtrl().confirm : salesOrderCtrl().cancel;
  unwrap(await invokeAsDistributor(distributor, handler, { params: { id: String(facts.id) } }), `Unable to ${action} the order`);
  return { id: facts.id, orderNumber: facts.orderNumber, action };
}
const confirmOrder = (id) => transition(id, "confirm");
const cancelOrder = (id) => transition(id, "cancel");

// "Create Invoice" for an order = the existing chain, run for the target distributor:
//   remaining quantity → Sales Delivery (stock OUT via inventory.service, FEFO unless the line names a batch) → Sales Invoice (DRAFT).
// If everything is already delivered, only the missing invoice is created (no stock movement). Posting is a separate, explicit action.
async function createInvoiceForOrder(id, rawBody = {}) {
  const facts = await loadOrderFacts(id);
  status.assertOrderActionAllowed("create_invoice", facts);
  const paymentTerms = q.text(rawBody.paymentTerms, "paymentTerms", 40);
  const distributor = await loadDistributor(db, facts.distributorId);
  const run = runner();

  let deliveryId = null;
  let deliveryCreated = false;
  if (facts.remainingQty > 0) {
    const remaining = await run(
      `SELECT l.id AS order_line_id, (l.quantity - COALESCE((SELECT SUM(x.quantityDelivered) FROM ${tname(db.SalesDeliveryLine)} x JOIN ${tname(db.SalesDeliveryHeader)} h ON h.id = x.deliveryId
          WHERE x.orderLineId = l.id AND h.status <> 'Cancelled'), 0)) AS remaining
       FROM ${tname(db.SalesOrderLine)} l WHERE l.orderId = :id ORDER BY l.id`,
      { id: facts.id }
    );
    const lines = remaining.filter((r) => num(r.remaining) > 0).map((r) => ({ orderLineId: Number(r.order_line_id), quantityDelivered: num(r.remaining) }));
    const delivery = unwrap(
      await invokeAsDistributor(distributor, salesDeliveryCtrl().create, {
        body: { order_number: facts.orderNumber, deliveryDate: new Date().toISOString().slice(0, 10), remarks: "Created from the Admin portal (create invoice)", lines },
      }),
      "Unable to create the delivery for this order"
    );
    deliveryId = delivery.delivery.id;
    deliveryCreated = true;
  } else {
    const rows = await run(
      `SELECT h.id AS id FROM ${tname(db.SalesDeliveryHeader)} h
       WHERE h.orderId = :id AND h.status <> 'Cancelled'
         AND NOT EXISTS (SELECT 1 FROM ${tname(db.SalesInvoiceHeader)} i WHERE i.deliveryId = h.id AND i.status <> 'CANCELLED')
       ORDER BY h.id DESC LIMIT 1`,
      { id: facts.id }
    );
    if (rows.length === 0) throw new SalesError(409, "NOTHING_TO_INVOICE", "There is nothing left to invoice for this order.");
    deliveryId = Number(rows[0].id);
  }

  try {
    const body = unwrap(
      await invokeAsDistributor(distributor, salesInvoiceCtrl().create, { body: { deliveryId, ...(paymentTerms ? { paymentTerms } : {}) } }),
      "Unable to create the invoice"
    );
    return { deliveryId, deliveryCreated, invoice: { id: body.invoice.id, invoiceNumber: body.invoice.invoice_number, status: body.invoice.status } };
  } catch (err) {
    if (deliveryCreated) {
      // The delivery (stock movement) is already committed by the existing delivery controller; the invoice can be retried.
      throw new SalesError(err.statusCode || 500, "INVOICE_FAILED_AFTER_DELIVERY", `Stock was delivered but the invoice could not be created: ${err.message}. Use "Create Invoice" again to retry.`, { deliveryId });
    }
    throw err;
  }
}

// ───────────────────────── invoice actions ─────────────────────────
async function invoiceAction(id, action) {
  const facts = await loadInvoiceFacts(id);
  status.assertInvoiceActionAllowed(action, facts);
  const distributor = await loadDistributor(db, facts.distributorId);
  const handler = action === "post" ? salesInvoiceCtrl().post : salesInvoiceCtrl().cancel;
  unwrap(await invokeAsDistributor(distributor, handler, { params: { id: String(facts.id) } }), `Unable to ${action} the invoice`); // post → existing accounting journal entries
  return { id: facts.id, action };
}
const postInvoice = (id) => invoiceAction(id, "post");
const cancelInvoice = (id) => invoiceAction(id, "cancel");

module.exports = { previewOrder, createOrder, updateOrder, confirmOrder, cancelOrder, createInvoiceForOrder, postInvoice, cancelInvoice, parseOrderInput, checkCreditLimit, ERR };
