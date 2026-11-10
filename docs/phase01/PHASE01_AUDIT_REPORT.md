# PHASE 01 — AUDIT REPORT

Scope: audit only. No source behaviour, schema, permission or data was changed. Evidence level is marked on every finding:

- **[CONFIRMED]** – read directly in the supplied source (file path given).
- **[TESTED]** – a command was actually executed (see `PHASE01_TEST_RESULTS.md`).
- **[SUSPECTED]** – plausible from the code, needs runtime verification.
- **[RECOMMENDATION]** – design advice, not a fact about the current code.

---

## 1. What was supplied

| Item | Finding |
|---|---|
| Frontend ZIP `f3169ad0-secondary_frontend_phase24.zip` | 2,001,350 bytes. Contains **both** projects (`secondary_backend_phase24/` and `secondary_frontend_phase24/`), 701 files. |
| Backend ZIP `857265f2-secondary_backend_phase24.zip` | Same size, different SHA-256 from the frontend ZIP, but `diff -rq` of the two extracted trees reports **identical content**. Both ZIPs are therefore the same combined archive. The audit treats the two project folders inside as the source of truth. |
| Requirements file `639ace06-attachment.txt` | Read in full. |
| Secrets in the ZIPs | **Both projects ship a real `.env`.** Backend `.env` holds a DB password, `JWT_SECRET`, `ADMIN_JWT_SECRET`, SMTP user/password (`EMAIL_PASS`). Values are **not reproduced** in any document. Frontend `.env` only holds `VITE_API_BASE_URL` (public). **Recommendation: treat the backend secrets as exposed and rotate them**, then keep `.env` out of every archive. The Phase 1 delivery ZIPs exclude `.env`. |
| Other junk | `uploads/` (empty, `.gitkeep`), `scratch-sa.html` + `src/scratch-sa.jsx` (scratch files in the frontend), 24 phase-numbered markdown files in each project root. No DB dumps found. `node_modules`/`dist` were not in the ZIPs. |
| Naming | ZIPs are called `phase24`, but the code contains "Phase 25" artefacts (Super Admin, migration `20261012090000-super-admin-phase25`). The earlier project's phase numbers (1–25) are **unrelated** to the new Phase 1–7 plan in the requirements file. This report uses "Phase N" only for the new plan; older labels are written as "legacy Phase N". |

## 2. Project structure and technology stack

### Backend — `secondary_backend_phase24/`
- Node (tested on v22.22.0), **Express 5.1**, **Sequelize 6.37** over **mysql2** (production dialect from `DB_DIALECT`; tests use in-memory **sqlite3**), JWT (`jsonwebtoken`), `bcryptjs`, `multer`, `nodemailer`, `xlsx 0.18.5`.
- Entry point `server.js` (86 lines). Route files: `routes/adminRoutes.js` (`/api/admin/*`), `routes/publicRoutes.js` (`/api/public/*`), `routes/allRoutes.js` (`/api/*`, Distributor).
- 52 model files, 46 controllers (42 import `../models` directly), 41 services (+ 23 files in `services/erp/`), 11 middleware, 41 migrations, 30 test files.
- Build/test scripts: `npm test` = `jest --runInBand`; `create-admin`. No Dockerfile, CI config or `.sequelizerc` (the CLI still loads `config/config.js` — verified).
- Env variables are documented in `.env.example` (DB_*, JWT_SECRET, ADMIN_JWT_SECRET, SMTP, CORS_ORIGIN, TRUST_PROXY, ERP_*, rate-limit tunables). Production start-up refuses weak/missing essentials (`config/envCheck.js`).

