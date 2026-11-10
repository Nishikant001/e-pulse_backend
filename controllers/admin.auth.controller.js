// Admin portal authentication (separate from the Distributor auth in auth.controller.js).
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../models");
const { getAdminAuthConfig } = require("../config/adminAuth.config");
const { createFailureLimiter } = require("../middleware/failureLimiter");
const { resolveAdminSession } = require("../middleware/adminAuth");

const BCRYPT_COST = 12;
const ipLimiter = createFailureLimiter({ max: 20 }); // 20 failures / 15 min per IP
const idLimiter = createFailureLimiter({ max: 5 }); // 5 failures / 15 min per IP + email

// Compared against when the email is unknown, so response time does not reveal whether an email exists.
let dummyHash;
const getDummyHash = () => dummyHash || (dummyHash = bcrypt.hashSync("not-a-real-password", BCRYPT_COST));

const { permissionsForRole } = require("../config/erpPermissions");
const publicAdmin = (a) => ({ id: a.id, name: a.name, email: a.email, role: a.role, erpPermissions: permissionsForRole(a.role) });

exports.login = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const cfg = getAdminAuthConfig();
    if (!cfg.secret) return res.status(503).json({ message: "Admin portal is not configured" });

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password || email.length > 190 || password.length > 256) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const ipKey = `ip:${req.ip}`;
    const idKey = `id:${req.ip}|${email}`;
    const wait = Math.max(ipLimiter.blockedFor(ipKey), idLimiter.blockedFor(idKey));
    if (wait > 0) {
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      return res.status(429).json({ message: "Too many failed sign-in attempts. Please try again later." });
    }

    const admin = await db.AdminUser.findOne({ where: { email } });
    const passwordOk = await bcrypt.compare(password, admin ? admin.password_hash : getDummyHash());

    if (!admin || !admin.is_active || !passwordOk) {
      ipLimiter.recordFailure(ipKey);
      idLimiter.recordFailure(idKey);
      return res.status(401).json({ message: "Invalid email or password" });
    }

    idLimiter.reset(idKey);
    await admin.update({ last_login_at: new Date() });

    const token = jwt.sign({ portal: "admin", typ: "admin_access", role: admin.role }, cfg.secret, {
      algorithm: "HS256",
      subject: String(admin.id),
      issuer: cfg.issuer,
      audience: cfg.audience,
      expiresIn: cfg.expiresInSeconds,
    });

    res.cookie(cfg.cookieName, token, { ...cfg.cookieOptions, maxAge: cfg.expiresInSeconds * 1000 });
    return res.json({ admin: publicAdmin(admin) });
  } catch (err) {
    console.error("admin login error:", err.message);
    return res.status(500).json({ message: "Unable to sign in right now" });
  }
};

exports.logout = (req, res) => {
  const cfg = getAdminAuthConfig();
  res.set("Cache-Control", "no-store");
  res.clearCookie(cfg.cookieName, cfg.cookieOptions);
  return res.json({ message: "Signed out" });
};

// Requires requireAdmin. Returns the identity the UI displays — the UI never derives identity from localStorage.
exports.me = (req, res) => res.json({ admin: req.admin });

// Public "who am I?" probe used by the Admin UI on load. Unlike /me it answers 200 for a visitor without a session
// ({ authenticated: false }) so an ordinary sign-in page visit does not produce a 401 error in the browser console.
// It reveals nothing except whether the caller's own cookie is a valid Admin session.
exports.session = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const session = await resolveAdminSession(req);
    if (session.ok) return res.json({ authenticated: true, admin: session.admin });
    if (session.status === 503) return res.status(503).json({ message: session.message });
    return res.json({ authenticated: false });
  } catch (err) {
    console.error("admin session error:", err.message);
    return res.status(500).json({ message: "Unable to verify admin session" });
  }
};
