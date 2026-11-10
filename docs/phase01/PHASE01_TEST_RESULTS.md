# PHASE 01 — TEST RESULTS

Environment: Linux container, Node v22.22.0, npm 10.9.4, **no database server** (no MySQL/MariaDB), no network beyond the package registry. Both projects were extracted into separate directories and installed with `npm ci`. Every result below was actually executed; nothing is inferred.

## 1. Commands executed

| # | Project | Command | Result |
|---|---|---|---|
| 1 | Backend | `npm ci --no-audit --no-fund` | **Passed** — 530 packages. Deprecation warnings only (`uuid@8`, `glob@10`). |
| 2 | Frontend | `npm ci --no-audit --no-fund` | **Passed.** |
| 3 | Backend | `npx jest --runInBand --silent` | **Passed — 30 suites, 846 tests, 0 failed** (248.7 s). Runs on in-memory SQLite (`NODE_ENV=test` switches `config/db.config.js`), so no real database or `.env` DB credentials were used. |
| 4 | Frontend | `npx eslint .` | **Failed — 42 problems (33 errors, 9 warnings)** across 23 files. Rule breakdown: 32 `no-unused-vars`, 1 `no-undef` (`process` in `vite.config.js:10`), 9 `react-hooks/exhaustive-deps` (warnings). No security-relevant rule fired. Not fixed (Phase 1 forbids source changes). |
| 5 | Frontend | `node --test` | **Passed — 48 tests, 0 failed.** Covers helper modules only (api URL resolver, escapeHtml, dashboard model, ERP decision view, batch master, vendor lookup, public pages). There are no component, route or navigation tests. |
| 6 | Frontend | `npm run build` (with the shipped `.env`) | **Failed** at `vite.config.js`: "VITE_API_BASE_URL points at a local address (http://localhost:5000/api); set the real API URL or leave it unset…". This is an intentional production guard triggered by the dev value in the shipped `.env`, not a code defect. |
| 7 | Frontend | `VITE_API_BASE_URL=/api npm run build` | **Passed** (client build 12 s, SSR build, 9 public routes prerendered). Warning: `VITE_SITE_URL not set — canonical URLs, JSON-LD and sitemap.xml were NOT generated`. |
| 8 | Frontend | `VITE_API_BASE_URL=/api npm run verify:dist` | **Passed — 104/104 checks** (robots, titles, noindex on private shell; sitemap intentionally absent without `VITE_SITE_URL`). |
| 9 | Backend | `npm audit --omit=dev` | **3 vulnerabilities (2 moderate, 1 high):** `xlsx` (high; prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9; **no fix available**), `uuid` <11.1.1 and its dependent `sequelize` (moderate; fix would downgrade Sequelize — not applied). |
| 10 | Frontend | `npm audit` | **0 vulnerabilities.** |
| 11 | Backend | `NODE_ENV=test node scripts/route-inventory.js --json` | **Passed** (read-only; builds the real routers, no DB). 130 Admin routes (55 writes, 14 role-guarded, **39 unguarded**), 186 Distributor routes, 7 unauthenticated Distributor routes. |
| 12 | Backend | `npx sequelize-cli db:migrate:status` | CLI loaded `config/config.js`; **blocked** at connection (`ECONNREFUSED 127.0.0.1:3306`, no DB). No change made. |
| 13 | Both | `diff -rq` of the two extracted ZIPs; `sha256sum` | The two ZIPs differ in bytes (different SHA-256) but their extracted trees are **identical**. |
| 14 | Frontend | esbuild bundle + execution of `src/config/adminNavigation.js` and `portals.js` | Produced the exact live/planned navigation tables used in the module inventory. |

## 2. Blocked / not run (with reason)
| Item | Reason | Outstanding verification |
|---|---|---|
| Migrations (`db:migrate`, `down`) and `scripts/migration-audit.py` | needs a disposable MySQL/MariaDB; none installed, no network to fetch one | Re-run on staging. Findings in the DB document marked **[REPORTED]** come from `PHASE24_DATABASE_MIGRATION_REPORT.md` and were **not** reproduced here. |
| Oracle MySQL 8 behaviour of the app/raw SQL | no engine available | Verify before Phase 5. |
| Server start (`node server.js`), live API calls, login flows | needs DB + secrets; real `.env` values deliberately not used | Smoke test on staging with fresh secrets. |
| Browser/runtime checks of hidden-page direct URL access, CSRF, cookie flags, OTP brute-force | no running stack | Listed as *suspected* in the audit report. |
| Frontend lint after fixes | no source change allowed in Phase 1 | Fix in Phase 2. |
| Any test against production or real customer data | **deliberately not done** | — |

## 3. What the passing tests do and do not prove
- 846 backend tests exercise controllers/services through real Express routers on SQLite, including security (`security-phase23`), Super Admin (`superadmin-phase25`), ERP, returns, accounts, inventory. They do **not** prove MySQL-specific SQL behaviour (back-ticked raw SQL) — the project's own report found one MariaDB-only failure (`erp-business-phase18`, DATETIME precision) and 10 failing `down()` migrations.
- No automated test exists for: Admin **role** enforcement on non-ERP writes (because none exists), hidden-route behaviour, navigation configuration, the Distributor token-type/deactivation behaviour, or cross-company isolation (no company concept).
- A successful build/test run is **not** treated as evidence that any requirement is implemented.

## 4. Manual verification still required
1. Staging DB: run all migrations over a sync-built schema and from empty; record failures vs the Phase 24 report.
2. Log in as Distributor, deactivate it as Admin, and check whether the existing session still reads data (finding S3).
3. Log in as an `ERP_VIEWER` admin and attempt a non-ERP write (finding S1).
4. Open each hidden-but-routed URL (`/admin/retailers`, `/admin/sales/secondary`, `/admin/sap/dashboard`, `/dashboard/inventory/fefo`) to confirm they stay reachable until Phase 2.
5. Check production proxy/cookie settings (`secure`, `SameSite`, `TRUST_PROXY`, `CORS_ORIGIN`).
6. Confirm the shipped secrets were rotated.
