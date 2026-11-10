# PHASE 21 — Standalone DMS verification & Admin Dashboard audit

Date: 2026-10-10/11 (IST). Method: unpacked the Phase 20 backend + frontend ZIPs, read the **code** (routes, controllers, services, models, sidebar config), ran the baseline, then ran targeted tests. Evidence levels are kept apart: **[CODE]** read in code · **[TEST]** automated test (in-memory SQLite) · **[DB]** MySQL-backed (none: MySQL is not available here → `NOT RUN`) · **[UI]** manual/browser check (not performed in this phase) · **[ERP-REAL]** real ERP (none; never claimed).

## 0. Baseline (before any Phase 21 change)
| Check | Result |
|---|---|
| Backend `npx jest --runInBand` | 23 suites, **766 / 766 passed** (matches Phase 20) — ~260 s |
| Frontend `npm run build` | succeeded (only the pre-existing >500 kB chunk warning) |
| Frontend project lint `npm run lint` | **33 errors / 10 warnings** (pre-existing, unrelated files; identical to Phase 19/20) |
| `node --test erpDecisionView.test.mjs` | 10 / 10 |
| MySQL | not available → every database-backed claim is `NOT RUN` |

## 1. Answer to the main question
**Can the DMS run without an ERP?** **Yes for the core workflows, by code and by SQLite-backed tests; not proven on MySQL.**
* [CODE] No controller or service in the core flows (product, batch, stock/inventory, sales order, delivery, invoice, returns, credit/debit notes, purchase, payment, accounting, claims, schemes, retailers, distributors, accounts) imports or calls ERP code. The only ERP touch points in non-ERP code are (a) a **display-only** LEFT JOIN to `sap_sync_records` in the Admin sales screens (`services/adminSales.service.js`) and (b) the ERP-RBAC permission list on the admin session. The ERP scheduler starts in `server.js` but only reads ERP tables and is disabled with `ERP_SCHEDULER_ENABLED=false`.
* [TEST] New `tests/standalone-phase21.test.js` runs one full journey through the **existing controllers** (stock-in → confirmed order → delivery → invoice create → post → payment) under five ERP conditions: no connection · connection disabled · provider unreachable (real `testConnection` against a refusing transport) · a sync job that FAILED (real `startSync`, HTTP 500) · credentials absent. In every case: stock 60−10=50 via StockLedger, invoice journal balanced at 224 (200 + 6 % + 6 %), payment journal balanced at 100, **0 ERP calls, 0 ERP jobs/links/outbound/SAP rows created by the core journey**, and the Admin dashboard still answers 200 with sales 200 and receivable 124.
* No security control was disabled; no ERP response or business data was faked (ERP failures are produced by the real code against a failing mock transport).

## 2. Sidebar & module register (extracted from `config/adminNavigation.js` and `config/navigation.js`, route-checked against `App.jsx`)
Totals: **Admin sidebar** 29 live links / 37 planned placeholders · **Distributor sidebar** 41 live / 39 planned. **Every live link has a matching route (no dead links, 0).** Routes not in the sidebar: Admin `/admin/inventory` (redirect), `/admin/login`; Distributor `/dashboard/delivery`, `/dashboard/invoice/creation`, `/dashboard/invoice/view` (legacy, labelled), `/dashboard/logout`, DEV-only design-system.

Status key: COMPLETE = route + page + real backend + validation + tests in SQLite; PARTIAL = works but known gaps; NOT_VERIFIED = routed and calls existing endpoints but not exercised by tests/UI here. Nothing is COMPLETE on a MySQL or manual-UI basis.

