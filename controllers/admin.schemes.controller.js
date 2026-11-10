// controllers/admin.schemes.controller.js — Phase 10 Admin Scheme Master. Every route is behind requireAdmin.
const db = require("../models");
const svc = require("../services/schemes.service");
const engine = require("../services/schemeEngine.service");
const { QueryError } = require("../services/salesQuery");

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Scheme not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.SchemeError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    if (err instanceof engine.EngineError) return res.status(err.statusCode).json({ message: err.message, code: err.code });
    console.error("admin schemes error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}
const trace = (req, what) => console.info(`[admin-schemes] admin=${req.admin && req.admin.id} ${what}`);

exports.lookups = (req, res) => handle(res, () => svc.getLookups(db, req.query));
exports.list = (req, res) => handle(res, () => svc.listSchemes(db, req.query));
exports.get = (req, res) => handle(res, () => svc.getScheme(db, req.params.id));
exports.create = (req, res) =>
  handle(res, async () => {
    const out = await svc.createScheme(db, req.admin && req.admin.id, req.body);
    trace(req, `created scheme ${out.code} (${out.type})`);
    return out;
  }, 201);
exports.update = (req, res) =>
  handle(res, async () => {
    const out = await svc.updateScheme(db, req.admin && req.admin.id, req.params.id, req.body);
    if (out) trace(req, `updated scheme ${out.code}: ${out.updated.join(",") || "no field changes"}`);
    return out;
  });
exports.setStatus = (req, res) =>
  handle(res, async () => {
    const out = await svc.setSchemeStatus(db, req.admin && req.admin.id, req.params.id, req.body);
    if (out) trace(req, `scheme ${out.code} ${out.previousStatus} -> ${out.status}`);
    return out;
  });
// Admin "what-if": evaluates for an EXPLICITLY chosen distributor (Admin acts across tenants). Read-only.
exports.evaluate = (req, res) =>
  handle(res, () => {
    const b = req.body || {};
    return engine.evaluate({ distributorId: b.distributorId, customerId: b.customerId, lines: b.lines, asOf: b.asOf });
  });
