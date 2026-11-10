// Admin Sales endpoints — thin HTTP layer. All logic lives in services/adminSales.service.js (reads) and
// services/adminSalesOrder.service.js (actions); this file only parses the request and maps errors to responses.
const db = require("../models");
const reads = require("../services/adminSales.service");
const actions = require("../services/adminSalesOrder.service");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Not found" });
    return res.status(okStatus).json(data);
  } catch (err) {
    // QueryError / SalesError / the status-rule errors all carry a 4xx statusCode and a safe, user-facing message.
    if (err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    }
    console.error("admin sales error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" }); // no SQL / stack details to the client
  }
}

// Server-side trace of who did what (there is no audit-log table yet — see docs, known limitations).
const trace = (req, what) => console.info(`[admin-sales] admin=${req.admin && req.admin.id} ${what}`);

exports.filterLookups = (req, res) => handle(res, () => reads.getFilterLookups(db));
exports.retailerLookup = (req, res) => handle(res, async () => ({ items: await reads.getRetailerLookup(db, req.query) }));
exports.productLookup = (req, res) => handle(res, async () => ({ items: await reads.getProductLookup(db, req.query) }));
exports.batchLookup = (req, res) => handle(res, async () => ({ items: await reads.getBatchLookup(db, req.query) }));

exports.listOrders = (req, res) => handle(res, () => reads.listOrders(db, req.query));
exports.getOrder = (req, res) => handle(res, () => reads.getOrder(db, req.params.id));
exports.previewOrder = (req, res) => handle(res, () => actions.previewOrder(req.body));
exports.createOrder = (req, res) =>
  handle(res, async () => {
    const out = await actions.createOrder(req.body);
    trace(req, `created sales order ${out.orderNumber}`);
    return out;
  }, 201);
exports.updateOrder = (req, res) =>
  handle(res, async () => {
    const out = await actions.updateOrder(req.params.id, req.body);
    trace(req, `updated sales order ${out.orderNumber}`);
    return out;
  });
exports.confirmOrder = (req, res) =>
  handle(res, async () => {
    const out = await actions.confirmOrder(req.params.id);
    trace(req, `confirmed sales order ${out.orderNumber}`);
    return out;
  });
exports.cancelOrder = (req, res) =>
  handle(res, async () => {
    const out = await actions.cancelOrder(req.params.id);
    trace(req, `cancelled sales order ${out.orderNumber}`);
    return out;
  });
exports.createInvoiceForOrder = (req, res) =>
  handle(res, async () => {
    const out = await actions.createInvoiceForOrder(req.params.id, req.body || {});
    trace(req, `created invoice ${out.invoice.invoiceNumber} (delivery ${out.deliveryCreated ? "created" : "reused"}) for order ${req.params.id}`);
    return out;
  }, 201);

exports.listInvoices = (req, res) => handle(res, () => reads.listInvoices(db, req.query));
exports.getInvoice = (req, res) => handle(res, () => reads.getInvoice(db, req.params.id));
exports.postInvoice = (req, res) =>
  handle(res, async () => {
    const out = await actions.postInvoice(req.params.id);
    trace(req, `posted invoice ${out.id}`);
    return out;
  });
exports.cancelInvoice = (req, res) =>
  handle(res, async () => {
    const out = await actions.cancelInvoice(req.params.id);
    trace(req, `cancelled invoice ${out.id}`);
    return out;
  });

exports.secondarySummary = (req, res) => handle(res, () => reads.getSecondarySummary(db, req.query));
exports.listSecondary = (req, res) => handle(res, () => reads.listSecondary(db, req.query));
exports.getSecondary = (req, res) => handle(res, () => reads.getSecondary(db, req.params.key));
