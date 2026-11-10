// controllers/admin.purchaseFulfilment.controller.js — admin DELIVERS and INVOICES a distributor's purchase order.
// Thin HTTP layer; logic is in services/adminPurchaseFulfilment.service.js (which reuses the existing purchase controllers).
const svc = require("../services/adminPurchaseFulfilment.service");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    return res.status(okStatus).json(await fn());
  } catch (err) {
    if (err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    }
    console.error("admin purchase fulfilment error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

const trace = (req, what) => console.info(`[admin-purchase] admin=${req.admin && req.admin.id} ${what}`);

exports.deliver = (req, res) =>
  handle(res, async () => {
    const out = await svc.deliver(req.params.id, req.body);
    trace(req, `delivered purchase order ${req.params.id} (delivery ${out.delivery && out.delivery.id})`);
    return out;
  }, 201);

exports.invoice = (req, res) =>
  handle(res, async () => {
    const out = await svc.createInvoice(req.params.id, req.params.deliveryId, req.body || {});
    trace(req, `invoiced delivery ${req.params.deliveryId} of purchase order ${req.params.id} (${out.invoiceNumber})`);
    return out;
  }, 201);