### Frontend — `secondary_frontend_phase24/`
- **React 19, Vite 7, Tailwind 4, React Router 7, axios, recharts**; ESM. Public marketing pages are pre-rendered at build (`scripts/prerender.mjs`); the authenticated app is one lazy chunk (`src/PrivateApp.jsx`).
- Three entry areas in one SPA: Distributor (`/dashboard/*`, `src/components/Distributers/…` + shared `src/features/…`), Admin and Super Admin (`/admin/*`, `src/features/admin*`, `src/features/superAdmin`).
- Navigation is configuration-driven: `src/config/navigation.js` (Distributor model), `src/config/adminNavigation.js` (derived from the same model, items re-marked `planned`), `src/config/portals.js` (portal definitions; filters Distributor Management and SAP groups out of the Distributor portal).
- Env: `VITE_API_BASE_URL` (+ `VITE_SITE_URL` for SEO). A production build **refuses a localhost `VITE_API_BASE_URL`** (`vite.config.js`).

## 3. Architecture findings

1. **One shared database, tenant = distributor row.** [CONFIRMED] `models/index.js` creates one Sequelize connection from `DB_*`. Business tables carry `distributor_id` (or `distributor_code` on GL/journal). There is no `Company`/`Tenant` table and no per-tenant connection manager.
2. **Admin has no tenant.** [CONFIRMED] `models/adminuser.model.js` has no company/tenant column. `services/erp/tenantScope.js` says so explicitly and resolves every admin to one `ERP_TENANT_KEY` (default `DEFAULT`). All `/api/admin/*` list/read services are cross-distributor.
3. **Only ownership signal:** `Distributors.created_by_admin_id` (nullable, no FK) added by migration `20261012090000-super-admin-phase25`, set in `services/adminDistributors.service.js:362` when an Admin creates a distributor. Self-signup (`auth.signup`) and everything before the migration are `NULL`.
4. **"Retailer" is a `Customer` row.** [CONFIRMED] `services/retailers.service.js` header and `docs/PHARMA_DMS_RETAILER_MANAGEMENT.md`. There is no Retailer table. This makes requirements A.5 (retain Customer Master) and A.6 (remove retailer options from Accounts) overlap — see §8 decisions.
5. **Three separate identities.** Distributor (table `Distributors`, cookie `access_token`/`refresh_token`, `JWT_SECRET`), Admin/Super Admin (table `admin_users`, cookie `adminAccessToken` scoped to `/api/admin`, `ADMIN_JWT_SECRET`, role re-read from DB every request), Retailer (none). Good separation — a Distributor token cannot satisfy Admin auth and vice-versa.
6. **Roles.** `admin_users.role` ∈ `SUPER_ADMIN, ERP_ADMIN, ERP_OPERATOR, ERP_VIEWER, ADMIN`. The role table (`config/erpPermissions.js`) governs **only ERP routes**.
7. **Admin portal surface is wider than the Admin sidebar.** Admin API has live sales-order/invoice, secondary-sales, inventory, masters, distributors, retailers, schemes, claims, accounts, ERP and Super Admin routes (`routes/adminRoutes.js`). There is **no** Admin API for sales returns, credit notes, customers (other than via `/retailers`), reports, settings, or notifications.
8. **Dual implementations of the same business areas.** Distributor portal (legacy per-distributor pages in `src/components/Distributers/dashboard`) and Admin portal (feature modules in `src/features`) are separate code paths; `features/inventory`, `features/accounts`, `features/retailers`, `features/claims` are shared with a `portal` prop.
9. **Sample/mock data exists in the Admin frontend.** [CONFIRMED] `features/adminDashboard/sampleData.js`, `features/adminSales/sample/*`, `features/inventory/sample/*`; a persisted "Live/Sample" switch (`localStorage` key `dms.admin.dashboard.source`, default `live`). Not a backend fake, but a requirement-relevant item: "no fake statistics" must be re-checked before Phase 2 removes or hides screens that offer a Sample switch.

## 4. Security findings

