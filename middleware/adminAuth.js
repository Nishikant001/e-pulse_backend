// Protects /api/admin/* endpoints.
//
// Authorization comes ONLY from the httpOnly Admin cookie, verified with the Admin secret, issuer, audience and
// portal claim, and re-checked against the admin_users table on every request (so a deactivated admin loses access
// immediately). Nothing from the browser's localStorage, from the Distributor cookie, or from an
// Authorization header is ever consulted here.
const jwt = require("jsonwebtoken");
const db = require("../models");
const { getAdminAuthConfig } = require("../config/adminAuth.config");
const { sendError } = require("./errorHandler");
const { permissionsForRole } = require("../config/erpPermissions");

const UNAUTHENTICATED = { ok: false, status: 401, message: "Admin authentication required" };

// Resolves the Admin session of a request → { ok: true, admin } | { ok: false, status, message }. Never throws for
// bad/missing credentials; only unexpected (database) errors propagate.
async function resolveAdminSession(req) {
  const cfg = getAdminAuthConfig();
  if (!cfg.secret) return { ok: false, status: 503, message: "Admin portal is not configured" };

  const token = req.cookies && req.cookies[cfg.cookieName];
  if (!token) return UNAUTHENTICATED;

  let payload;
  try {
    payload = jwt.verify(token, cfg.secret, { algorithms: ["HS256"], issuer: cfg.issuer, audience: cfg.audience });
  } catch {
    return UNAUTHENTICATED;
  }
  if (payload.portal !== "admin" || payload.typ !== "admin_access") return UNAUTHENTICATED;

  const admin = await db.AdminUser.findByPk(Number(payload.sub));
  if (!admin || !admin.is_active) return UNAUTHENTICATED;

  // erpPermissions (Phase 17) is informational for the UI only — the server re-derives it from the role on every ERP request.
  return { ok: true, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, erpPermissions: permissionsForRole(admin.role) } };
}

async function requireAdmin(req, res, next) {
  res.set("Cache-Control", "no-store");
  try {
    const session = await resolveAdminSession(req);
    if (!session.ok) return sendError(res, req, session.status, session.status === 401 ? "UNAUTHENTICATED" : "SERVICE_UNAVAILABLE", session.message);
    req.admin = session.admin;
    return next();
  } catch (err) {
    console.error(`requireAdmin error: cid=${req.correlationId || "-"} ${err && err.name}`);
    return sendError(res, req, 500, "INTERNAL_ERROR", "Unable to verify admin session");
  }
}

module.exports = requireAdmin;
module.exports.resolveAdminSession = resolveAdminSession;
