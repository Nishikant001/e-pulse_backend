# Pharma DMS — Admin Dashboard (Phase 3)

| | |
|---|---|
| **Scope** | Admin portal shell at `/admin/*`; the **Admin Dashboard** (`/admin/dashboard`); a minimal, separate Admin authentication boundary; migration of the old generic Distributor `Dashboard.jsx` to pharma content |
| **Not touched** | Distributor login and its 7 auth endpoints, `/dashboard/*` routes, Distributor navigation, Phase 1 tenant-scoping/mass-assignment fixes, existing tables and data |
| **Built on** | Phase 2 design system (`AppShell`, `Sidebar`, `Header`, `KpiCard`, `ChartCard`, `DataTable`, `ActivityCard`, `AlertCard`, `StatusBadge`, `SapStatusIndicator`, `DateRangePicker`, …) — **nothing was rebuilt** |
| **New dependencies** | **None** (frontend or backend) |
| **Companion docs** | `PHARMA_DMS_ARCHITECTURE_AUDIT.md`, `PHARMA_DMS_MODULE_MAPPING.md`, `PHARMA_DMS_UI_UX_FOUNDATION.md` |

## 0. Verification status — read first

**Verified in the audit sandbox**

| Area | Method | Result |
|---|---|---|
| Backend aggregation service | **Real SQL** executed on SQLite against a hand-calculated seed (3 distributors, 7 invoices, 5 orders, 3 returns, 6 batches, 10 ledger rows, journal entries) with the *real* service, controller, middleware and router code; `jsonwebtoken`, `bcryptjs`, `express` and the ORM were stand-ins | 67 / 67 checks pass — every KPI, bucket, ranking, growth %, alert, and boundary case (`draft`/`cancelled` excluded, zero-balance batches ignored, previous-period alignment, weekly bucketing, validation errors, no SQL leakage) |
| Admin authentication boundary | Same harness | Distributor tokens rejected in the admin cookie, as Bearer and in `/session`; wrong portal claim / audience / expired / deactivated admin rejected; unknown email and wrong password answer identically; 5 failures lock IP+email (429 + `Retry-After`); missing / short / equal-to-`JWT_SECRET` `ADMIN_JWT_SECRET` → 503 (fails closed) |
| Admin + Distributor UI behaviour | Headless Chromium, React 19 (dev build), real `App.jsx` and real page code, mocked network, real backend JSON fixtures | **87 / 87** browser checks pass: access boundary, 8 KPIs, sections, date-range → API wiring (every preset + custom + clear), sample mode, loading / empty / error / session-expiry states, sidebar, search, tablet (900 px) and mobile (390 px) structure, accessibility sweep, distributor dashboard migration; **no console errors or warnings** |
| Existing Distributor portal | Same harness vs. the original upload | All 34 `/dashboard` routes and 4 auth pages render with no new console errors; Distributor login guard, `Sign out` → `POST /api/logout` unchanged (4 / 4); Phase 2 design-system suite still 76 / 76 |
| Static | TypeScript parser + semantic check, esbuild bundle of the whole app, token-class check | 151 files, 0 problems |

**NOT verified — please do these locally before sign-off**

1. **`npm install`, `npm run lint`, `npm run build`, the real dev server, Jest (`npm test`): not run** (no registry access in the sandbox).
2. **Nothing has been seen rendered with Tailwind.** Layout, spacing, the 1440 / 900 / 390 px *visual* results and "no horizontal page overflow" are **unverified**; only viewport-driven *behaviour* (sidebar rail/drawer, stacked table cards) was tested. Grid children use `min-w-0` and tables scroll inside their own container to prevent overflow, but this must be checked by eye.
3. **Charts were not rendered.** Recharts was replaced by an empty stub in the harness, so chart props/appearance are unverified beyond syntax. What *was* verified: their data, legends, `role="img"` labels and the hidden data tables that mirror them.
4. **The SQL was run on SQLite, not MySQL.** It uses only portable syntax and was reviewed for MySQL rules (`ONLY_FULL_GROUP_BY`, reserved-word aliases, derived-table aliases), but it has not been executed on MySQL 8 / mysql2 / Sequelize.
5. **Real `jsonwebtoken` / `bcryptjs` / Sequelize / react-router / lucide-react were not used** (stand-ins only). Newly used lucide icons to double-check at build time: `Compass`, `Plug`, `UserPlus`, `Clock`, `Hourglass`.
6. Jest tests for the new backend code are **not included** (they could not be run); the sandbox harness is not shipped. Use `docs/scripts/phase3_admin_smoke_test.sh` against a running backend instead (§10).
7. **The senior's requirements document and the standalone demo were not provided.** Business definitions below are engineering assumptions, listed explicitly, to be validated.

