// controllers/superAdmin.controller.js — Phase 25. Routes sit behind requireAdmin + requireSuperAdmin (routes/adminRoutes.js).
const db = require("../models");
const svc = require("../services/superAdmin.service");
const { QueryError } = require("../services/salesQuery");
const { sendError } = require("../middleware/errorHandler");

async function handle(req, res, fn) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return sendError(res, req, 404, "NOT_FOUND", "Admin not found");
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof QueryError) return sendError(res, req, 400, "BAD_REQUEST", err.message);
    console.error("super admin error:", err && err.message);
    return sendError(res, req, 500, "INTERNAL_ERROR", "Unable to complete the request");
  }
}

exports.overview = (req, res) => handle(req, res, () => svc.getOverview(db));
exports.adminDistributors = (req, res) => handle(req, res, () => svc.listAdminDistributors(db, req.params.id));
