# PHASE 21 — Standalone DMS verification & Admin Dashboard audit: deliverables

**Outcome in one line:** the core DMS was traced and tested as a standalone application (no ERP, ERP disabled, unreachable, sync failed, credentials absent) and works on in-memory SQLite; the Admin Dashboard's KPIs were traced to real queries; one demonstrated defect (the dashboard ERP card was hard-coded to "not configured") was fixed. Two further defects and several gaps are documented, not guessed at. **Nothing is claimed as complete on MySQL, in a browser, or against a real ERP.**

Full register, matrices and evidence: `PHASE21_AUDIT.md` (sidebar/module register §2, standalone matrix §4, KPI audit §3, workflow matrix §6, security §7).

## 1. What changed (minimal, backward-compatible; no migration, no model, no new route, no financial logic touched)
**Backend**
* `services/adminDashboard.service.js` — new `getErpHealthBlock(db, {tenantKey, role})`: database reads only (reuses `erpMonitoring.getSummary`), never contacts an ERP. States: `RESTRICTED` (role lacks `ERP_VIEW`: no ERP figure disclosed) · `UNAVAILABLE` (any read failure: the dashboard is still returned) · `OK` with `configured:false` (standalone, a normal state) or real counts/health (connections, active, worst sync health of ACTIVE connections, failed/partial syncs in 7 days, running/queued, open alerts, last successful/failed sync). Health is sync history, **not** a live reachability test, and is labelled so.
* `controllers/admin.dashboard.controller.js` — attaches it as `sap: { status: "configured"|"not_configured", erp }` (same endpoint, same auth; `sap.status` is kept for compatibility).

**Frontend**
* `dashboardModel.js` — `erpCardModel()` (pure) + `normalizeDashboard` passes `sap.erp` through.
* `components/SapStatusCard.jsx` — Live data shows the real ERP state (title "ERP integration"); the Sample-data view keeps its labelled illustration.
* `dashboardModel.test.mjs` — 6 unit tests (`node --test`, no new dependency).

**Tests**: `tests/standalone-phase21.test.js` — 12 tests (5 ERP conditions × the full journey, dashboard figures vs rows, empty database, KPI inventory, ERP-card role/tenant/failure/auth behaviour). Mutation check: restoring the old hard-coded line made **9 of the 12 fail**.

## 2. Files
**Created:** `backend/PHASE21_AUDIT.md`, `backend/PHASE21_DELIVERABLES.md`, `backend/tests/standalone-phase21.test.js`, `frontend/src/features/adminDashboard/dashboardModel.test.mjs`.
**Modified:** `backend/services/adminDashboard.service.js`, `backend/controllers/admin.dashboard.controller.js`, `frontend/src/features/adminDashboard/dashboardModel.js`, `frontend/src/features/adminDashboard/components/SapStatusCard.jsx`.
No existing test file was modified or weakened.

## 3. Results (exact)
| Check | Baseline (before) | Final (after) |
|---|---|---|
| Backend `npx jest --runInBand` | 23 suites, 766 / 766 | **24 suites, 778 / 778 passed, 0 failed** (766 + 12) |
| Frontend `npm run build` | succeeded | succeeded |
| Frontend `npm run lint` (project) | 33 errors / 10 warnings | **33 errors / 10 warnings — identical; none from Phase 21 files** (the only error under `features/adminDashboard`, `NearExpiryCard.jsx:56 'Icon' unused`, is pre-existing and untouched) |
| `eslint` on the 3 changed FE files | — | clean |
| `node --test` ERP decision view / dashboard model | 10 / 10 | 10 / 10 and 6 / 6 |
| Pre-existing failures | none in tests; 43 lint problems | same |
| New failures | — | none |
| MySQL-dependent checks, migration up/down | **NOT RUN** (no MySQL) | **NOT RUN** — SQLite does not prove MySQL compatibility (note: the dashboard SQL uses backtick quoting and `CAST(DATE())`, written for MySQL and SQLite; MySQL not exercised) |
| Browser / manual UI check | not run | **NOT RUN** this phase (the new card is verified by its pure view-model tests, build and lint, not by rendering) |
| Real ERP | none | none |

## 4. Complete / Partial / Blocked / Unsupported / Not verified
* **COMPLETE (code + SQLite tests only):** auth and admin session guard; sales order → delivery → invoice → posting → payment; purchase flow; returns and credit notes; inventory/FEFO; product/batch/pricing/tax/scheme masters; distributors; retailers; claims; accounts views; ERP screens for what they claim.
* **PARTIAL:** Admin Dashboard (real data; no payables / pending-claims / pending-returns KPI; sample tab); Admin Sales screens (no dedicated test of the admin service layer; "SAP status" shown as PENDING in standalone); Distributor Accounts (Trial Balance/Balance Sheet UI not verified).
* **BROKEN:** Distributor **Batch Master** page (`/dashboard/stock-master` → nonexistent `/batch` API) — D2.
* **MISSING:** Admin Reports (10 placeholders), Notifications, general Audit Logs, Application Settings, Users/Roles/Permissions UI + API, Admin Purchase/Supplier/Delivery, Admin Sales Returns/Credit Notes, Admin Customer Master, Stock Transfer screen. Placeholders are kept (not removed).
* **DUPLICATE (placeholders):** Distributor Master / Retailer Master vs the live lists; Credit Notes (Sales vs Claims); ERP planned sync pages vs Sync History / Error Monitor.
* **BLOCKED:** ERP Invoice, Return, Document sync (open business decisions, unchanged).
* **UNSUPPORTED:** Oracle REST, Dynamics REST, generic SOAP adapters.
* **NOT_VERIFIED:** MySQL behaviour and a fresh-install migration path (D4); real SAP/REST ERP; page-level loading/empty/error states of legacy Distributor pages; scheduler tick with zero connections.

## 5. Known limitations and recommended next phase
1. **Needs your decision before any change:** (a) Batch Master — re-point the Distributor menu to the Phase 5 Batch Stock page, or rebuild it (D2); (b) hide the dashboard "Sample data" tab outside development; (c) whether Admin Sales screens should hide the "SAP status" column when no ERP connection exists; (d) a role/permission model for the non-ERP Admin modules (today any active admin can post invoices, settle claims, create payments) and a Users/Roles screen; (e) business definitions for payables / pending-claims / pending-returns dashboard tiles.
2. **Needs MySQL:** run the whole suite and the migrations against MySQL; resolve D4 (no create-table migrations for 10 base tables) with a fresh-install test.
3. Add a dedicated test suite for the Admin sales service layer; a browser pass over the legacy Distributor pages.
4. Unchanged open items from Phase 19/20: real ERP verification, Oracle/Dynamics/SOAP adapters, Invoice/Return/Document sync, the `2027-01-01` test-clock risk.
