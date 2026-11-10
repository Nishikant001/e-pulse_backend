#!/usr/bin/env node
/**
 * Creates the first (or an additional) Admin portal user.
 *
 * Usage (password comes from the environment so it never lands in shell history if you use `read -s`):
 *   read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
 *   ADMIN_NAME="Your Name" ADMIN_EMAIL="you@company.com" node scripts/create-admin.js
 *
 * - No default credentials exist anywhere in the code base.
 * - It only INSERTS one row into admin_users. It never updates or deletes anything and never creates/alters tables:
 *   run the migration first (npx sequelize-cli db:migrate) — see docs/PHARMA_DMS_ADMIN_DASHBOARD.md.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../models");
const { ASSIGNABLE_ROLES, normaliseRole } = require("../config/erpPermissions");

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const name = (process.env.ADMIN_NAME || "").trim();
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const role = normaliseRole(process.env.ADMIN_ROLE || "ADMIN"); // Phase 17: optional ADMIN_ROLE (default ADMIN keeps the old behaviour)
  if (!ASSIGNABLE_ROLES.includes(role)) throw new Error(`ADMIN_ROLE must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set ADMIN_NAME and a valid ADMIN_EMAIL.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const tables = await db.sequelize.getQueryInterface().showAllTables();
  const names = tables.map((t) => (typeof t === "string" ? t : t.tableName));
  if (!names.includes("admin_users")) {
    throw new Error("Table admin_users does not exist. Run the migration first: npx sequelize-cli db:migrate");
  }

  const existing = await db.AdminUser.findOne({ where: { email } });
  if (existing) throw new Error(`An admin with email ${email} already exists. Nothing was changed.`);

  const password_hash = await bcrypt.hash(password, 12);
  const admin = await db.AdminUser.create({ name, email, password_hash, role, is_active: true });
  console.log(`Created admin #${admin.id} (${admin.email}).`);
}

main()
  .then(() => db.sequelize.close())
  .catch(async (err) => {
    console.error(`create-admin failed: ${err.message}`);
    try {
      await db.sequelize.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
