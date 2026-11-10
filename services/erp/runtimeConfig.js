// services/erp/runtimeConfig.js — Phase 17. Safe reading of numeric environment settings. A typo ("abc"), a negative number or an absurd value
// (ERP_SYNC_AUTO_MAX_RETRIES=1000000000) must never switch a safety limit off, so every value is clamped to a documented range.
function envInt(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

const MIN = 60 * 1000;
/** Scheduler / worker limits (read on every call so tests and operators can change them without a restart). */
const scheduler = () => ({
  maxAutoRetries: envInt("ERP_SYNC_AUTO_MAX_RETRIES", 3, 0, 10),
  retryBaseMinutes: envInt("ERP_SYNC_AUTO_RETRY_BASE_MINUTES", 2, 1, 60),
  retryMaxDelayMinutes: envInt("ERP_SYNC_AUTO_RETRY_MAX_DELAY_MINUTES", 120, 1, 1440),
  maxConcurrent: envInt("ERP_SYNC_MAX_CONCURRENT", 2, 1, 20),
  staleMs: envInt("ERP_SYNC_STALE_MINUTES", 15, 2, 240) * MIN,
  shutdownGraceMs: envInt("ERP_SHUTDOWN_GRACE_SECONDS", 20, 1, 600) * 1000,
  intervalMs: envInt("ERP_SCHEDULER_INTERVAL_SECONDS", 30, 5, 600) * 1000,
});

module.exports = { envInt, scheduler, MIN };