### 2.1 Admin portal (`/admin/*`, server guard `requireAdmin`)
| Module / link | Route → API | Status | Evidence / notes |
|---|---|---|---|
| Dashboard | `/admin/dashboard` → `GET /api/admin/dashboard/summary` | **PARTIAL** | Real queries (see §3). Gaps: no payables, pending-claims or pending-returns KPI; "Sample data" tab (see §3.3). ERP card was hard-coded → **fixed in Phase 21**. |
| Sales Orders (list/new/edit) | `/admin/sales/orders*` → `/api/admin/sales/orders*` | **PARTIAL (verification)** | The underlying controllers are covered by sales-lifecycle (27 tests); the Admin sales **service/controller layer (`adminSales*.service.js`) has no dedicated test file** (only incidental references in other suites). Create/confirm/cancel/create-invoice routes exist. |
| Sales Invoices | `/admin/sales/invoices` | PARTIAL (verification) — same note as above | list/get/post/cancel. "SAP status" column = PENDING by default (see §4). |
| Secondary Sales | `/admin/sales/secondary` | PARTIAL (verification) | read-only reports; no dedicated test. |
| Sales Returns / Credit Notes | planned placeholders | **MISSING in Admin** | Exist only in Distributor portal (`/dashboard/sales/return`, `/credit`). |
| Current Stock, Batch Stock, Stock Ledger, Near Expiry, Expired Stock, FEFO Monitor | `/admin/inventory/*` | COMPLETE (SQLite) | Phase 5/6 tests (read-only). |
| Stock Transfer | planned | MISSING (UI) | Backend `POST /inventory/transfers` exists in the Distributor API only. |
| Product / Batch / Pricing / Tax Masters | `/admin/masters/*` | COMPLETE (SQLite) | admin-masters-phase7 tests. |
| Scheme Master | `/admin/masters/schemes*` | COMPLETE (SQLite) | schemes-phase10 tests. |
| Distributor List/Form/Detail | `/admin/distributors*` | COMPLETE (SQLite) | Phase 8 tests. |
| Retailer List/Form/Detail | `/admin/retailers*` | COMPLETE (SQLite) | Phase 9 tests. |
| Claims | `/admin/claims*` | COMPLETE (SQLite) | Phase 11 tests (review/approve/reject/settle). |
| Accounts: Overview, Outstanding, Ageing, Ledger, Payments, Credit Limits | `/admin/accounts*` | COMPLETE (SQLite) | Phase 12 tests. |
| ERP Integration (5 screens) | `/admin/sap/*` | COMPLETE for what it claims (mock-verified only) | Phases 13–20; `ERP_VIEW` / `ERP_AUDIT` enforced on the server. Real ERP: NOT RUN. |
| Masters: Distributor Master, Retailer Master, Customer Master | planned | **DUPLICATE / MISSING** | "Distributor Master"/"Retailer Master" duplicate the live Distributor/Retailer List groups; Admin "Customer Master" has no screen. Recommend: do not remove yet (approval needed). |
| Distributor Mgmt: Performance, Credit Limit, Outstanding, Ledger | planned | MISSING | |
| Retailer Mgmt: Pharmacy, Hospital, Clinic, Compliance | planned | MISSING | |
| Claims group: Active Schemes, Scheme Calculation, Claim Settlement, Credit Notes | planned | MISSING / partly DUPLICATE | "Claim Settlement" overlaps `claims/:id/settle`; "Credit Notes" appears twice (Sales and Claims). |
| ERP group planned: Master Data/Sales/Inventory/Returns Sync, Failed Transactions, API Monitor | planned | MISSING / DUPLICATE | Overlap with ERP Sync History / Error Monitor. |
| Reports (10 items) | planned | **MISSING** | No report endpoints besides secondary-sales/accounts reads. |
| Notifications, Audit Logs, Settings | planned | **MISSING** | Only the ERP audit log exists (`/admin/sap/audit`). No general audit log or application-settings module/API. |
| Users, roles & permissions | no sidebar item | **MISSING (UI + API)** | `admin_users.role` set by `scripts/create-admin.js` / `set-admin-role.js` only. |
| **Purchase / Supplier / Delivery-dispatch** | no Admin sidebar group | **MISSING in Admin** | Full flows exist in the Distributor portal. |