### 4.1 Confirmed
| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **High** | **No role-based authorization on Admin writes.** Every non-ERP admin route uses only `requireAdmin` (any active admin). An `ERP_VIEWER` can create/edit distributors, approve/settle claims, post payments, change credit limits, create orders etc. `scripts/route-inventory.js` (executed): of 55 Admin write routes only 14 (the ERP ones) have a role guard; **39 have none**, matching `docs/phase24_admin_unguarded_writes.txt`. Totals: 130 Admin routes, 186 Distributor routes, 7 unauthenticated Distributor routes (signup, login, logout, refresh-token, forgot-password, reset-password, verify-otp). | `routes/adminRoutes.js`; `scripts/route-inventory.js` output; role table `config/erpPermissions.js` comments ("every other Admin route keeps … any active Admin session"). |
| S2 | **High** (for multi-company) | **No company isolation between Admins.** Any admin reads and writes every distributor's data. The moment a second company/Admin exists, it sees the first company's data. This is the blocker for database-per-Admin. | `models/adminuser.model.js`; admin services have no `created_by_admin_id`/tenant filter (grep: only `adminDistributors.create` and `superAdmin.service` use it). |
| S3 | **High** | **Distributor refresh token is usable as an access token and deactivation is not enforced on it.** Access and refresh tokens are signed with the same `JWT_SECRET` and carry identical claims; `auth.middleware.js` accepts any valid token (cookie or `Authorization: Bearer`) without a type claim and never re-reads the distributor. A deactivated distributor keeps API access until the token expires (1 day access, 30 days refresh). `refreshToken` also does not re-check status. Only some controllers (retailers, claims, accounts, sales-order create) re-read status. Also the access cookie `maxAge` is 15 min while the JWT lives 1 day. | `controllers/auth.controller.js` (login, refreshToken), `middleware/auth.middleware.js`. |
| S4 | Medium | **Self-signup creates an active distributor with no approval**; response on failure returns `error.message` (400 bodies are not sanitised). Pollutes network counts (`Unassigned`). | `controllers/auth.controller.js` `signup`; model default `status: "active"`. |
| S5 | Medium | **Password-reset weaknesses:** OTP from `Math.random`, stored in plaintext, compared with `!==`; "Email not found" (404) enables account enumeration (as does "Email already registered" on signup); throttling is per IP (30/min across all distributor auth routes), not per account. | `controllers/auth.controller.js`; `middleware/rateLimiter.js`. |
| S6 | Medium | **Code generators cap the network.** `Distributors.distributor_code` is `STRING(6)` generated as `DTC###` → ceiling **DTC999** (a 1,000th distributor would not fit 6 chars). Generator also reads "last row by createdAt" (race-prone) and the signup handler's own 10-digit generator is overwritten by the model hook. Customers have the same `CTR###` ceiling (documented in `docs/PHARMA_DMS_RETAILER_MANAGEMENT.md`). Codes are **global**, not per company. | `models/distributor.model.js`; `controllers/auth.controller.js`. |
| S7 | Medium (latent) | Unrouted legacy controllers `controllers/delivery.controller.js` and `controllers/invoice.controller.js` use unscoped `findByPk(req.params.id)` and `destroy`. Their routes are commented out in `allRoutes.js`, so they are not reachable **today**; re-enabling them would create cross-tenant access. | `delivery.controller.js:115,139,176`; `invoice.controller.js:146,191,209`. |
| S8 | Medium | **Vulnerable dependency:** `xlsx@0.18.5` (high: prototype pollution, ReDoS; **no fix available**) is used for bulk upload; `uuid` moderate via sequelize. Frontend: 0 vulnerabilities. | `npm audit` (executed). |
| S9 | Medium | Real `.env` committed into both ZIPs. | ZIP listing. |
| S10 | Low | Hiding is not access control: planned entries have no route (→ `AdminNotFound`), but **routed pages that are only hidden from the menu remain reachable by URL and their APIs stay live** (e.g. `/admin/retailers`, `/admin/sales/secondary`, `/admin/sap/*`). | `src/PrivateApp.jsx`, `routes/adminRoutes.js`. |
| S11 | Low | Dead/legacy frontend code reads `localStorage["token"]` (never set by the cookie-based login). `src/utils/api.js`, `Invoice.jsx`, `Viewinvoice.jsx`, `Delivery.jsx`. | grep. |

