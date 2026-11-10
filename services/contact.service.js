// services/contact.service.js — Phase 24. Public "Contact us" enquiry: validation + delivery by e-mail. Nothing is stored (no fake records).
//
// Delivery needs REAL infrastructure, configured only through the environment (never sent to the browser):
//   CONTACT_TO_EMAIL (recipient)  CONTACT_SMTP_HOST  [CONTACT_SMTP_PORT=587] [CONTACT_SMTP_SECURE=false] [CONTACT_SMTP_USER / CONTACT_SMTP_PASS] [CONTACT_FROM_EMAIL = CONTACT_SMTP_USER]
// Without CONTACT_TO_EMAIL + CONTACT_SMTP_HOST the endpoint answers 503 CONTACT_NOT_CONFIGURED — it never pretends to have delivered.
const nodemailer = require("nodemailer");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\-\s\d.]{6,25}$/;
const strip = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max + 1);
const oneLine = (v, max) => strip(v, max).replace(/[\r\n]+/g, " ");

/** → { valid, errors, value } (value only when valid). Strings only; anything else is rejected rather than coerced. */
function validateEnquiry(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = {};
  for (const k of ["name", "email", "organisation", "phone", "message", "website"]) if (b[k] !== undefined && typeof b[k] !== "string") errors[k] = "must be text";
  const name = oneLine(b.name, 100), email = oneLine(b.email, 254), organisation = oneLine(b.organisation, 120), phone = oneLine(b.phone, 25), message = strip(b.message, 2000);
  if (name.length < 2 || name.length > 100) errors.name = "Name must be 2–100 characters.";
  if (!EMAIL.test(email) || email.length > 254) errors.email = "A valid email address is required.";
  if (organisation.length > 120) errors.organisation = "Organisation is too long.";
  if (phone && !PHONE.test(phone)) errors.phone = "Phone number is not valid.";
  if (message.length < 20 || message.length > 2000) errors.message = "Message must be 20–2000 characters.";
  if (typeof b.website === "string" && b.website.trim()) errors.website = "rejected"; // honeypot field: people never fill it
  const valid = Object.keys(errors).length === 0;
  return { valid, errors, value: valid ? { name, email, organisation, phone, message } : undefined };
}

let injected = null; // tests
const setTransportForTests = (t) => { injected = t; };

function config(env = process.env) {
  const to = (env.CONTACT_TO_EMAIL || "").trim(); const host = (env.CONTACT_SMTP_HOST || "").trim();
  if (!to || !host || !EMAIL.test(to)) return null;
  return { to, host, port: Number(env.CONTACT_SMTP_PORT) || 587, secure: env.CONTACT_SMTP_SECURE === "true", user: env.CONTACT_SMTP_USER || "", pass: env.CONTACT_SMTP_PASS || "", from: (env.CONTACT_FROM_EMAIL || env.CONTACT_SMTP_USER || to).trim() };
}
const isConfigured = (env = process.env) => Boolean(injected) || Boolean(config(env));

/** Sends the enquiry. Resolves on success, throws on failure (caller maps to 502). */
async function deliver(value, env = process.env) {
  const cfg = config(env);
  const transport = injected || (cfg && nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 }));
  if (!transport) throw Object.assign(new Error("not configured"), { code: "NOT_CONFIGURED" });
  const text = [`Name: ${value.name}`, `Email: ${value.email}`, `Organisation: ${value.organisation || "-"}`, `Phone: ${value.phone || "-"}`, "", value.message].join("\n");
  await transport.sendMail({ from: cfg ? cfg.from : "contact@localhost", to: cfg ? cfg.to : "contact@localhost", replyTo: value.email, subject: `Pharma DMS website enquiry — ${value.name}`.slice(0, 150), text });
}

module.exports = { validateEnquiry, deliver, isConfigured, setTransportForTests, config };
