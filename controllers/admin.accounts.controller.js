// controllers/admin.accounts.controller.js — Phase 12 Admin Accounts. Every route is behind requireAdmin (asserted in tests).
// Tenant data is never taken from the client: payments derive the distributor from the retailer, credit updates load the row by id.
const rec = require("../services/receivables.service");
const pay = require("../services/payments.service");
const accounting = require("../services/accounting.service");
const { QueryError } = require("../services/salesQuery");

const SCOPE = { role: "admin" };

async function handle(res, fn, okStatus = 200, notFound = "Not found") {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: notFound, code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof pay.PaymentError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    if (err instanceof accounting.AccountingError) return res.status(err.statusCode).json({ message: err.message, code: "ACCOUNTING_ERROR" });
    console.error("admin accounts error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.lookups = (req, res) => handle(res, () => rec.lookups(SCOPE, req.query));
exports.summary = (req, res) => handle(res, () => rec.summary(SCOPE));
exports.outstanding = (req, res) => handle(res, () => rec.outstandingList(SCOPE, req.query));
exports.ageing = (req, res) => handle(res, () => rec.ageing(SCOPE, req.query));
exports.ledger = (req, res) => handle(res, () => rec.ledger(SCOPE, req.query), 200, "Entity not found");
exports.credit = (req, res) => handle(res, () => rec.creditList(SCOPE, req.query));
exports.updateCredit = (req, res) =>
  handle(res, async () => {
    const out = await rec.updateCredit({ role: "admin" }, req.params.entityId, req.body);
    if (out) console.info(`[admin-accounts] admin=${req.admin && req.admin.id} credit limit ${out.entityType}:${out.entityId} -> ${out.creditLimit}`);
    return out;
  }, 200, "Entity not found");
exports.payments = (req, res) => handle(res, () => pay.listPayments(SCOPE, req.query));
exports.payment = (req, res) => handle(res, () => pay.getPayment(SCOPE, req.params.id), 200, "Payment not found");
exports.openInvoices = (req, res) => handle(res, () => pay.openInvoices(SCOPE, req.query.retailerId), 200, "Retailer not found");
exports.createPayment = (req, res) =>
  handle(res, async () => {
    const out = await pay.createPayment(req.admin && req.admin.id, req.body);
    console.info(`[admin-accounts] admin=${req.admin && req.admin.id} payment ${out.number} ${out.amount} retailer=${out.retailer && out.retailer.id}`);
    return out;
  }, 201);