### 2.2 Distributor portal (`/dashboard/*`, server guard `authMiddleware`)
| Group | Live routes | Status |
|---|---|---|
| Sales (orders, deliveries, invoices, returns, credit, debit) | `/dashboard/salesorder-master`, `/sales/delivery`, `/sales/invoice`, `/sales/return`, `/sales/credit`, `/sales/debit` | COMPLETE (SQLite) for order/delivery/invoice/posting (sales-lifecycle, 27 tests), returns (returns-lifecycle); credit/debit notes NOT_VERIFIED at UI level |
| Purchase (PO, delivery, invoice, return, debit) | `/dashboard/purchase/*` | COMPLETE (SQLite) — purchase-lifecycle tests; UI NOT_VERIFIED |
| Inventory (6 pages) | `/dashboard/inventory/*` | COMPLETE (SQLite) |
| Masters: Product (`material-master`) | | COMPLETE (SQLite) |
| Masters: **Batch Master (`/dashboard/stock-master`)** | `GET/POST/PUT/DELETE /batch` | **BROKEN** — see §5 D2 |
| Masters: Customer, Vendor, Pricing, HSN, Customer/Vendor/Item Groups | | NOT_VERIFIED (UI) · endpoints exist & are auth-protected |
| Retailers, Claims | | COMPLETE (SQLite) |
| Accounts (Customer/Vendor Ledger, Payments, GL, Trial Balance, Balance Sheet) | | PARTIAL: accounting.test.js covers journals/GL; Trial Balance & Balance Sheet pages NOT_VERIFIED |
| Financial View (6 pages) | | COMPLETE (SQLite), read-only |
| Distributor Dashboard | `/dashboard` | COMPLETE: 4 real counts (`/customer/count`, `/sales-delivery/count`, `/salesorder/count`, `/stock/count`); no invented figures |
| SAP Integration / Reports / Notifications / Audit Logs / Settings groups | planned | MISSING (placeholders; not clickable) |

## 3. Admin Dashboard KPI source & calculation audit (`services/adminDashboard.service.js`, endpoint `GET /api/admin/dashboard/summary?from&to`, default current UTC month, ≤400 days)
All SQL is read-only and parameterised. Dates are UTC days; the range applies to the items marked "range", the rest are snapshots (the API says so in `meta.appliedTo`).

| Tile / chart | Source & calculation | Range? | Verified |
|---|---|---|---|
| Total secondary sales (+ vs previous period) | `SUM(netValue)` (before GST) of invoices `POSTED/PARTIALLY_PAID/PAID` by `invoiceDate`; previous = same-length window before | range | [TEST] equals sum of invoice rows |
| Today's orders (+ vs yesterday) | `COUNT` orders in `CONFIRMED/PARTIALLY_DELIVERED/FULLY_DELIVERED/CLOSED` by `orderDate` | today (UTC) | [CODE] (not asserted in a test) |
| Active distributors / retailers | distinct distributors / customers with a posted invoice or non-draft order in range; "registered" = row counts | range | [TEST] registered counts equal table counts |
| Current inventory (value, units, batches) | ledger balance per batch (IN−OUT) × `batch.purchase_price`, positive balances only | snapshot | [TEST] 50 units × 5 = 250 |
| Near-expiry stock | `inventoryQuery.getExpiryBucketSummary` (30/60/90 days) — same function as FEFO pages | snapshot | [CODE] shared with Phase 6 tests |
| Sales returns | `SUM(qty × pricePerUnit)` of `POSTED` return lines by `returnDate` | range | [CODE] |
| Outstanding (receivables) | `SUM(debit−credit)` on every distributor's "Accounts Receivable" journal lines; `null` when no AR ledger exists | snapshot | [TEST] 224 − 100 = 124; empty DB → `null` (never 0 invented) |
| Sales trend, category sales, top products, top distributors, stock movement | invoice / line / ledger aggregates, bucketed daily ≤62 d, weekly ≤200 d, else 30-day | range | [TEST] top product/distributor rows equal the seeded invoice (sales 200, qty 10, outstanding 124) |
| Recent activity | latest 10 non-draft orders/invoices/returns (explicitly *not* an audit log) | snapshot | [CODE] |
| Alerts | near-expiry critical/high, expired stock, low stock (`reorder_level`) — only detectable conditions | snapshot | [CODE] |
| **ERP card** | **was** hard-coded `{status:"not_configured"}`; **now** `getErpHealthBlock` (see §5 D1) | snapshot | [TEST] |
| Sample-data tab | `features/adminDashboard/sampleData.js`, labelled "Sample data", ignores the range, choice stored in `localStorage` | — | [CODE] |

