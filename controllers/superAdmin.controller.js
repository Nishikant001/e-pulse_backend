// controllers/superAdmin.controller.js — Phase 25. Routes sit behind requireAdmin + requireSuperAdmin (routes/adminRoutes.js).
const db = require("../models");
const bcrypt = require("bcryptjs");
const { ASSIGNABLE_ROLES, ROLE_PERMISSIONS, PERMISSIONS, normaliseRole } = require("../config/erpPermissions");
const svc = require("../services/superAdmin.service");
const { QueryError } = require("../services/salesQuery");
const { sendError } = require("../middleware/errorHandler");

async function handle(req, res, fn) {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return sendError(res, req, 404, "NOT_FOUND", "Admin not found");
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof QueryError) return sendError(res, req, 400, "BAD_REQUEST", err.message);
    console.error("super admin error:", err && err.message);
    return sendError(res, req, 500, "INTERNAL_ERROR", "Unable to complete the request");
  }
}

exports.overview = (req, res) => handle(req, res, () => svc.getOverview(db));

exports.adminDistributors = (req, res) => handle(req, res, () => svc.listAdminDistributors(db, req.params.id));
exports.networkDistributors = (req, res) => handle(req, res, () => svc.listNetworkDistributors(db));
exports.onboardingRequests = (req, res) => handle(req, res, () => svc.listOnboardingRequests(db));
exports.roles = (req, res) => handle(req, res, async () => ({
  permissions: PERMISSIONS,
  roles: ASSIGNABLE_ROLES.map((role) => ({
    id: role,
    name: role.replace(/_/g, " "),
    permissions: ROLE_PERMISSIONS[role] || [],
  })),
}));

exports.createAdmin = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = normaliseRole(req.body?.role || "ERP_ADMIN");
    if (!name || name.length > 120) return sendError(res, req, 400, "VALIDATION_FAILED", "Name is required and must be at most 120 characters");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 190) return sendError(res, req, 400, "VALIDATION_FAILED", "Enter a valid email address (maximum 190 characters)");
    if (password.length < 12 || password.length > 256) return sendError(res, req, 400, "VALIDATION_FAILED", "Password must be between 12 and 256 characters");
    if (!ASSIGNABLE_ROLES.includes(role)) return sendError(res, req, 400, "VALIDATION_FAILED", "Select a supported admin role");
    const existing = await db.AdminUser.findOne({ where: { email } });
    if (existing) return sendError(res, req, 409, "EMAIL_EXISTS", "An admin with this email already exists");
    const password_hash = await bcrypt.hash(password, 12);
    const admin = await db.AdminUser.create({ name, email, password_hash, role, is_active: true });
    console.info(`[super-admin] admin=${req.admin.id} created admin=${admin.id} role=${role}`);
    return res.status(201).json({
      admin: {
        id: Number(admin.id), name: admin.name, email: admin.email, role: admin.role,
        isActive: !!admin.is_active, lastLoginAt: null, createdAt: iso(admin.createdAt),
        distributorsCreated: 0, activeDistributors: 0, inactiveDistributors: 0, pendingDistributors: 0,
      },
    });
  } catch (err) {
    if (err && err.name === "SequelizeUniqueConstraintError") return sendError(res, req, 409, "EMAIL_EXISTS", "An admin with this email already exists");
    console.error("super admin create admin error:", err && err.message);
    return sendError(res, req, 500, "INTERNAL_ERROR", "Unable to create the admin account");
  }
};

