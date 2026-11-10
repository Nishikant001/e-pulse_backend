// controllers/admin.purchaseorders.controller.js — e-Pulse Phase 1. READ-ONLY Admin (tenant admin) view of distributors' purchase orders.
// Every route is behind requireAdmin (httpOnly admin cookie). No write handler exists here by design.
const db = require("../models");
const svc = require("../services/adminPurchaseOrders.service");
const { QueryError } = require("../services/salesQuery");

async function handle(res, fn) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Purchase order not found", code: "NOT_FOUND" });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    console.error("admin purchase orders error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.lookups = (req, res) => handle(res, () => svc.getLookups(db));
exports.list = (req, res) => handle(res, () => svc.listPurchaseOrders(db, req.query));
exports.get = (req, res) => handle(res, () => svc.getPurchaseOrderDetail(db, req.params.id));
