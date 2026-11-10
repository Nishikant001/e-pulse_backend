// services/adminPurchaseFulfilment.service.js
//
// Admin-side fulfilment of a distributor's purchase order: DELIVERY (which posts the stock-in) and INVOICE.
// Adds no business rules of its own. It composes the existing purchase controllers, run with the TARGET distributor as the tenant
// (services/distributorContext), exactly like services/adminSalesOrder.service.js does for sales — so over-receive protection,
// transactions, numbering, tax, stock-ledger posting and accounting stay a single implementation.
const db = require("../models");
const { SalesError, loadDistributor, invokeAsDistributor, unwrap } = require("./distributorContext");
const q = require("./salesQuery");

const deliveryCtrl = () => require("../controllers/purchasedelivery.controller");
const invoiceCtrl = () => require("../controllers/purchaseinvoice.controller");
const poCtrl = () => require("../controllers/purchaseorder.controller");

const fail = (status, code, message) => new SalesError(status, code, message);

function parseDate(value, label) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw fail(400, "VALIDATION_FAILED", `${label} is not a valid date`);
  return d;
}

async function loadOrder(poId) {
  const pk = q.intId(poId, "id");
  if (!pk) throw fail(404, "NOT_FOUND", "Purchase order not found");
  const po = await db.PurchaseOrderHeader.findOne({ where: { id: pk }, include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
  if (!po) throw fail(404, "NOT_FOUND", "Purchase order not found");
  return po;
}

async function discardBatches(ids) {
  if (ids.length) await db.Batch.destroy({ where: { id: ids } });
}

/**
 * Record goods delivered against a PO. Each line carries a batch number: an existing batch of that product (for this
 * distributor) is reused, otherwise a new batch is created (expiry date required). Stock is added by the existing purchase-delivery
 * controller (inventory.postPurchaseIn) — this is the moment stock enters the distributor's inventory.
 */
async function deliver(poId, body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.lines) || body.lines.length === 0) {
    throw fail(400, "VALIDATION_FAILED", "At least one delivery line is required");
  }
  const po = await loadOrder(poId);
  if (!poCtrl().DELIVERABLE_STATUSES.includes(po.status)) {
    throw fail(400, "INVALID_STATE", `A purchase order with status ${po.status} cannot be delivered. The distributor must confirm it first.`);
  }
  const distributor = await loadDistributor(db, po.distributor_id);
  const deliveryDate = body.deliveryDate ? parseDate(body.deliveryDate, "Delivery date") : new Date();

  const lines = [];
  const createdBatchIds = []; // batches created by THIS call — removed again if the delivery is rejected
  let out;
  try {
    for (const l of body.lines) {
      const orderLineId = q.intId(l && l.orderLineId, "orderLineId");
      const orderLine = po.lines.find((x) => x.id === orderLineId);
      if (!orderLine) throw fail(400, "VALIDATION_FAILED", "A delivery line does not belong to this purchase order");
      const quantityReceived = Number(l.quantityReceived);
      if (!Number.isInteger(quantityReceived) || quantityReceived <= 0) throw fail(400, "VALIDATION_FAILED", "Quantity must be a positive whole number");
      const batchNo = String(l.batchNo || "").trim();
      if (!batchNo) throw fail(400, "VALIDATION_FAILED", `Batch number is required for ${orderLine.material_code || "each item"}`);

      let batch = await db.Batch.findOne({ where: { productId: orderLine.productId, distributor_id: po.distributor_id, batch_no: batchNo } });
      if (!batch) {
        if (!l.expDate) throw fail(400, "VALIDATION_FAILED", `Expiry date is required for new batch ${batchNo}`);
        try {
          batch = await db.Batch.create({
            batch_no: batchNo,
            productId: orderLine.productId,
            distributor_id: po.distributor_id,
            mfg_date: l.mfgDate ? parseDate(l.mfgDate, "Manufacturing date") : null,
            exp_date: parseDate(l.expDate, "Expiry date"),
            purchase_price: orderLine.pricePerUnit,
            status: "active",
          });
          createdBatchIds.push(batch.id);
        } catch (err) {
          if (err && /^Sequelize(Validation|UniqueConstraint)/.test(err.name)) throw fail(400, "VALIDATION_FAILED", err.errors?.[0]?.message || err.message);
          throw err;
        }
      }
      lines.push({ orderLineId, quantityReceived, batchId: batch.id });
    }

    const result = await invokeAsDistributor(distributor, deliveryCtrl().create, {
      body: { order_number: po.order_number, deliveryDate: deliveryDate.toISOString(), remarks: body.remarks || null, lines },
    });
    out = unwrap(result, "Unable to record the delivery");
  } catch (err) {
    await discardBatches(createdBatchIds); // nothing was delivered (the delivery transaction rolled back), so these new batches carry no stock
    throw err;
  }
  return { message: out.message, delivery: out.delivery };
}

/** Create the purchase invoice for one delivery and post it (Dr Purchase / Input GST, Cr Accounts Payable on the distributor's books). */
async function createInvoice(poId, deliveryId, body = {}) {
  const po = await loadOrder(poId);
  const did = q.intId(deliveryId, "deliveryId");
  const delivery = did ? await db.PurchaseDeliveryHeader.findOne({ where: { id: did, orderId: po.id } }) : null;
  if (!delivery) throw fail(404, "NOT_FOUND", "Delivery not found for this purchase order");
  const distributor = await loadDistributor(db, po.distributor_id);

  const created = unwrap(
    await invokeAsDistributor(distributor, invoiceCtrl().create, { body: { deliveryId: delivery.id, paymentTerms: body.paymentTerms || undefined } }),
    "Unable to create the invoice"
  );
  const invoice = created.invoice;
  const posted = unwrap(
    await invokeAsDistributor(distributor, invoiceCtrl().post, { params: { id: invoice.id } }),
    "The invoice was created as a draft but could not be posted"
  );
  return { message: "Invoice created and posted", invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, result: posted };
}

module.exports = { deliver, createInvoice };
