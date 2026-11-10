// controllers/retailer.controller.js — Phase 9 Distributor-portal Retailer Management (existing Distributor auth: authMiddleware → req.user).
// The scope is built ONLY from the authenticated token. Nothing in query / body / params can widen it, and there is deliberately
// NO assign / reassign handler here — only an admin can move a retailer between distributors.
const db = require("../models");
const svc = require("../services/retailers.service");
const { QueryError } = require("../services/salesQuery");

async function handle(req, res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const id = req.user && Number(req.user.id);
    if (!id) return res.status(401).json({ message: "Unauthorized" });
    // Re-check the distributor on every call (tokens live up to a day): a deactivated distributor is locked out of retailer data immediately.
    const me = await db.Distributor.findOne({ where: { id }, attributes: ["id", "distributor_code", "status"] });
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (me.status && me.status !== "active") return res.status(403).json({ message: "Your account is not active. Please contact the administrator.", code: "DISTRIBUTOR_INACTIVE" });
    const scope = { role: "distributor", distributorId: Number(me.id), distributorCode: me.distributor_code };

    const data = await fn(scope);
    if (data === null || data === undefined) return res.status(404).json({ message: "Retailer not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.RetailerError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    console.error("retailers error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.lookups = (req, res) => handle(req, res, (s) => svc.getLookups(db, s));
exports.list = (req, res) => handle(req, res, (s) => svc.listRetailers(db, s, req.query));
exports.get = (req, res) => handle(req, res, (s) => svc.getRetailerDetail(db, s, req.params.id));
exports.create = (req, res) => handle(req, res, (s) => svc.createRetailer(db, s, req.body), 201);
exports.update = (req, res) => handle(req, res, (s) => svc.updateRetailer(db, s, req.params.id, req.body));
exports.setStatus = (req, res) => handle(req, res, (s) => svc.setRetailerStatus(db, s, req.params.id, req.body));
