// controllers/public.contact.controller.js — Phase 24. POST /api/public/contact (unauthenticated by design; no tenant data is read or written).
const { sendError } = require("../middleware/errorHandler");
const svc = require("../services/contact.service");

exports.submit = async (req, res) => {
  const v = svc.validateEnquiry(req.body);
  if (!v.valid) return sendError(res, req, 400, "VALIDATION_FAILED", "Please check the highlighted fields.", { fields: Object.keys(v.errors).filter((k) => k !== "website").length ? Object.fromEntries(Object.entries(v.errors).filter(([k]) => k !== "website")) : undefined });
  if (!svc.isConfigured()) return sendError(res, req, 503, "CONTACT_NOT_CONFIGURED", "Contact delivery is not configured on this server.");
  try {
    await svc.deliver(v.value);
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ success: true, message: "Your message has been sent." });
  } catch (err) {
    // Never log the message body, address or SMTP error text (may echo credentials/hosts): name + correlation id only.
    console.error(`[contact] delivery failed cid=${req.correlationId || "-"} ${err && err.name}`);
    return sendError(res, req, 502, "CONTACT_DELIVERY_FAILED", "Your message could not be sent. Please try again later.");
  }
};
