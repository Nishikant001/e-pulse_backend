// middleware/erpAccess.js — Phase 17. ERP-scoped authorization, applied AFTER requireAdmin on every ERP route.
//
//   router.get("/erp-integrations", requireAdmin, erp("ERP_VIEW", "read"), handler)
//
//   401  no / invalid Admin session            (produced by requireAdmin)
//   403  signed in, role lacks the permission  fixed message, nothing about which role or permission was missing leaves the server
//
// The role is whatever requireAdmin just re-read from admin_users, so a role change or deactivation applies to the very next request.
// Frontend checks are UX only; this is the control.
const { roleHas, permissionsForRole } = require("../config/erpPermissions");
const { sendError } = require("./errorHandler");
const { policies } = require("./rateLimiter");

const DENIED_MESSAGE = "You don't have permission to perform this action.";
const denyThrottle = new Map(); // `${adminId}|${perm}` → last audit time (a denied-request loop must not flood the audit table)

function recordDenied(req, needed) {
  try {
    const key = `${req.admin.id}|${[].concat(needed).join("+")}`;
    const now = Date.now();
    if ((denyThrottle.get(key) || 0) > now - 60000) return;
    if (denyThrottle.size > 2000) denyThrottle.clear();
    denyThrottle.set(key, now);
    const db = require("../models");
    const { resolveTenantKey } = require("../services/erp/tenantScope");
    require("../services/erpAudit.service").record(db, {
      event: "ERP_ACCESS_DENIED", adminId: req.admin.id, tenantKey: resolveTenantKey(req), status: "FAILED", correlationId: req.correlationId,
      metadata: { permission: [].concat(needed).join(" | "), method: req.method, route: `${req.baseUrl || ""}${req.route && req.route.path ? req.route.path : ""}` },
    });
  } catch (_) { /* denial auditing must never turn a 403 into a 500 */ }
}

/** @param {string|string[]} needed permission (or any-of list)  @param {keyof policies} [limit] rate-limit policy to apply after the check */
function erp(needed, limit) {
  const check = function erpPermission(req, res, next) {
    if (!req.admin) return sendError(res, req, 401, "UNAUTHENTICATED", "Admin authentication required");
    if (!roleHas(req.admin.role, needed)) { recordDenied(req, needed); return sendError(res, req, 403, "FORBIDDEN", DENIED_MESSAGE); }
    req.erpPermissions = permissionsForRole(req.admin.role);
    return next();
  };
  if (limit && !policies[limit]) throw new Error(`Unknown rate-limit policy ${limit}`);
  return limit ? [check, policies[limit]] : [check];
}

module.exports = { erp, DENIED_MESSAGE, _resetDenyThrottle: () => denyThrottle.clear() };
