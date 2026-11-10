// services/inventoryRules.service.js
//
// The pharmaceutical inventory RULES in one place — pure functions and constants, no database access. The SQL in
// inventoryQuery.service.js expresses the same rules (a set-based version for server-side filtering/pagination) and is
// covered by parity tests, so the two cannot drift silently. The UI never derives a status: it displays what the API returns.
//
// Conventions (see docs/PHARMA_DMS_INVENTORY_BATCH_MANAGEMENT.md):
//   on hand        = SALEABLE-state balance + NON_SALEABLE-state balance   (everything physically in the warehouse)
//   saleable       = SALEABLE-state balance of a batch that is not expired and is active        (what a sale may consume)
//   non-saleable   = NON_SALEABLE-state balance + SALEABLE-state balance sitting in an expired / inactive batch
//   expired        = exp_date is set and earlier than "now"   (the SAME test inventory.service.allocateStock applies)

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Thresholds (documented defaults; overridable per deployment until a Settings module exists) ──────────────────────
// Near expiry: 90 days — the outermost bucket of the Phase 3 dashboard (30 / 60 / 90 = critical / high / medium).
const NEAR_EXPIRY_DAYS_DEFAULT = 90;
function getNearExpiryDays(env = process.env) {
  const n = Number(env.INVENTORY_NEAR_EXPIRY_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 730 ? n : NEAR_EXPIRY_DAYS_DEFAULT;
}

// Why stock is non-saleable. EXPIRED is also derived automatically for expired batches (never needs to be entered).
// REGULATORY_HOLD added in Phase 6 (FEFO & Expiry Management) — additive; non_saleable_reason is a STRING(30) column,
// so no migration is needed to add a reason.
const NON_SALEABLE_REASONS = {
  DAMAGED: "Damaged",
  EXPIRED: "Expired",
  QUALITY_ISSUE: "Quality issue",
  REGULATORY_HOLD: "Regulatory hold",
  RETURNED: "Returned",
  BLOCKED: "Blocked",
  OTHER: "Other",
};
const isNonSaleableReason = (r) => Object.prototype.hasOwnProperty.call(NON_SALEABLE_REASONS, r);

const STOCK_STATES = ["SALEABLE", "NON_SALEABLE"];

// ── Transaction types shown on the Stock Ledger ─────────────────────────────────────────────────────────────────────
// ONE table drives both the display label (classifyTransaction) and the SQL filter (inventoryQuery builds its predicate
// from `match`). reference types come from StockLedger.reference_type; `dir` restricts to IN / OUT when both exist.
const ADJUSTMENT_REFS = ["DAMAGE", "EXPIRY", "BREAKAGE", "PHYSICAL_COUNT", "CORRECTION", "ADJUSTMENT"];
const TXN_TYPES = {
  purchase: { label: "Purchase", match: [{ refs: ["PURCHASE"] }] },
  sale: { label: "Sale", match: [{ refs: ["SALES"] }] },
  sales_return: { label: "Sales Return", match: [{ refs: ["RETURN"], dir: "IN" }] },
  purchase_return: { label: "Purchase Return", match: [{ refs: ["RETURN"], dir: "OUT" }] },
  transfer: { label: "Stock Transfer", match: [{ refs: ["TRANSFER"] }] },
  adjustment: { label: "Adjustment", match: [{ refs: ADJUSTMENT_REFS }] },
  opening: { label: "Opening Stock", match: [{ refs: ["OPENING"] }] },
  status_change: { label: "Stock Status Change", match: [{ refs: ["RECLASSIFY"] }] },
};

function classifyTransaction(referenceType, movementType) {
  const dir = movementType === "OUT" ? "OUT" : "IN";
  for (const [key, t] of Object.entries(TXN_TYPES)) {
    if (t.match.some((m) => m.refs.includes(referenceType) && (!m.dir || m.dir === dir))) return { key, label: t.label };
  }
  return { key: "other", label: "Other" };
}

// ── Expiry / saleability / status ───────────────────────────────────────────────────────────────────────────────────
const asDate = (v) => (v instanceof Date ? v : v ? new Date(v) : null);

function isExpired(expDate, now = new Date()) {
  const d = asDate(expDate);
  return !!d && !Number.isNaN(d.getTime()) && d < now;
}
function expiryLimit(now = new Date(), nearDays = getNearExpiryDays()) {
  return new Date(now.getTime() + nearDays * DAY_MS);
}
function daysToExpiry(expDate, now = new Date()) {
  const d = asDate(expDate);
  return d && !Number.isNaN(d.getTime()) ? Math.ceil((d.getTime() - now.getTime()) / DAY_MS) : null;
}
// 'expired' | 'near_expiry' | 'healthy'  (no expiry date on file → 'healthy'; legacy batches may not have one)
function expiryStatus(expDate, now = new Date(), nearDays = getNearExpiryDays()) {
  const d = asDate(expDate);
  if (!d || Number.isNaN(d.getTime())) return "healthy";
  if (d < now) return "expired";
  return d < expiryLimit(now, nearDays) ? "near_expiry" : "healthy";
}

// ── Expiry buckets (Phase 6 — FEFO & Expiry Management) ────────────────────────────────────────────────────────────
// These are NOT a new threshold scheme: they reuse, unchanged, the near-expiry configuration the Phase 3 Admin
// Dashboard already shipped (services/adminDashboard.service.js: NEAR_EXPIRY_DAYS = {critical:30, high:60, medium:90}).
// The brief's own example buckets (180+/90-180/30-90/<30) are explicitly a fallback ("if the business document or
// existing configuration defines different thresholds, use those instead") — the Phase 3 dashboard IS that existing
// configuration, so its 30/60/90-day boundaries are used here too, and the dashboard is now upgraded (below and in
// adminDashboard.service.js) to source them, and its bucket totals, from this one function instead of a second copy.
// Internal keys (critical/high/medium/healthy/expired) match the dashboard's; EXPIRY_BUCKETS below supplies the
// user-facing labels (Critical/Near Expiry/Monitor/Healthy/Expired).
const EXPIRY_BUCKET_THRESHOLDS_DAYS = { critical: 30, high: 60, medium: 90 };

// 'expired' | 'critical' | 'high' | 'medium' | 'healthy'. Boundaries are half-open on the far edge: a batch expiring
// in exactly `critical` (30) days is 'high', not 'critical' — the same edge convention the Phase 3 dashboard uses.
function expiryBucket(expDate, now = new Date(), thresholds = EXPIRY_BUCKET_THRESHOLDS_DAYS) {
  const d = asDate(expDate);
  if (!d || Number.isNaN(d.getTime())) return "healthy"; // no expiry on file — same convention as expiryStatus()
  if (d < now) return "expired";
  if (d < new Date(now.getTime() + thresholds.critical * DAY_MS)) return "critical";
  if (d < new Date(now.getTime() + thresholds.high * DAY_MS)) return "high";
  if (d < new Date(now.getTime() + thresholds.medium * DAY_MS)) return "medium";
  return "healthy";
}

// Ordered worst-first; `days` is a short window label, used for filter options and legends only (never mixed with a
// batch's actual computed bucket, which always comes from expiryBucket() / the API).
const EXPIRY_BUCKETS = [
  { key: "expired", label: "Expired", days: "Past expiry" },
  { key: "critical", label: "Critical", days: `Under ${EXPIRY_BUCKET_THRESHOLDS_DAYS.critical} days` },
  { key: "high", label: "Near Expiry", days: `${EXPIRY_BUCKET_THRESHOLDS_DAYS.critical}–${EXPIRY_BUCKET_THRESHOLDS_DAYS.high - 1} days` },
  { key: "medium", label: "Monitor", days: `${EXPIRY_BUCKET_THRESHOLDS_DAYS.high}–${EXPIRY_BUCKET_THRESHOLDS_DAYS.medium - 1} days` },
  { key: "healthy", label: "Healthy", days: `${EXPIRY_BUCKET_THRESHOLDS_DAYS.medium}+ days` },
];
const EXPIRY_BUCKET_KEYS = EXPIRY_BUCKETS.map((b) => b.key);

// Split a batch's two ledger balances into what a sale may use and what it may not.
function splitBatchQuantities({ saleableState = 0, nonSaleableState = 0, expDate = null, batchActive = true }, now = new Date()) {
  const blocked = isExpired(expDate, now) || !batchActive;
  return {
    onHand: saleableState + nonSaleableState,
    saleable: blocked ? 0 : saleableState,
    nonSaleable: nonSaleableState + (blocked ? saleableState : 0),
    blocked,
  };
}

// Batch Stock status: 'out_of_stock' | 'expired' | 'non_saleable' | 'near_expiry' | 'healthy'.
// Low stock is a PRODUCT-level rule (reorder level), so it is intentionally not a batch status.
function batchStatus({ expDate, batchActive = true, saleableState = 0, nonSaleableState = 0 }, now = new Date(), nearDays = getNearExpiryDays()) {
  const q = splitBatchQuantities({ saleableState, nonSaleableState, expDate, batchActive }, now);
  if (q.onHand <= 0) return "out_of_stock";
  if (isExpired(expDate, now)) return "expired";
  if (!batchActive || q.saleable <= 0) return "non_saleable";
  return expiryStatus(expDate, now, nearDays) === "near_expiry" ? "near_expiry" : "healthy";
}

// Current Stock (product) status — precedence: any expired stock → expired; saleable at/below reorder level → low_stock;
// any near-expiry saleable stock → near_expiry; otherwise healthy. `productSaleable` is the product's saleable total across
// the distributor's warehouses (the reorder level is a product-level threshold). reorderLevel <= 0 / null disables low stock.
function productStatus({ expiredQty = 0, nearExpiryQty = 0, productSaleable = 0, reorderLevel = null }) {
  if (expiredQty > 0) return "expired";
  if (reorderLevel != null && reorderLevel > 0 && productSaleable <= reorderLevel) return "low_stock";
  if (nearExpiryQty > 0) return "near_expiry";
  return "healthy";
}

const PRODUCT_STATUSES = ["healthy", "low_stock", "near_expiry", "expired"];
const BATCH_STATUSES = ["healthy", "near_expiry", "expired", "non_saleable", "out_of_stock"];

// Valuation basis. The existing data model has ONE per-batch price (Batch.purchase_price), so stock value is COST value.
// (Same basis as the Phase 3 dashboard's "Inventory value".) MRP is shown as information, never multiplied into value.
const VALUATION = { basis: "COST", label: "Stock value at purchase cost (on-hand qty × batch purchase price)" };

module.exports = {
  NEAR_EXPIRY_DAYS_DEFAULT, getNearExpiryDays, NON_SALEABLE_REASONS, isNonSaleableReason, STOCK_STATES,
  ADJUSTMENT_REFS, TXN_TYPES, classifyTransaction, isExpired, expiryLimit, daysToExpiry, expiryStatus,
  splitBatchQuantities, batchStatus, productStatus, PRODUCT_STATUSES, BATCH_STATUSES, VALUATION,
  EXPIRY_BUCKET_THRESHOLDS_DAYS, expiryBucket, EXPIRY_BUCKETS, EXPIRY_BUCKET_KEYS,
};