Findings: (1) **No dummy numbers on the Live tab.** (2) **No KPI for payables, pending claims or pending returns** exists on the dashboard — not invented here; they would need a business definition. (3) The sample tab is available to every admin in production and is remembered per browser; recommend (needs approval) hiding it outside development. (4) "Outstanding" is receivables only and sums *journal* balances, not `invoice.outstandingAmount`; the two can differ by design (e.g. the legacy payment endpoint posts only a journal). (5) Financial formulas were **not** modified.

## 4. Standalone dependency matrix
| Dependency | Classification | Evidence |
|---|---|---|
| Authentication, sessions, RBAC, all core CRUD, stock, order→delivery→invoice→posting→payment | **CORE_STANDALONE** | [CODE] no ERP import; [TEST] five ERP conditions |
| Admin dashboard figures | **CORE_STANDALONE** | [TEST] |
| Dashboard ERP card, ERP screens (`/admin/sap/*`), ERP sync/outbound/reconciliation | **OPTIONAL_ERP_ENHANCEMENT** | Hidden for roles without `ERP_VIEW`; "no ERP" is shown as a normal state |
| ERP master-data pull (products, customers…), stock, sales order sync | OPTIONAL_ERP_ENHANCEMENT | Phases 14–18 (mock-verified only) |
| "SAP status" column / filter on Admin Sales Orders & Invoices (`sap_sync_records` LEFT JOIN, default `PENDING`) | OPTIONAL_ERP_ENHANCEMENT (display only) — **finding** | Never gates an action (`salesStatus.service.js` actions depend only on document status). In a standalone deployment every posted document shows "PENDING" forever, which can mislead. Not changed: changing sales-screen semantics needs a product decision. |
| Invoice, Return, Document ERP sync | **BLOCKED** | Open business decisions (Phase 19 register); sync start → 409 (Phase 20 tests) |
| Oracle / Dynamics / generic SOAP adapters | BLOCKED (unsupported) | no adapter |
| Real SAP / REST ERP behaviour | NOT_VERIFIED | no real ERP reached |
| `ERP_REQUIRED_BY_DESIGN` | **none found** | No existing feature requires external ERP data |

Condition matrix (all [TEST], SQLite): no ERP ✔ · ERP disabled ✔ (dashboard: `activeConnections 0`) · provider unreachable ✔ · sync job failed ✔ (dashboard: health `ERROR`, failed 7-day = 1) · credentials absent ✔. Startup with no ERP: [CODE] `syncDB` does not touch ERP tables and `startScheduler` only reads ERP tables; a tick with zero connections is not covered by a dedicated test (Phase 15 tests cover ticks with schedules) → NOT_VERIFIED.

