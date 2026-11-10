#!/usr/bin/env node
/**
 * Changes the ERP role of an existing Admin user (Phase 17 RBAC) and records the change in the append-only ERP audit trail.
 *
 *   ADMIN_EMAIL="you@company.com" ADMIN_ROLE=ERP_OPERATOR node scripts/set-admin-role.js
 *
 * Roles: SUPER_ADMIN, ERP_ADMIN, ERP_OPERATOR, ERP_VIEWER, ADMIN (legacy default — full ERP access).
 * It only UPDATES admin_users.role of one row; nothing else is touched. The change applies to the very next request of that admin
 * (the role is re-read from the database on every request). The last active SUPER_ADMIN/ERP_ADMIN/ADMIN cannot be demoted by mistake.
 */
require("dotenv").config();
const db = require("../models");
const { ASSIGNABLE_ROLES, permissionsForRole, normaliseRole } = require("../config/erpPermissions");

async function main() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const role = normaliseRole(process.env.ADMIN_ROLE);
  if (!email) throw new Error("Set ADMIN_EMAIL.");
  if (!ASSIGNABLE_ROLES.includes(role)) throw new Error(`ADMIN_ROLE must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);
  const admin = await db.AdminUser.findOne({ where: { email } });
  if (!admin) throw new Error(`No admin with email ${email}.`);
  const before = admin.role;
  if (before === role) { console.log(`Admin #${admin.id} already has role ${role}. Nothing was changed.`); return; }
  if (permissionsForRole(before).includes("ERP_MANAGE") && !permissionsForRole(role).includes("ERP_MANAGE")) {
    const others = (await db.AdminUser.findAll({ where: { is_active: true } })).filter((a) => a.id !== admin.id && permissionsForRole(a.role).includes("ERP_MANAGE"));
    if (!others.length) throw new Error("Refused: this is the last active admin who can manage the ERP integration.");
  }
  await admin.update({ role });
  const { record, flush } = require("../services/erpAudit.service");
  record(db, { event: "ERP_RBAC_ROLE_CHANGED", tenantKey: process.env.ERP_TENANT_KEY || "DEFAULT", status: "OK", entityType: "ADMIN_USER", entityId: admin.id, metadata: { adminId: admin.id, from: before, to: role, via: "scripts/set-admin-role.js" } });
  await flush();
  console.log(`Admin #${admin.id} (${admin.email}): ${before} → ${role}.`);
}

main()
  .then(() => db.sequelize.close())
  .catch(async (err) => { console.error(`set-admin-role failed: ${err.message}`); try { await db.sequelize.close(); } catch { /* ignore */ } process.exit(1); });