## 1. Admin dashboard structure

Route tree (`App.jsx`):

```
/admin                     AdminSessionRoot   owns Admin session STATE (asks the server; nothing stored in the browser)
  /admin/login             AdminLoginPage     separate from the Distributor login
  (layout) AdminGuard      renders only after the server confirms an Admin session → AdminLayout = AppShell(adminPortal)
     /admin                → redirect to /admin/dashboard
     /admin/dashboard      AdminDashboardPage
     /admin/*              AdminNotFound      "This page is not available" (planned modules are not routed)
/dashboard/*               Distributor portal — unchanged
```

`AdminLayout` reuses the **same** `AppShell`/`Sidebar`/`Header` as the Distributor portal, fed by `adminPortal` (`config/portals.js`) — no second sidebar or header exists. `AppShell` gained three optional inputs: `identity` (server-confirmed), `onLogout`, and `portal.defaultRangePresetId` (Admin opens on **This month**). Distributor behaviour is unchanged when they are absent.

**Admin navigation** (`config/adminNavigation.js`) is *derived from* the Distributor navigation model (so the two cannot drift): Dashboard (live) · Sales (Sales Orders, Sales Invoices, Secondary Sales, Sales Returns, Credit Notes) · Inventory (7) · Masters (Product, Batch, Distributor, Retailer, Customer, Pricing, Scheme, Tax) · Distributor Management (5) · Retailer Management (5) · Schemes & Claims · Accounts · SAP Integration · Reports · Notifications · Audit Logs · Settings. **Only Dashboard is a link**; everything else is muted, non-clickable and announced as "planned" — no fake screens.

**Dashboard layout** (`features/adminDashboard/AdminDashboardPage.jsx`), rows exactly as briefed:

| Row | Content | Grid |
|---|---|---|
| 1 | Page header + range/comparison badge + **Live / Sample** switch + refresh | — |
| 2 | 8 KPI cards (`KpiCard`) | 1 / 2 / 4 columns |
| 3 | Secondary Sales Trend · Distributor Performance | 2 : 1 at ≥ 1280 px |
| 4 | Product Category Sales · Stock Movement | 2 columns at ≥ 1024 px |
| 5 | Near Expiry Inventory · SAP Status | 2 : 1 at ≥ 1280 px |
| 6 | Top 10 Products · Top 10 Distributors (`DataTableCard`) | 2 columns at ≥ 1280 px |
| 7 | Recent Activity (`ActivityCard`) · Alerts (`AlertCard`) | 2 columns at ≥ 1024 px |

Each section is its own card (no giant container). States: skeleton loading everywhere, `ErrorState` "Unable to load dashboard data" + **Retry**, `EmptyState` per section (never a chart of fake zeros), and a "No sales recorded in this period" notice.

## 2. KPI definitions

`totalSecondarySales`, `todaysOrders` etc. come from `GET /api/admin/dashboard/summary`. **Assumptions in italics need business confirmation.**

| KPI | Definition | Follows date range? | Trend |
|---|---|---|---|
| Total Secondary Sales | *Σ `netValue` (before GST) of sales invoices with status POSTED / PARTIALLY_PAID / PAID*, by `invoiceDate` | Yes | % vs previous period |
| Today's Orders | Sales orders with status CONFIRMED / PARTIALLY_DELIVERED / FULLY_DELIVERED / CLOSED (not DRAFT, not CANCELLED), `orderDate` = today (UTC) | No — always today | % vs yesterday |
| Active Distributors | Distinct distributors with ≥ 1 counted invoice **or** order in the range; footer "of N registered" | Yes | — |
| Active Retailers | Distinct customers with ≥ 1 counted invoice or order in the range; *customer = retailer* (Phase 1 mapping); footer "of N registered" | Yes | — |
| Current Inventory | Σ (stock-ledger balance × batch `purchase_price`) over batches with a **positive** balance, all distributors. Balance = ΣIN − ΣOUT (same rule as `inventory.service`). Batches with no purchase price contribute ₹0 | No — as of now | — |
| Near Expiry Stock | Same valuation for positive-balance batches expiring within **90 days** (excludes already-expired) | No — as of now | — |
| Sales Returns | Σ (`quantity × pricePerUnit`) of lines of POSTED sales returns, by `returnDate` | Yes | % vs previous period; **increase shown as negative** |
| Outstanding | Σ (debit − credit) on every distributor's **"Accounts Receivable"** GL journal entries (the app's own ledger; GL `opening_balance` is ignored exactly as the existing ledger/TB reports do). `—` if no receivable GL exists | No — as of now | — |