### 4.2 Suspected — needs runtime verification
- **CSRF** on cookie-authenticated writes: cookies are `SameSite=Lax`, bodies are JSON-only (`text/plain` forms yield an empty body → 400), no CSRF token exists. Risk is low but unverified in a browser.
- **OTP brute force** across many IPs against one account (see S5).
- **Rate limiter is in-memory per process**; multiple instances multiply the limits.
- **MySQL 8 behaviour**: the project's Phase 24 report verified MariaDB 10.11 and SQLite only; Oracle MySQL is **not verified**.

### 4.3 Verified strengths (keep)
Separate admin secret/cookie/path; fail-closed if `ADMIN_JWT_SECRET` is weak or equals `JWT_SECRET`; admin role and `is_active` re-read from the DB each request; distributor controllers consistently scope by `req.user.id` (spot-checked delete/update paths for product, batch, pricing, groups, credit/debit notes, returns, purchase documents); parameterised queries with replacements; error sanitiser for 5xx; security headers; bounded body size; production env validation; upload filter (xlsx/xls/csv, 10 MB, random file names); failed-login limiter for admin login.

## 5. Database and tenant findings (summary — details in `PHASE01_DATABASE_ARCHITECTURE.md`)
- Shared DB, row-level tenant = distributor. No DB-per-tenant, no provisioning, no storage metering, no export/backup/migration-to-other-DB code exists (grep for `information_schema`, `mysqldump`, `CREATE DATABASE`, backup: zero hits).
- **Migrations are an upgrade path, not an install path.** [CONFIRMED statically + project Phase 24 report] The first migration alters `Products`; only 27 `createTable` calls exist (26 named tables + the scheme link tables created in a loop), the other core tables come from `sequelize.sync()` (56 tables in total per the project report). Project report: fresh `db:migrate` fails at migration #1; 8 migrations fail over a sync-built schema; 10 `down()` fail. A per-company database cannot be provisioned from migrations today.
- `sequelize.sync()` is gated to `NODE_ENV=development && DB_SYNC=true`; `DB_FORCE=true` drops all tables (dev only, documented).
- No FK on `created_by_admin_id`; many foreign keys are `constraints: false` (item/vendor group links).
- Ownership attribution: only `created_by_admin_id` is reliable, and only for distributors created via the Admin portal after the Phase-25 migration. No audit table records distributor onboarding (the ERP audit trail is ERP-only). Historical rows cannot be attributed — they must remain **Unassigned**.

## 6. Requirement coverage snapshot (details in `PHASE01_MODULE_INVENTORY.md`)

