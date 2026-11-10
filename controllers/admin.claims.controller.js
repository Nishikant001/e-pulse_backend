// controllers/admin.claims.controller.js — Phase 11 Admin Claims. Every route is behind requireAdmin.
// Admin is the only role that can review / approve / reject / return a claim. There is no "set status" endpoint.
const db = require("../models");
const svc = require("../services/claims.service");
const { QueryError } = require("../services/salesQuery");

const SCOPE = { role: "admin" };

async function handle(res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return res.status(404).json({ message: "Claim not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.ClaimError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    console.error("admin claims error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}
const trace = (req, what) => console.info(`[admin-claims] admin=${req.admin && req.admin.id} ${what}`);
const adminId = (req) => req.admin && req.admin.id;

exports.lookups = (req, res) => handle(res, () => svc.getLookups(db, SCOPE));
exports.list = (req, res) => handle(res, () => svc.listClaims(db, SCOPE, req.query));
exports.get = (req, res) => handle(res, () => svc.getClaim(db, SCOPE, req.params.id));
const decide = (fn, label) => (req, res) =>
  handle(res, async () => {
    const out = await fn(db, adminId(req), req.params.id, req.body);
    if (out) trace(req, `claim ${out.number} -> ${out.status} (${label})`);
    return out;
  });
exports.review = decide(svc.review, "review");
exports.approve = decide(svc.approve, "approve");
exports.reject = decide(svc.reject, "reject");
exports.needsCorrection = decide(svc.needsCorrection, "needs-correction");
// Phase 12: settle a claim that was approved before accounting existed. Not an approval — no status change. 409 if already settled.
exports.settle = decide(svc.settle, "settle");
