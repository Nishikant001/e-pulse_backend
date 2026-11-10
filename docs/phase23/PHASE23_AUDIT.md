# PHASE 23 — Audit (baseline, findings, plan)
Date 2026-10-11 (IST). Source of truth: `secondary_frontend_phase22.zip`, `secondary_backend_phase22.zip`. Evidence tags: **[CODE]** read in source · **[TEST]** automated test (SQLite) · **[BUILD]** Vite build · **[BROWSER]** headless Chromium (Playwright-core 1194) · **[NPM]** `npm audit`.

## 1. Baseline (before any change)
| Check | Result |
|---|---|
| Backend `npx jest --runInBand` [TEST] | 26 suites, **787 / 787** passed |
| Frontend `vite build` [BUILD] | OK; **one JS chunk 1,728.59 kB (431.31 kB gzip)**, CSS 94.41 kB (15.10 kB gzip); >500 kB warning |
| Frontend lint | **33 errors / 10 warnings** (pre-existing; identical to Phase 22) |
| Frontend `node --test` | 21 passed |
| `npm audit --omit=dev` [NPM] | frontend 16 (2 critical, 11 high); backend 8 (1 critical, 3 high) — see Security report |

## 2. Existing structure [CODE]
* Router: `BrowserRouter` in `App.jsx`; `/` **redirected to `/login`** (no public page). Public auth routes `/login /signup /forgot-password /reset-password`; Admin portal `/admin/*` (`AdminSessionRoot` → `AdminGuard`, server-confirmed session via `GET /api/admin/session`); Distributor `/dashboard/*` behind `ProtectedRoute` (UX gate only; real auth is the backend cookie + `authMiddleware`).
* Theme: Tailwind v4 `@theme` tokens in `src/styles/tokens.css` (brand blue 600 `#0066cc`, canvas/surface/line/ink, radius 8/12 px, restrained shadows, 120–260 ms motion tokens). Sidebar brand mark = `Pill` icon on a blue gradient tile + "Pharma DMS". **No logo file exists** (only the Vite default favicon). Fonts: system stack (Inter named but not loaded).
* Animation libs: `framer-motion` is installed; CSS motion primitives exist (`base.css`, reduced-motion handled). Phase 23 uses CSS only.
* SEO: `index.html` had one generic title/description, `robots.txt` with disallows only, no sitemap, no canonical, **empty `<div id="root">`** → crawlers receive no page content from the SPA. `login` hard-codes `http://localhost:5000` in 15 places (see §4).
* Backend: Express 5, `cors` (single origin), body limit 100 kb, request-context/correlation id, JSON error handler (no stacks), in-memory rate limiter on auth + admin endpoints, health `/api/health/live|ready`, httpOnly cookies (`secure` in production, `sameSite=lax`), graceful shutdown.

## 2b. Findings
| ID | Sev | Finding | Evidence | Action in Phase 23 |
|---|---|---|---|---|
| P1 | High (product) | No public website; `/` forces login | [CODE] | **Built** |
| P2 | High (SEO) | Empty SPA shell: no crawlable content, one title for all URLs | [CODE] `index.html` | **Prerender** public routes at build time |
| P3 | Med (perf) | Single 1.73 MB / 431 kB-gzip bundle for every visitor | [BUILD] | Route-level code splitting |
| S1 | Med | No security headers on API responses (nosniff, frame, CSP, Referrer, HSTS), no cache policy on authenticated JSON | [CODE]; [TEST] new | **Fixed** (middleware) |
| S2 | Med | Upload endpoints accept any file type (xlsx library has unfixable advisories) | [CODE] `routes/allRoutes.js` | **Fixed**: extension allow-list (xlsx/xls/csv) |
| S3 | Low | CORS accepts one origin only; no startup validation of production env | [CODE] | **Fixed**: comma list; `validateEnv()` (exit on missing/weak essentials in production only) |
| S4 | Low | No explicit connection timeouts | [CODE] | **Fixed** (tunable) |
| S5 | **High** | Dependency advisories (xlsx: no fix; proxy-addr critical; nodemailer; Vite dev-server) | [NPM] | **Not changed** — needs upgrade decision (Security report) |
| S6 | Info | `middleware/upload.js` stores files under client file name with no filter — **unused** (no import) | [CODE] grep | Left; recommend deletion |
| S7 | Med | Login/Signup/etc. use hard-coded `http://localhost:5000` (15 occurrences) → cannot work in production without a rebuild/proxy | [CODE] `grep` | **Not changed** (brief: preserve login flow) — documented |
| S8 | **High** | Non-ERP Admin RBAC missing (Phase 22 D6) | Phase 22 | **Untouched** per brief (no ENFORCE) |
| D4 | High | Fresh-install via migrations not verified; `sync()`+snapshot not approved | Phase 22 | **Untouched, not documented as supported** |

## 3. Plan executed
Public site + routing split → SEO prerender/sitemap/robots → backend hardening + tests → lazy private chunks → browser/a11y verification → reports/ZIPs. See other reports for results.

## 4. Decisions NOT taken
Admin RBAC enforcement · dependency upgrades (`npm audit fix --force` would be breaking) · replacing hard-coded API URLs · fresh-install procedure · adding a backend contact endpoint · production domain / legal entity / address (inputs required) · Retailer portal (none added).
