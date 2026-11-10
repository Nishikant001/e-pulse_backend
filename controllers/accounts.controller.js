// controllers/accounts.controller.js — Phase 12 Distributor-portal financial view (existing Distributor auth: authMiddleware → req.user).
// READ-ONLY by design: there is no handler that creates a payment, changes a credit limit or posts an entry. The distributor id comes
// only from the verified token; distributorId in a query/body is ignored, and another distributor's retailer/ledger answers 404.
const db = require("../models");
const rec = require("../services/receivables.service");
const pay = require("../services/payments.service");
const { QueryError } = require("../services/salesQuery");

async function handle(req, res, fn, notFound = "Not found") {
  res.set("Cache-Control", "no-store");
  try {
    const id = req.user && Number(req.user.id);
    if (!id) return res.status(401).json({ message: "Unauthorized" });
    const me = await db.Distributor.findOne({ where: { id }, attributes: ["id", "distributor_code", "status"] });
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (me.status && me.status !== "active") return res.status(403).json({ message: "Your account is not active. Please contact the administrator.", code: "DISTRIBUTOR_INACTIVE" });
    const data = await fn({ role: "distributor", distributorId: Number(me.id), distributorCode: me.distributor_code });
    if (data === null || data === undefined) return res.status(404).json({ message: notFound, code: "NOT_FOUND" });
    return res.json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    console.error("accounts (distributor) error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.lookups = (req, res) => handle(req, res, (s) => rec.lookups(s, {}));
exports.summary = (req, res) => handle(req, res, (s) => rec.summary(s));
exports.outstanding = (req, res) => handle(req, res, (s) => rec.outstandingList(s, req.query));
exports.ageing = (req, res) => handle(req, res, (s) => rec.ageing(s, req.query));
exports.ledger = (req, res) => handle(req, res, (s) => rec.ledger(s, req.query), "Entity not found");
exports.credit = (req, res) => handle(req, res, (s) => rec.creditList(s, req.query));
exports.payments = (req, res) => handle(req, res, (s) => pay.listPayments(s, req.query));
exports.payment = (req, res) => handle(req, res, (s) => pay.getPayment(s, req.params.id), "Payment not found");
