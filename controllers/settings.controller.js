// controllers/settings.controller.js — e-Pulse Phase 1: Distributor-portal Settings. Identity comes ONLY from the token.
//   GET  /api/settings                  own profile (never returns the password hash or reset fields)
//   PUT  /api/settings/profile          only contact person + phone number are editable here; name, code, email, tax numbers and status
//                                       are controlled by the administrator and cannot be changed through this endpoint
//   POST /api/settings/change-password  requires the current password
const bcrypt = require("bcryptjs");
const db = require("../models");

const PHONE = /^\+?[0-9][0-9\s-]{7,14}$/;

const shape = (d) => ({
  code: d.distributor_code, name: d.name, email: d.email, phone: d.phone_number || null, contactPerson: d.contact_person || null,
  gstin: d.tax_no || null, pan: d.pan || null, city: d.city || null, state: d.region || null, pincode: d.postal_code || null,
  territory: d.territory || null, paymentTerms: d.payment_terms || null, status: d.status,
  address: [d.street1, d.street2, d.street3, d.street4].filter(Boolean).join(", ") || null,
});

async function load(req, res) {
  res.set("Cache-Control", "no-store");
  const id = req.user && Number(req.user.id);
  if (!id) { res.status(401).json({ message: "Unauthorized" }); return null; }
  const d = await db.Distributor.findOne({ where: { id } });
  if (!d) { res.status(401).json({ message: "Unauthorized" }); return null; }
  return d;
}

exports.get = async (req, res) => {
  try {
    const d = await load(req, res);
    if (!d) return undefined;
    return res.status(200).json(shape(d));
  } catch (err) {
    console.error("settings get error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const d = await load(req, res);
    if (!d) return undefined;
    const body = req.body || {};
    const errors = {};
    const patch = {};
    if (body.contactPerson !== undefined) {
      const v = String(body.contactPerson || "").trim();
      if (v.length > 150) errors.contactPerson = "Contact person is too long";
      else patch.contact_person = v || null;
    }
    if (body.phone !== undefined) {
      const v = String(body.phone || "").trim();
      if (!v) errors.phone = "Phone number is required";
      else if (!PHONE.test(v)) errors.phone = "Enter a valid phone number (8–15 digits)";
      else patch.phone_number = v;
    }
    if (Object.keys(errors).length) return res.status(400).json({ message: "Please correct the highlighted fields", code: "VALIDATION", details: errors });
    if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to update", code: "BAD_REQUEST" });
    await d.update(patch);
    return res.status(200).json(shape(d));
  } catch (err) {
    console.error("settings update error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const d = await load(req, res);
    if (!d) return undefined;
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required", code: "BAD_REQUEST" });
    }
    if (newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ message: "New password must be 8–72 characters", code: "VALIDATION" });
    if (newPassword === currentPassword) return res.status(400).json({ message: "New password must be different from the current password", code: "VALIDATION" });
    const ok = d.password ? await bcrypt.compare(currentPassword, d.password) : false;
    if (!ok) return res.status(400).json({ message: "Current password is incorrect", code: "WRONG_PASSWORD" });
    await d.update({ password: await bcrypt.hash(newPassword, 10) });
    return res.status(200).json({ message: "Password changed" });
  } catch (err) {
    console.error("settings password error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
};
