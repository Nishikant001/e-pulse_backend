// Tiny in-memory failed-attempt limiter (no dependency). Used by the Admin login only.
// Single-process: behind multiple instances use a shared store (e.g. Redis) in a later hardening phase.

function createFailureLimiter({ windowMs = 15 * 60 * 1000, max = 5, maxKeys = 5000 } = {}) {
  const entries = new Map(); // key -> { count, resetAt }

  const prune = (now) => {
    if (entries.size <= maxKeys) return;
    for (const [key, entry] of entries) if (entry.resetAt <= now) entries.delete(key);
  };

  return {
    // milliseconds until the key may try again (0 = not blocked)
    blockedFor(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return 0;
      if (entry.resetAt <= now) {
        entries.delete(key);
        return 0;
      }
      return entry.count >= max ? entry.resetAt - now : 0;
    },
    recordFailure(key, now = Date.now()) {
      prune(now);
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= now) entries.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

module.exports = { createFailureLimiter };