Near-expiry severity: **Critical** < 30 days, **High** 30–59, **Medium** 60–89 (*engineering defaults — the requirements were not available; constants in `adminDashboard.service.js`, returned in `meta.nearExpiryThresholdsDays`, and stated on the card*).

Formatting: Indian style — `₹2.48 Cr`, `₹18.7 Cr`, `₹42.8 L`, `₹8.4 L`, `₹6.72 Cr`, `1,248`, `12,842`; tables show whole rupees (`₹18,42,000`). Trend text always includes the direction word for screen readers.

## 3. Data sources

Priority applied: **(1)** existing endpoint → **(2)** existing aggregation → **(3)** new safe read-only aggregation → **(4)** clearly separated sample data.

| Section | Live source | Notes |
|---|---|---|
| KPIs, trend, distributors, categories, top products, stock movement | **New** `GET /api/admin/dashboard/summary` (cross-distributor aggregation of *existing* tables) | No existing endpoint aggregates across distributors, so (3) was genuinely required |
| Near-expiry, inventory value, alerts | Same endpoint (stock ledger + batches + products) | Point-in-time |
| Recent activity | Same endpoint: latest sales orders / invoices / returns (non-draft) | **Not an audit log** — no audit records exist or were fabricated |
| Alerts | Same endpoint | Only conditions the data can prove: critical / high near-expiry, expired stock still on hand, products at/below `reorder_level` |
| SAP status | Backend states `not_configured` | Honest; header chip agrees |
| Credit-limit, SAP-failure, pending-claim alerts; SAP statistics | **Not available live** (no such modules/data) | Appear **only** in Sample mode, labelled |

**Live / Sample switch** (page header; remembered per browser in `localStorage["dms.admin.dashboard.source"]`, default **Live**): *Live* calls the API; *Sample* renders the demo layer with a persistent "Sample data" banner and never calls the API.

## 4. Demo data used

All in **one file**: `features/adminDashboard/sampleData.js`. It is deterministic (no `Math.random`), fictitious (no personal data), and returns the **same raw shape as the API**, so it is replaced 1-for-1 by live data. Headline values are the brief's reference figures (₹2.48 Cr / 1,248 / 486 / 12,842 / ₹18.7 Cr / ₹42.8 L / ₹8.4 L / ₹6.72 Cr; near-expiry ₹8.2 L / ₹14.6 L / ₹20.0 L). Verified: trend sums to exactly ₹2.48 Cr, category shares sum to 100 %, near-expiry buckets sum to the KPI, ranks are sorted, growth agrees with previous values. Sample mode **ignores the date range** (a fixed 30-day illustration) and says so. In Sample mode SAP *connection status remains "not configured"*; only the statistics are illustrative and labelled.

## 5. API endpoints used

| Endpoint | Used by | New? |
|---|---|---|
| `GET /api/admin/session` | Admin UI on load — `200 { authenticated }` either way (no 401 console noise) | **New** |
| `POST /api/admin/login`, `POST /api/admin/logout` | Admin sign-in / sign-out | **New** |
| `GET /api/admin/me` | strict identity (401 if not admin) | **New** |
| `GET /api/admin/dashboard/summary?from&to` | Admin dashboard (one request per load) | **New** |
| `GET /api/customer/count`, `/sales-delivery/count`, `/salesorder/count`, `/stock/count` | Distributor dashboard (unchanged, same response keys) | Existing |

## 6. New API endpoints, table and setup