| Req | State today | Gap |
|---|---|---|
| A1 Hide Sales Creation | Admin has `/admin/sales/orders/new` + `POST /admin/sales/orders` live | Hide UI, **block POST/PUT/confirm/cancel/create-invoice server-side** |
| A2 Sales Returns view-only | Admin nav item is `planned`; **no Admin returns page or API exists** | Must be *built* read-only in the Admin portal (new GET endpoints); distributor write endpoints are untouched |
| A3 Credit Notes unchanged | Admin item `planned`; no Admin API; Distributor credit notes live | Nothing to preserve in Admin beyond "stay as is" — decision needed (see §8) |
| A4 Hide planned masters | Already `planned` (hidden by default; toggle shows them) | Remove from config, not only toggle |
| A5 Retain Customer Master | Admin "Customer Master" is `planned` (no route); data is exposed as Retailer List | Decision: map Customer Master → existing retailer pages |
| A6 No retailer account options | Admin Accounts is built around RETAILER entities (Outstanding, Ledger, Payments, Credit) | High impact — decision needed |
| A7 Hide ERP (Admin) | 5 live pages + ~35 live APIs + scheduler started in `server.js` | Hide UI; decide API/scheduler policy |
| A8 No Secondary Sales in Reports | Reports group is all `planned`; Secondary Sales exists under Sales | Remove `rpt-secondary`; decide on `/admin/sales/secondary` |
| A9 Ledger/SAP Sync/Settings in Distributor Mgmt | Ledger planned; no SAP Sync item; Settings planned | Build or route to real screens |
| A10 Hide planned DM modules | Planned; shown only via toggle | Remove from config |
| B1 Hide FEFO, Masters, Schemes & Claims, Financial View (Distributor) | All live | Hide nav; routes/APIs remain |
| B2 No vendor options in Distributor Accounts | "Vendor Ledger", vendor payments exist | Hide/remove |
| B3 "My Ledger" | `finance/ledger` is read-only own books; Customer/Vendor ledgers are accounting views. **No distributor↔admin primary-transaction model exists** (no primary sales/purchase from company to distributor; only scheme-claim account) | Cannot be claimed complete; decision needed |
| B5 Settings | Planned, no page | Build in a later phase |
| B7 Reports (Sales, Stock, Expiry, Scheme, Returns, Outstanding, PO) | All `planned`, no report page/API | None exist; PO report not even in the model |
| C Super Admin dashboard | `/admin/super-admin` live: admin count, distributors per admin, unassigned, retailers total | Matches C.1–C.4 partially; no Reports; ERP hiding pending |
| D DB per company | Not present | See database document |
| E Export/migration | Not present | See database document |

## 7. Confirmed issues / risks / blockers (ranked)
1. **B-1 No company/tenant model** — blocks D, C-accuracy, and secure multi-company use (S2).
2. **B-2 Migrations cannot create a fresh database** — blocks DB-per-company provisioning.
3. **B-3 Admin write authorization absent** (S1) — must be solved before "view-only" can be trusted (requirement A2 explicitly demands backend enforcement).
4. **B-4 Retailer = Customer ambiguity** — blocks A5/A6 without a product decision.
5. **B-5 "My Ledger" has no data model for distributor↔admin transactions.**
6. R-1 Token handling (S3); R-2 secrets shipped (S9); R-3 xlsx vuln (S8); R-4 code ceilings (S6).
7. Quality: frontend ESLint fails (33 errors, 9 warnings — mostly unused variables, one `process` undefined in `vite.config.js`); production frontend build fails with the shipped `.env` (guard, by design) and succeeds with `VITE_API_BASE_URL=/api`.

## 8. Decisions that cannot be made from source alone
1. Retailer vs Customer: hide Retailer List *and* Retailer account options but keep **Customer Master** — which page/API backs "Customer Master" in Admin, and what replaces the retailer-keyed Outstanding/Ledger/Payments/Credit screens (which are the only receivable tooling in Admin)?
2. Admin Credit Notes and Sales Returns: Admin has no screen for either. Is Phase 3 expected to **build** read-only views, or only "keep hidden"?
3. ERP: hide only the Admin/Super Admin UI, or also disable `/api/admin/erp-*` and the in-process scheduler (`ERP_SCHEDULER_ENABLED`)?
4. "My Ledger": what are the distributor↔admin transactions (primary sales/purchase, payments to company, claim settlements)? Today only scheme-claim settlements exist.
5. Company model: is a *company* = one Admin user, or a company with many admin users? (Affects `created_by_admin_id` semantics and DB naming.)
6. Existing data: how will existing distributors be assigned to companies (manual by Super Admin with an audit trail; never inferred)?
7. Target DB engine for per-company databases (MySQL/MariaDB assumed from current stack) and hosting limits on database count.
8. Export scope: include uploaded documents? Which formats are mandatory in the first release?
