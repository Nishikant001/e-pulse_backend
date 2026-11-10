# PHASE 23 — Performance report
All numbers are from `vite build` output on this machine (**[BUILD]**, sizes as printed). **No Lighthouse, Core Web Vitals, or runtime timing was measured — NOT VERIFIED.**

## Baseline → after
| Metric | Baseline (Phase 22) | After Phase 23 |
|---|---|---|
| JS needed by a first-time visitor (entry) | 1,728.59 kB (**431.31 kB gzip**) — whole app | 317.74 kB (**97.05 kB gzip**) entry: React, router, public site |
| Authenticated app | in the same chunk | lazy `PrivateApp` shell 110 kB (28.7 kB gzip) + one lazy chunk per page + shared chunks (charts/tokens 307 kB lazy) |
| >500 kB chunk warning | yes | **none** for entry; (largest lazy chunk: `tokens` 307 kB) |
| CSS | 94.41 kB (15.10 kB gzip) | 102.01 kB (16.42 kB gzip) — +public styles |
| Prerendered HTML (home, gzip) | 0.43 kB empty shell | 8.3 kB with content (first paint without JS) |
| Build time | ~9 s | ~25 s (adds SSR build + prerender) |

Interpretation: the ~77 % reduction in entry gzip size applies to **public visitors** (the login page additionally loads the 28.7 kB-gzip `PrivateApp` shell); signed-in users now download the shell plus the pages they open (total bytes across all pages are about the same, deferred). Perceived improvement is plausible but **unmeasured**.

## Reviewed, not changed (no evidence of a bottleneck)
Images (none added; two login PNGs 70/90 kB pre-existing) · fonts (system stack; no layout-shift source) · API duplication / React re-renders / table virtualisation / DB indexes and query patterns — **not profiled this phase; nothing changed** · HTTP compression and static caching are web-server concerns (recommended: gzip/brotli, `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, `no-cache` for HTML). **No caching of authenticated API responses was added; the API now sends `no-store` by default.**
Known remaining: `framer-motion`, `html2pdf.js`, `pdfmake`, `jspdf`, `recharts` are heavy dependencies loaded only inside lazy private chunks; consider lazy-importing PDF libraries at click time (not done).
