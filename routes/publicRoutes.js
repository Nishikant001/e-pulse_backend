// /api/public/* — the only unauthenticated, non-credential API surface. Keep it tiny; every route here needs its own abuse protection.
const express = require("express");
const { rateLimit } = require("../middleware/rateLimiter");
const contact = require("../controllers/public.contact.controller");

const router = express.Router();
const perWindow = () => { const n = Number(process.env.RATE_LIMIT_CONTACT_PER_15MIN); return Number.isFinite(n) && n >= 0 ? n : 5; };
router.post("/contact", rateLimit("public-contact", { max: perWindow, windowMs: 15 * 60 * 1000, key: (req) => `ip:${req.ip || "unknown"}` }), contact.submit);

module.exports = router;
