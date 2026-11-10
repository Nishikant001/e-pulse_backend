// config/erpPermissions.js — Phase 17. ERP-scoped RBAC: permissions, roles and the role → permission table.
//
// Why ERP-scoped: AdminUser.role was only a label (Phase 3). A global RBAC migration would change access to every Admin module (sales,
// inventory, accounts …) at once. This table governs ONLY the ERP integration routes; every other Admin route keeps its Phase 3–12 behaviour
// (any active Admin session).
//
// The role is read from admin_users on EVERY request (middleware/adminAuth.js re-loads the admin), never from the JWT, so changing or
// deactivating a role takes effect immediately.
//
// Unknown / unmapped roles get NO ERP permission (deny by default).
// Compatibility: the pre-Phase-17 default role "ADMIN" (the only role scripts/create-admin.js ever created) keeps FULL ERP access, exactly as
// before, so no existing administrator loses access on upgrade. Tighten it by moving admins to ERP_ADMIN / ERP_OPERATOR / ERP_VIEWER with
// scripts/set-admin-role.js.
const PERMISSIONS = Object.freeze(["ERP_VIEW", "ERP_MANAGE", "ERP_SYNC", "ERP_RETRY", "ERP_SCHEDULE", "ERP_AUDIT"]);

const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: PERMISSIONS,
  ERP_ADMIN: PERMISSIONS,
  ERP_OPERATOR: Object.freeze(["ERP_VIEW", "ERP_SYNC", "ERP_RETRY"]),
  ERP_VIEWER: Object.freeze(["ERP_VIEW", "ERP_AUDIT"]),
  ADMIN: PERMISSIONS, // legacy default role — see the compatibility note above
});
const ASSIGNABLE_ROLES = Object.freeze(["SUPER_ADMIN", "ERP_ADMIN", "ERP_OPERATOR", "ERP_VIEWER", "ADMIN"]);

const normaliseRole = (role) => String(role || "").trim().toUpperCase();
function permissionsForRole(role) {
  const p = ROLE_PERMISSIONS[normaliseRole(role)];
  return p ? [...p] : [];
}
/** @param {string|string[]} needed  a single permission, or a list meaning "any of these" */
function roleHas(role, needed) {
  const have = permissionsForRole(role);
  return (Array.isArray(needed) ? needed : [needed]).some((n) => have.includes(n));
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, ASSIGNABLE_ROLES, permissionsForRole, roleHas, normaliseRole };
