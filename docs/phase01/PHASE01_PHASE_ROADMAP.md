# PHASE 01 — PHASE 2–7 ROADMAP

This roadmap is derived from the audit. The requirements file names Phases 2–7 but only Phase 1 was specified in detail, so the **phase boundaries below are a proposal** (marked *proposed*); adjust them to your own numbering. Dependencies are real; ordering inside a phase is a recommendation.

Guiding rules for every phase: backend enforcement first, UI hiding second; no mock data; every phase ends with both full ZIPs; add tests with each change (the frontend has no component tests today); run `npm test` (backend), `npm run lint`, `npm test` and a production build (frontend) — and report honestly.

---

## Phase 2 — Admin & Distributor navigation cleanup (UI only) *(proposed)*
**Goal:** requirements A.1 (UI part), A.4, A.7 (UI), A.8, A.10, B.1, B.2 (UI), B.4, B.6, B.7 (navigation).
**Depends on:** Decisions 1, 3 (Retailer/Customer; ERP policy) and the Distributor "Masters" relocation question (inventory §2).
**Frontend (files):**
- `src/config/adminNavigation.js` — remove the planned Masters (Distributor/Retailer), Distributor Management planned items (Performance, Credit Limit, Outstanding), Retailer Management group, planned Schemes & Claims siblings, ERP group, Reports › Secondary Sales/Distributor/Retailer/SAP Sync items, Notifications, Audit Logs; add Ledger / Settings (A.9) only when a real target exists; remove Sales › Orders create entry points.
- `src/config/navigation.js` — Distributor: hide FEFO Monitor, Masters, Schemes & Claims, Financial View, Notifications, Audit Logs; Accounts › remove Vendor Ledger; Reports → Sales, Stock, Expiry, Scheme, Returns, Outstanding, Purchase Orders (items remain *planned* until built — an unavailable report must not look working); keep Settings entry planned until a page exists.
- `src/config/portals.js` (filters), `PrivateApp.jsx` (remove or guard routes for hidden pages: `sales/orders/new`, `sales/orders/:id/edit`, `retailers*`, `sap/*`, distributor `inventory/fefo`, etc.), `components/Distributers/dashboard/accounts/Payments.jsx` (vendor payment section), `components/layout/Header.jsx`/`SapStatusIndicator.jsx`, `features/adminDashboard/AdminDashboardPage.jsx` (SAP card).
- Make the "Show planned modules" toggle unable to reveal removed items (they are deleted from config, not flagged).
**Backend:** none (explicitly not a security phase).
**Tests:** new Node tests for `adminNavigation`/`navigation` exports (assert absence/presence by id); route-table test that hidden paths render `AdminNotFound`; lint clean for touched files.
**Completion criteria:** all listed items gone from sidebar, global search, breadcrumbs and direct URL (for removed routes); distributor can still reach every operation not in the hide list; no console errors; docs list what remains reachable via API.
**Risks:** hiding Distributor Masters removes the only create/edit screens for products, customers, vendors, batches, pricing, HSN and groups (confirm intent); `navigation.js` edits also change the Admin menu (shared derivation).

## Phase 3 — Backend authorization and Admin read-only enforcement *(proposed)*
**Goal:** A.1 (server), A.2, A.3 decision, B.2 (server, if required), RBAC.
**Depends on:** Phase 2 decisions; this phase fixes finding S1.
**Backend:**
- Introduce an Admin role/permission table covering **all** modules (extend `config/erpPermissions.js` pattern; keep legacy `ADMIN` working until migrated) and a `requirePermission(...)` applied to every write in `routes/adminRoutes.js` (39 unguarded writes, listed by `scripts/route-inventory.js` and `docs/phase24_admin_unguarded_writes.txt`).
- Sales creation block: reject `POST /api/admin/sales/orders`, `/preview`, `PUT …/:id`, `/confirm`, `/cancel`, `/create-invoice` (and decide on invoice post/cancel) with a stable 403/409; tests prove 403 even with a valid admin cookie.
- Admin Sales Returns: add **GET-only** `/api/admin/sales/returns[/:id]` (+ `lookups`) reading `SalesReturn/SalesReturnLine`, and prove that no POST/PUT/PATCH/DELETE route exists (route-inventory test using `scripts/route-inventory.js`). Distributor `/api/sales-return` write routes stay.
- Credit notes: implement only if decided (Decision 2).
- Distributor token hardening (S3): distinct token types, status re-check in `auth.middleware.js`, cookie/JWT lifetime alignment — requires approval because it changes auth behaviour.
- Reports/Settings/Ledger placeholders: only real endpoints.
**Frontend:** Admin Sales Returns read-only page (`features/…/returns`), Ledger link (A.9), role-aware button hiding (UX only).
**Tests:** extend `tests/security-phase23.test.js` style suites: per-route role matrix, write-blocked assertions, direct-URL checks.
**Completion criteria:** a matrix test enumerating every Admin write route × every role; sales creation and returns writes provably blocked; all 846 existing backend tests still pass.

