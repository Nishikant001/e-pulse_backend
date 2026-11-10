// controllers/claim.controller.js — Phase 11 Distributor-portal Claims (existing Distributor auth: authMiddleware → req.user).
// The scope comes ONLY from the verified token. distributor_id / customer_id / claim_amount / status in a body are never read, and a
// claim of another distributor answers 404 exactly as if it did not exist. There is no approve / reject / review / status handler here.
const db = require("../models");
const svc = require("../services/claims.service");
const { QueryError } = require("../services/salesQuery");

async function handle(req, res, fn, okStatus = 200) {
  res.set("Cache-Control", "no-store");
  try {
    const id = req.user && Number(req.user.id);
    if (!id) return res.status(401).json({ message: "Unauthorized" });
    const me = await db.Distributor.findOne({ where: { id }, attributes: ["id", "distributor_code", "status"] });
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (me.status && me.status !== "active") return res.status(403).json({ message: "Your account is not active. Please contact the administrator.", code: "DISTRIBUTOR_INACTIVE" });
    const scope = { role: "distributor", distributorId: Number(me.id), distributorCode: me.distributor_code };
    const data = await fn(scope);
    if (data === null || data === undefined) return res.status(404).json({ message: "Claim not found", code: "NOT_FOUND" });
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ message: err.message, code: "BAD_REQUEST" });
    if (err instanceof svc.ClaimError) return res.status(err.statusCode).json({ message: err.message, code: err.code, details: err.details });
    console.error("claims (distributor) error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.lookups = (req, res) => handle(req, res, (s) => svc.getLookups(db, s));
exports.invoiceLines = (req, res) => handle(req, res, (s) => svc.previewInvoiceLines(db, s, req.params.invoiceId, req.query.schemeId));
exports.list = (req, res) => handle(req, res, (s) => svc.listClaims(db, s, req.query));
exports.get = (req, res) => handle(req, res, (s) => svc.getClaim(db, s, req.params.id));
exports.create = (req, res) => handle(req, res, (s) => svc.createClaim(db, s, req.body), 201);
exports.update = (req, res) => handle(req, res, (s) => svc.updateClaim(db, s, req.params.id, req.body));
exports.submit = (req, res) => handle(req, res, (s) => svc.submitClaim(db, s, req.params.id, "SUBMITTED"));
exports.resubmit = (req, res) => handle(req, res, (s) => svc.submitClaim(db, s, req.params.id, "RESUBMITTED"));