## 5. Defects — demonstrated and handled
| # | Defect | Evidence | Action |
|---|---|---|---|
| **D1** | Dashboard ERP card always said "SAP not configured" and showed no health even when connections, failed syncs and alerts existed (hard-coded in `adminDashboard.service.js`, even the card's sample figures were labelled illustrative). Not backed by data; the brief asks for "ERP sync health and pending failures". | [CODE] + 9 new tests failed when the old behaviour was restored | **FIXED** (§ Deliverables). |
| **D2** | Distributor **Batch Master** (`/dashboard/stock-master`, `StockMaster.jsx`) calls `GET/POST/PUT/DELETE /batch`; **no `/batch` route exists** (batches are `/stock` and `/inventory/batches`). Page cannot load. It also reads `batch.quantity`, which batches no longer have (stock is ledger-derived since Phase 5), and its form requires a quantity it never sends. | [CODE] route table vs FE call | **NOT fixed** — repointing the path alone would show NaN totals; the right fix (re-point the menu entry to the Phase 5 Batch Stock page, or rebuild the page) is a product decision. Recommended next step; not removed. |
| D3 | `Po.jsx` falls back to `GET /vendor/by-code/:code`, which does not exist. Only reached when the vendor is not in the already-loaded vendor list. | [CODE] | Not fixed (minor; needs a backend route). Documented. |
| D4 | Production schema bootstrap: `DB_SYNC` only runs when `NODE_ENV=development`; in production sync is disabled and `migrations/` contain **no create-table for 10 base tables** (Addresses, SalesDeliveryHeaders/Lines, Vendors, PurchaseDeliveryHeaders, PricingMasters, CustomerGroups, VendorGroups, ItemGroups, HSNGroups; the base distributor/customer/product tables are likewise only extended). A fresh production MySQL cannot be built from migrations alone. | [CODE] model-vs-migration comparison (heuristic) | **NOT_VERIFIED / NOT RUN** (needs MySQL). Documented; no migration written without MySQL. |

## 6. Business workflow verification matrix
| Journey | Path | Evidence | Status |
|---|---|---|---|
| Product → batch → stock | product + batch seed → `inventory.postMovement` (IN, OPENING) → StockLedger | [TEST] stock 60 / 50 after sale | COMPLETE (SQLite) |
| Order → delivery → invoice | confirmed order → `salesdelivery.create` → `salesinvoice.create` (totals incl. CGST/SGST) | [TEST] 200 + 12 + 12 = 224; sales-lifecycle (27) incl. over-delivery, concurrency, cross-tenant | COMPLETE (SQLite) |
| Invoice → receivable → payment | `salesinvoice.post` → AR/Sales/Output-GST journals → `payment.receivePayment` | [TEST] journals balanced (224; 100); AR net 124 on the dashboard | COMPLETE (SQLite). Note: the legacy `receivePayment` posts journals only; it does not update `invoice.outstandingAmount` (the Admin Payments API `/accounts/payments` is the invoice-allocating path). Not changed. |
| Purchase → receipt → stock | PO → delivery → purchase invoice | [TEST] purchase-lifecycle (existing) | COMPLETE (SQLite) |
| Invoice → return → credit note | sales return + credit note | [TEST] returns-lifecycle (existing) | COMPLETE (SQLite); ERP return sync BLOCKED |
| Claims, schemes, accounts views | | [TEST] Phases 10–12 | COMPLETE (SQLite) |

No ledger/journal/financial row was written directly by the new tests: all go through existing controllers/services (only master/seed rows are inserted, as in every existing test).

## 7. Security & permission findings
| Area | Result | Evidence |
|---|---|---|
| Route auth coverage | Distributor API: 197 routes; only signup/login/logout/refresh/forgot/reset/verify-otp are unauthenticated (rate-limited). Admin API: 128 routes; only login/logout/session unauthenticated. | [CODE] script over `routes/*.js` |
| ERP RBAC | server-side (`erp(permission)`), role re-read per request, deny by default, denial audited | Phase 17/20 tests (unchanged, pass) |
| **Non-ERP Admin RBAC** | **Gap:** every non-ERP Admin route (create payments, approve/settle claims, post invoices, edit masters…) accepts **any active admin session**; there is no role check, by documented design (`config/erpPermissions.js`). Roles other than the ERP ones (e.g. `SALES_EXEC`) can therefore operate finance/claims modules. | [CODE]; a role-based matrix for the other modules needs a business decision — not changed |
| Users / roles management | no UI/API (CLI scripts only) | [CODE] |
| Tenant / distributor isolation | Distributor routes scope by `req.user.id`; cross-tenant order/invoice/product/customer rejected (404/400) | [TEST] sales-lifecycle (21, 27), phases 5–12; ERP by `tenant_key` (new test: other tenant's connection never counted) |
| Admin dashboard | needs session (401 otherwise, [TEST]); response excludes URLs/credential refs/headers ([TEST]); ERP detail withheld from roles without `ERP_VIEW` ([TEST]); ERP read failure → 200 with `UNAVAILABLE`, no internal message ([TEST]) | |
| Input validation / error shape | standard error handler, body limit 100 kB, `rejectDangerousKeys` on admin | [CODE] |
| Not changed | SSRF policy, rate limits, redaction, audit immutability, access checks | Phase 17 suites pass unchanged |
| Frontend permission hiding | UX only; not relied on | |

## 8. Not done / not verifiable here
No MySQL → all `[DB]` checks NOT RUN. No browser run in this phase → page-level loading/empty/error states of legacy Distributor pages are NOT_VERIFIED (the Admin dashboard card logic is unit-tested; its rendering was checked by build + lint only). No real ERP. The latent `2027-01-01` test-clock risk from Phase 19 is unchanged.
