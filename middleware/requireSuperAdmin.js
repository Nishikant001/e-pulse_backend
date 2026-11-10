// Use AFTER requireAdmin. The role in req.admin was loaded fresh from admin_users on this request (never from the JWT).
const { sendError } = require("./errorHandler");
const { normaliseRole } = require("../config/erpPermissions");

module.exports = function requireSuperAdmin(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (!req.admin || normaliseRole(req.admin.role) !== "SUPER_ADMIN") {
    return sendError(res, req, 403, "FORBIDDEN", "Only Super Admins can access this resource");
  }
  return next();
};
