// controllers/report.controller.js — e-Pulse Phase 1. Distributor-portal reports: GET only, always scoped to the authenticated distributor.
// No handler here writes anything; there is deliberately no POST/PUT/DELETE route for /reports.
const db = require("../models");
const svc = require("../services/distributorReports.service");
const { QueryError } = require("../services/salesQuery");

async function handle(req, res, fn) {
  res.set("Cache-Control", "no-store");
  try {
    const id = req.user && Number(req.user.id);
    if (!id) return res.status(401).json({ message: "Unauthorized" });
    // Re-check on every call (tokens live up to a day): a deactivated distributor loses report access immediately.
    const me = await db.Distributor.findOne({ where: { id }, attributes: ["id", "status"] });
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (me.status && me.status !== "active") return res.status(403).json({ message: "Your account is not active. Please contact the administrator.", code: "DISTRIBUTOR_INACTIVE" });
    const data = await fn(id);
    if (data === null || data === undefined) return res.status(404).json({ message: "Report not found", code: "NOT_FOUND" });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof QueryError || (err && err.statusCode === 400)) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err && err.statusCode === 404) return res.status(404).json({ message: err.message, code: "NOT_FOUND" });
    console.error("reports error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.sections = (req, res) => handle(req, res, async () => ({ sections: svc.SECTIONS }));
exports.run = (req, res) => handle(req, res, (id) => svc.runReport(db, id, String(req.params.section || ""), req.query));
