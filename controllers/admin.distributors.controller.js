// controllers/admin.distributors.controller.js — Phase 8 Admin Distributor Management HTTP layer.
// Every route sits behind requireAdmin (routes/adminRoutes.js). Responses never contain the password hash or reset OTP.
const db = require("../models");
const svc = require("../services/adminDistributors.service");
const { QueryError } = require("../services/salesQuery");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Distributor not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.DistributorError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    console.error("admin distributors error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

const trace = (req, what) => console.info(`[admin-distributors] admin=${req.admin && req.admin.id} ${what}`);

exports.lookups = (req, res) => handle(res, () => svc.getLookups(db));
exports.list = (req, res) => handle(res, () => svc.listDistributors(db, req.query));
exports.get = (req, res) => handle(res, () => svc.getDistributorDetail(db, req.params.id));
exports.retailers = (req, res) => handle(res, () => svc.listDistributorRetailers(db, req.params.id, req.query));

exports.create = (req, res) =>
  handle(
    res,
    async () => {
      const out = await svc.createDistributor(db, req.body, { adminId: req.admin && req.admin.id });
      trace(req, `created distributor ${out.code}`);
      return out;
    },
    201
  );

exports.update = (req, res) =>
  handle(res, async () => {
    const out = await svc.updateDistributor(db, req.params.id, req.body);
    if (out) trace(req, `updated distributor ${out.id}: ${out.updated.join(",")}`);
    return out;
  });

exports.setStatus = (req, res) =>
  handle(res, async () => {
    const out = await svc.setDistributorStatus(db, req.params.id, req.body);
    if (out) trace(req, `distributor ${out.id} ${out.previousStatus} -> ${out.status}`);
    return out;
  });
