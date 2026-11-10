// Admin dashboard: single read-only aggregation endpoint. Protected by middleware/adminAuth.js (see routes/adminRoutes.js).
const db = require("../models");
const { resolveTenantKey } = require("../services/erp/tenantScope");
const { getAdminDashboardSummary, getErpHealthBlock, parseDay, toDay, daysBetweenInclusive } = require("../services/adminDashboard.service");

const MAX_RANGE_DAYS = 400;

// GET /api/admin/dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults to the current UTC month)
exports.summary = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const now = new Date();
    const firstOfMonth = `${now.toISOString().slice(0, 7)}-01`;
    const from = req.query.from ? String(req.query.from) : firstOfMonth;
    const to = req.query.to ? String(req.query.to) : toDay(now);

    const fromD = parseDay(from);
    const toD = parseDay(to);
    if (!fromD || !toD) return res.status(400).json({ message: "from and to must be valid dates (YYYY-MM-DD)" });
    if (fromD > toD) return res.status(400).json({ message: "from must be on or before to" });
    if (daysBetweenInclusive(fromD, toD) > MAX_RANGE_DAYS) {
      return res.status(400).json({ message: `The date range cannot exceed ${MAX_RANGE_DAYS} days` });
    }

    const data = await getAdminDashboardSummary(db, { from, to, now });
    // Phase 21: real ERP health instead of the old hard-coded "not_configured". Never throws and never blocks the dashboard (see getErpHealthBlock).
    let tenantKey = null;
    try { tenantKey = resolveTenantKey(req); } catch { /* invalid tenant key → treated as unavailable below */ }
    const erp = tenantKey ? await getErpHealthBlock(db, { tenantKey, role: req.admin && req.admin.role, now }) : { access: "UNAVAILABLE" };
    data.sap = { status: erp.configured ? "configured" : "not_configured", erp };
    return res.json(data);
  } catch (err) {
    console.error("admin dashboard summary error:", err.message);
    return res.status(500).json({ message: "Unable to load dashboard data" });
  }
};