## Phase 4 — Accounts, ledger and reports *(proposed)*
**Goal:** A.6, B.2, B.3 ("My Ledger"), B.7 reports, Distributor Settings.
**Depends on:** Decisions 1, 4; Phase 3.
**Work:**
- A.6: remove retailer entity options from Admin Accounts (`features/accounts/pages/{Outstanding,Ledger,Payments,Credit}Page.jsx`, `components/RecordPaymentModal.jsx`, `accountsHooks.js`, `api/accountsApi.js`; backend `services/receivables.service.js`, `payments.service.js`) **or** re-label per Decision 1; this changes shared code used by the Distributor Financial View — regression-test both portals.
- "My Ledger": design the distributor↔admin ledger (what transactions?), add the data model if needed (migration), expose read-only; otherwise document it as not feasible. Do not label the Customer Ledger as "My Ledger".
- Reports: Sales, Stock, Expiry, Scheme, Returns, Outstanding, Purchase Orders — one endpoint + page each, built on the existing sources listed in the inventory; every figure reconciles to its source (tests); no sample data.
- Settings page for Distributor/Admin (scope TBD).
**Completion criteria:** each report has route, API, calculation tests and an empty-state; nav item switches from `planned` to live only when all exist.

## Phase 5 — Company (tenant) model and database-per-company foundation *(proposed)*
**Goal:** D.
**Depends on:** Decisions 5–7; Phase 3 RBAC; staging DB server.
**Work:** reproducible schema installer (baseline migration/snapshot + `SequelizeMeta` strategy, verified on the target MySQL/MariaDB); control-plane DB; `companies`, company-bound admins, distributor directory; tenant resolver + per-request connection; model factory refactor (42 controllers, 13 other files); tenant-aware ERP scheduler and `batchExpiryJob`; provisioning job with status/error/retry; storage metering job; per-tenant DB users; feature flag so un-migrated data keeps working; cross-tenant isolation test suite. **No data migration yet.**
**Completion criteria:** a new company can be provisioned end-to-end on staging, failure paths tested (DB create fails, schema step fails, partial resume), two tenants proven isolated, existing single-DB mode unchanged when the flag is off.

## Phase 6 — Super Admin network dashboard and ownership *(proposed)*
**Goal:** C, ownership reliability, existing-data migration (explicit, audited).
**Depends on:** Phase 5.
**Work:** network dashboard separate from the Admin menu (company count, distributors per company, **Unassigned** bucket, storage usage per company, provisioning status, network totals from real queries), Super Admin Reports section, hide ERP for Super Admin, ownership audit table + assign/reassign action (explicit, logged, never guessed), `onboarding_source` column, pagination for the 1,000-row drill-down, data migration tooling with dry-run + reconciliation (Phase 5 design §3.5) executed per company only after sign-off.
**Completion criteria:** counts reconcile with the control plane; unassigned never auto-assigned; migrated company passes reconciliation report; rollback plan tested.

## Phase 7 — Database export and migration *(proposed)*
**Goal:** E.
**Depends on:** Phases 3 (permissions) and 5 (tenant DBs).
**Work:** `export_jobs`, authorised endpoints (company-scoped from session), background worker, MySQL/SQL exporter first, then PostgreSQL, then MongoDB (design per DB architecture §4); manifest + validation summary + import scripts; signed short-lived download; audit trail; secrets/PII exclusions; UI to pick target format and view job status.
**Completion criteria:** export → import round-trip into a scratch target per format with the validation summary matching; cross-tenant export attempt returns 403 in tests; expired/failed job paths tested.

---

## Cross-phase items (schedule as needed)
| Item | Suggested phase |
|---|---|
| Rotate secrets that shipped in `.env` (S9) | **Before Phase 2** (operational, no code) |
| Replace/contain `xlsx` 0.18.5 (S8) | Phase 3 |
| Password-reset hardening (crypto OTP, hashing, uniform responses, per-account throttle) S5 | Phase 3 |
| Self-signup approval policy (S4) | Phase 3 |
| Code generators beyond `DTC999`/`CTR999` (S6) | Phase 5 (needs per-company codes) |
| Remove dead legacy controllers `delivery.controller.js`, `invoice.controller.js` (S7) | Phase 3 |
| Fix ESLint errors (33) and make `lint` a gate; fix `vite.config.js` `process` global | Phase 2 |
| Add frontend component/route tests | from Phase 2 |
| MySQL 8 verification of migrations and app | Phase 5 |
