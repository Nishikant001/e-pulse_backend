// controllers/admin.retailers.controller.js — Phase 9 Admin Retailer Management. Every route is behind requireAdmin.
// Admin has full control, including the ONLY endpoint that can change retailer ownership (assign).
const db = require("../models");
const svc = require("../services/retailers.service");
const { QueryError } = require("../services/salesQuery");

const SCOPE = { role: "admin" };

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Retailer not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.RetailerError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    console.error("admin retailers error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}
const trace = (req, what) => console.info(`[admin-retailers] admin=${req.admin && req.admin.id} ${what}`);

exports.lookups = (req, res) => handle(res, () => svc.getLookups(db, SCOPE));
exports.list = (req, res) => handle(res, () => svc.listRetailers(db, SCOPE, req.query));
exports.get = (req, res) => handle(res, () => svc.getRetailerDetail(db, SCOPE, req.params.id));
exports.create = (req, res) =>
  handle(res, async () => {
    const out = await svc.createRetailer(db, SCOPE, req.body);
    trace(req, `created retailer ${out.code} for distributor ${out.distributorId}`);
    return out;
  }, 201);
exports.update = (req, res) =>
  handle(res, async () => {
    const out = await svc.updateRetailer(db, SCOPE, req.params.id, req.body);
    if (out) trace(req, `updated retailer ${out.id}: ${out.updated.join(",")}`);
    return out;
  });
exports.setStatus = (req, res) =>
  handle(res, async () => {
    const out = await svc.setRetailerStatus(db, SCOPE, req.params.id, req.body);
    if (out) trace(req, `retailer ${out.id} ${out.previousStatus} -> ${out.status}`);
    return out;
  });
exports.assign = (req, res) =>
  handle(res, async () => {
    const out = await svc.reassignRetailer(db, SCOPE, req.params.id, req.body);
    if (out) trace(req, `retailer ${out.id} distributor ${out.previousDistributorId} -> ${out.distributorId}`);
    return out;
  });