All Admin endpoints live in `routes/adminRoutes.js`, mounted **before** the Distributor routes (`server.js`: one added line).

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /api/admin/login` | none (credentials) | Verifies bcrypt hash (cost 12); constant-effort compare when the email is unknown; generic error; 5 failures / 15 min per IP+email and 20 per IP → `429` + `Retry-After`; sets the Admin cookie; returns `{ admin }` only (no token in the body) |
| `POST /api/admin/logout` | none | Clears the Admin cookie |
| `GET /api/admin/session` | none | `{ authenticated:false }` or `{ authenticated:true, admin }`; `503` if the portal is not configured |
| `GET /api/admin/me` | Admin | `{ admin }` |
| `GET /api/admin/dashboard/summary` | Admin | `from`, `to` = `YYYY-MM-DD` (default: current UTC month); ≤ 400 days; `400` on bad input; generic `500` (no SQL/detail leaked); `Cache-Control: no-store` |

**New table — `admin_users`** (additive; no existing table is read or changed): `id`, `name`, `email` (unique), `password_hash`, `role` (label only — default `ADMIN`; **not enforced**, RBAC is a later phase), `is_active`, `last_login_at`, `createdAt`, `updatedAt`.

**Setup (do these in order; back up the database first):**

1. `.env`: add `ADMIN_JWT_SECRET` — **≥ 32 chars and different from `JWT_SECRET`** (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`). Optional `ADMIN_ACCESS_TOKEN_TTL_MINUTES` (default 240, max 1440). Without a valid secret the Admin API answers 503 (fails closed). See `.env.example`.
2. Create the table — **either** the migration: `npx sequelize-cli db:migrate --config config/config.js` (runs *all pending* migrations; check first with `db:migrate:status --config config/config.js`), **or** run the equivalent DDL yourself:
   ```sql
   CREATE TABLE admin_users (
     id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(120) NOT NULL,
     email VARCHAR(190) NOT NULL UNIQUE,
     password_hash VARCHAR(255) NOT NULL,
     role VARCHAR(40) NOT NULL DEFAULT 'ADMIN',
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     last_login_at DATETIME NULL,
     createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   );
   ```
   Rollback (only this table): `DROP TABLE admin_users;` (the migration's `down` does the same). Never enable `DB_FORCE`.
3. Create the first admin (no default credentials exist in the code): `read -s ADMIN_PASSWORD && export ADMIN_PASSWORD` then `ADMIN_NAME="…" ADMIN_EMAIL="…" npm run create-admin` (≥ 12-char password; insert-only; refuses to overwrite).
4. Restart the backend, open `/admin/login`.

## 7. Date-range handling

The Admin shell opens on **This month**; the header `DateRangePicker` offers **Today, Yesterday, This week (Mon→today), This month, Previous month, This quarter (Indian FY quarter: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar), This financial year (1 Apr →), Last 7 / 30 days**, and a **custom** from/to (with validation). The range is stored in the shell context (`useDateRange`) and passed to the data hook → service → `?from=&to=`; one request per change, in-flight requests aborted, no polling. `Clear` falls back to This month.

Server side: the range is applied to sales, orders, returns, categories, products, distributors, active counts, trend and stock movement; the **previous period** is the same length immediately before `from`; inventory, near-expiry, outstanding, alerts and activity are **snapshots** (declared in `meta.appliedTo`, and stated on the page). Today's Orders always means today.

Limitations (honest): day boundaries are **UTC** (`meta.timezone`) — late-evening IST activity can land on the next UTC date; Sample mode ignores the range; trend/movement are grouped daily ≤ 62 days, weekly ≤ 200, otherwise 30-day buckets.

## 8. Chart data structure

`GET /api/admin/dashboard/summary` returns (abridged; the sample layer returns the identical shape):

```jsonc
{
  "meta":  { "generatedAt", "range": {"from","to"}, "previousRange": {...}, "asOf", "timezone": "UTC",
             "appliedTo": { "range": [...], "today": [...], "snapshot": [...] }, "nearExpiryThresholdsDays": {"critical":30,"high":60,"medium":90} },
  "kpis":  { "totalSecondarySales": {"value","previous","changePct"}, "todaysOrders": {...}, "activeDistributors": {"value","registered"},
             "activeRetailers": {...}, "currentInventory": {"value","units","batches"}, "nearExpiryStock": {"value","batches"},
             "salesReturns": {"value","previous","changePct","count"}, "outstanding": {"value"} },       // outstanding.value may be null
  "salesTrend":    { "granularityDays", "points": [ {"date","current","previous"} ] },                   // aligned by index
  "distributors":  [ {"rank","id","code","name","territory","sales","previousSales","growthPct","orders","outstanding","status"} ],  // top 10
  "categories":    [ {"name","sales","share"} ],                                                          // ≤ 8, tail folded into "Other"
  "stockMovement": { "unit":"units", "granularityDays", "points": [ {"date","stockIn","stockOut","salesReturns","adjustments"} ] },
  "nearExpiry":    { "buckets": { "critical|high|medium": {"batches","products","units","value"} }, "totals": {...}, "expired": {...} },
  "topProducts":   [ {"rank","name","category","sales","quantity","growthPct"} ],
  "activity":      [ {"id","module","action","status","reference","distributor","at"} ],
  "alerts":        [ {"id","code","tone","count","value?"} ],        // structured; UI maps code → text
  "sap":           { "status": "not_configured" }                    // sample adds "stats" (labelled)
}
```
`growthPct` is `null` when the previous period had no data (shown as "—" with a screen-reader note). Stock-movement buckets (units): *Stock In* = IN of OPENING/PURCHASE; *Stock Out* = OUT of SALES/RETURN (sales, purchase returns); *Sales Returns* = IN of RETURN; *Adjustments* = DAMAGE/EXPIRY/BREAKAGE/PHYSICAL_COUNT/CORRECTION/ADJUSTMENT (absolute units) — *assumed mapping*. Category = `Product.category` text (blank → "Uncategorised"); top products are grouped by normalised product **name** across distributors (product ids are per distributor).

Front-end model: `dashboardModel.normalizeDashboard(raw, {source})` adds chart labels and `hasData` flags and rejects malformed responses (→ error state).

## 9. Responsive behaviour

Uses the Phase 2 shell: **Desktop ≥ 1024 px** full/collapsible sidebar and multi-column grids; **Tablet 768–1023 px** icon rail (menu button opens the drawer); **Mobile < 768 px** drawer navigation, KPI cards 1–2 columns. Tables scroll horizontally inside their card; the two Top-10 tables switch to **stacked cards** below 768 px (title = product / distributor via the new optional `DataTable` prop `cardTitleKey`). The distributor bar chart shortens names and the axis on phones. Every chart has a text alternative and a hidden data table. *(Visual result unverified — see §0.)*

## 10. Security boundary

| Control | Implementation |
|---|---|
| Separate identity | `admin_users` table; Distributor table untouched |
| Separate signing key | `ADMIN_JWT_SECRET` (≥ 32 chars, ≠ `JWT_SECRET`, else 503) — a Distributor token **cannot verify** as an Admin token |
| Separate cookie | `adminAccessToken`: `HttpOnly`, `SameSite=Lax`, `Secure` in production, **`Path=/api/admin`** (never sent to Distributor endpoints), ~4 h |
| Token checks | HS256 only, issuer, audience, `portal="admin"`, `typ="admin_access"`, expiry; admin re-loaded from the DB on every request (deactivation is immediate) |
| No client trust | The Admin guard renders only after `GET /api/admin/session` confirms a session; identity is *never* read from `localStorage`; backend refuses every `/api/admin/*` data call without the cookie (`Authorization` header, request body and Distributor cookies are ignored) |
| Brute force | In-memory limiter: 5 failures per IP+email and 20 per IP per 15 min; generic errors; unknown-email timing equalised |
| Privacy | `Cache-Control: no-store`; no password hash or token in any response body; generic 500s |
| Distributor flow | `/login /signup /logout /refresh-token /forgot-password /verify-otp /reset-password`, `authMiddleware`, `allRoutes.js`, credential pages, `authFetch`, `ProtectedRoute`: **unchanged** |

Verified in the harness (§0): distributor session cannot open admin routes (UI and API), an admin session cannot open the Distributor portal, sign-out uses `POST /api/admin/logout` only, nothing admin-related is stored in the browser. `phase3_admin_smoke_test.sh` re-checks the same boundary against a running backend:
`ADMIN_EMAIL=… ADMIN_PASSWORD='…' [DIST_EMAIL=… DIST_PASSWORD=…] bash docs/scripts/phase3_admin_smoke_test.sh`.

## 11. Known limitations

1. **Not run against MySQL / real npm stack / real rendering** (see §0). Please run `npm run build`, `npm test`, the smoke script, and look at the page at 1440 / 900 / 390 px.
2. **Business definitions are assumptions** (sales = pre-GST invoice value, near-expiry windows, outstanding = receivable ledger, stock movement mapping, categories from free-text `Product.category`, "active" = had a counted document in the range). The requirements document was not available.
3. **Sample data mode ignores the date range** by design.
4. Live alerts cover only detectable conditions; credit-limit, SAP-failure and claims alerts need modules that do not exist yet.
5. **Activity is derived from documents**, not an audit log; it can miss events that do not change a document's timestamp.
6. **"View Batches" is inactive** (with an explanatory tooltip) until an Admin batch view exists; it activates via the `onViewBatches` prop.
7. Inventory is valued at each batch's **purchase price** (no MRP/PTR/PTS yet); batches without a purchase price count as ₹0.
8. **Global search** finds navigation pages only (no entity search; no fake results).
9. Admin auth is deliberately minimal: one label-only role, **no RBAC**, no refresh tokens, no password reset/change UI, no audit log, no MFA; the limiter is in-memory (single instance).
10. Timezone is **UTC** for day boundaries; the SAP chip in the header is static (`not_configured`).
11. Performance: ~27 read-only aggregate queries per load, no polling, no new indexes. On large data, add indexes such as `(status, invoiceDate)` on invoices, `(status, orderDate)` on orders, `(batchId)` and `(createdAt)` on the stock ledger, and `(gl_id)` on journal entries.
12. The Distributor dashboard now shows only what real APIs provide (4 counts + quick actions); distributor-scoped pharma analytics need new distributor-scoped aggregation endpoints.
13. `SAP Not Configured` is rendered by the Phase 2 chip as "SAP not configured" (casing).

## 12. Future API integration points

| Need | Where to plug in |
|---|---|
| RBAC / more admin roles | `admin_users.role` → `Role/Permission` tables; replace `requireAdmin` with `requireRole(...)`; routes already namespaced under `/api/admin` |
| Real SAP status & statistics | Replace `sap` in the summary (and `portal.sapStatus`) with the SAP integration status; the card already renders all four states |
| Credit limit / claims / schemes alerts | Emit new structured alerts (`code`, `tone`, `count`) from the service; add text to `components/alertText.js` — no UI change |
| Audit logs | Swap the derived `activity` query for the `AuditLog` table; same item shape |
| Entity search | Backend search API → extend `GlobalSearch` results |
| Territory / category master, PTR/PTS valuation, expiry policy | Replace `Distributor.city`, `Product.category` text and the fixed severity windows in the service |
| Materialised aggregates | If load grows: pre-aggregate daily rows (sales, stock movement) and query those |
| Distributor-scoped dashboard | Reuse `features/adminDashboard` components with a tenant-scoped `/api/distributor/dashboard/summary` |
| Admin batch view | Route `/admin/inventory/near-expiry`, then pass `onViewBatches` |

## 13. Change summary

**Backend — new:** `models/adminuser.model.js`, `migrations/20260920090000-create-admin-users.js`, `config/adminAuth.config.js`, `middleware/adminAuth.js`, `middleware/failureLimiter.js`, `controllers/admin.auth.controller.js`, `controllers/admin.dashboard.controller.js`, `services/adminDashboard.service.js`, `routes/adminRoutes.js`, `scripts/create-admin.js`. **Modified (additive):** `server.js` (+1 line, mounts `/api/admin`), `models/index.js` (+1 model), `package.json` (+`create-admin` script), `.env.example`.

**Frontend — new:** `features/adminAuth/*` (session root, guard, layout, login, not-found), `features/adminDashboard/*` (page, service, hook, model, sample data, 12 components + 2 helpers), `config/adminNavigation.js`, `utils/adminApi.js`. **Modified:** `App.jsx` (admin routes), `config/portals.js` (+`adminPortal`), `components/layout/{AppShell,Header,HelpMenu,useBreadcrumbs}` (optional identity/logout/preset/home-path), `components/tables/DataTable.jsx` (+`cardTitleKey`), `components/dashboard/ChartCard.jsx` (skeleton min-height), `utils/{dateRanges,format}.js` (Yesterday/Week/Quarter presets; trimmed compact ₹), `styles/tokens.js` (+8-colour palette), **`Distributers/dashboard/pages/Dashboard.jsx`** (generic ERP demo removed — Steel Rods / Cement Bags / Paint Buckets, demo orders, fake charts and made-up "+12%" trends gone; the four real count calls and the "New Order → Purchase / Sales order" flow kept, now on `KpiCard`/`Modal` with `ErrorState` + Retry instead of `window.location.reload`).

**Unchanged:** all Distributor auth endpoints and pages, every other Distributor screen and route, Phase 1 security fixes, database data.
