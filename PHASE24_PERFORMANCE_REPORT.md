# PHASE 24 — Performance Report

Measured with `vite build` on the same machine; gzip level 9. Lab build numbers, not field data.

| Metric | Phase 22 (baseline) | Phase 23 | Phase 24 |
|---|---|---|---|
| Initial JS (entry), raw | 1,728.59 kB (single chunk) | 317.74 kB | 315.24 kB |
| Initial JS, gzip | 431.31 kB | 97.05 kB | 98.26 kB |
| Shared `tokens` chunk | — | — | 306.51 kB (loaded with the entry; vendor/shared split by Vite) |
| Private app chunk (lazy) | in the single chunk | 110 kB (28.7 kB gz) | 105.7 kB |
| CSS | 94.41 kB | 102.01 kB (16.42 kB gz) | 101.56 kB (15.96 kB gz) |
| Home HTML (prerendered), gzip | n/a (empty shell) | 8.3 kB | 8.1 kB |
| Contact HTML, gzip | n/a | — | 3.0 kB |
| Unused dependencies | 6 | 6 | 0 |

Note: the entry+`tokens` chunks together are ~620 kB raw on the first public page load; the Phase 22 → 24 improvement is therefore the removal of the ~1.7 MB single chunk from the critical path of the public pages and lazy loading of the private app (Phase 23), not a further large Phase 24 gain. Phase 24 changes to size are small: removing 6 unused dependencies (no effect on the shipped bundle — they were not imported) and `StockMaster` now 11.5 kB (4.1 kB gz).

## Reviewed
- Images/fonts: the only image asset is `favicon.svg` (551 B); no web fonts or third-party font requests (system font stack). Nothing to optimize.
- Code splitting: private app and every private page are lazy; public pages are eager for prerender.
- Duplicate API calls: Batch Master loads `/stock`, `/product`, `/stockLedger/batch` once per load (3 calls, no repeats observed in the E2E).
- Loading states: Batch Master uses `LoadingState`/`ErrorState`/`EmptyState`.

## Not done / recommendations (no numbers claimed)
- Compression and cache headers are a host concern: serve `/assets/*` (hashed) with `Cache-Control: public, max-age=31536000, immutable`, HTML with `no-cache`, enable brotli/gzip. **API responses are `no-store` (verified) and must stay uncacheable** — authenticated/tenant data is never cached.
- Backend: no DB query/index tuning was performed in Phase 24 (no load test or slow-query data) — NOT VERIFIED. Existing indexes from earlier phases untouched.
- Lighthouse / Core Web Vitals: NOT MEASURED.
