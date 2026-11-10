# PHASE 15 — ERP Sync Expansion, Scheduler, Monitoring & Operational Management

## 1. Objective
Extend the Phase 14 generic sync engine with more business targets, a controlled scheduler, real monitoring (dashboard, health, error monitor) and operational retry visibility — without making anything SAP-specific and without bypassing existing DMS services.

```
ERP → Provider adapter (SAP OData / Generic REST) → Generic Sync Engine → Capability target → existing DMS model/service
```
The engine, mapper, scheduler and monitoring contain no vendor vocabulary (a test enforces it).

## 2. Capabilities implemented
| Capability | Target | DMS reuse | Status |
|---|---|---|---|
| PRODUCT_MASTER | Product | Phase 14 | unchanged |
| CUSTOMER_MASTER | Customer (= retailer) | `retailers.service` validators + uniqueness check; Customer model | **COMPLETE** (see limits) |
| DISTRIBUTOR_MASTER | Distributor | `adminDistributors.service` validators + uniqueness; Distributor model | **COMPLETE** (see limits) |
| PRICING | PricingMaster | PricingMaster model (resolved by `pricing.service`) | **PARTIAL** — creates and updates only ERP-created rows; never overwrites manual prices |
| PAYMENT | Payment | `payments.createPayment` (Payment + balanced journal + invoice balances in one transaction) | **PARTIAL** — booked unallocated, immutable once posted |

## 3. Capabilities NOT implemented (and why)
Each returns a documented reason through the API, lookups and UI. None is faked.
- **STOCK** — `BUSINESS_DECISION_REQUIRED`. Stock is a ledger (FEFO, batches, warehouses). An ERP overwrite would double-count DMS postings. Needs an ownership decision and ERP plant/storage-location → warehouse and batch mappings, which do not exist.
- **SALES** — `BUSINESS_DECISION_REQUIRED`. Orders run draft → confirmed → delivery → invoice with pricing, schemes, tax, stock; the order model has no external id; ownership of orders is undefined.
- **INVOICE** — `BUSINESS_DECISION_REQUIRED`. Would duplicate accounting/outstanding unless ownership is defined and an external invoice id exists.
- **RETURN** — `CAPABILITY_NOT_SUPPORTED`. Depends on SALES/INVOICE.
- **DOCUMENT** — `CAPABILITY_NOT_SUPPORTED`. No tenant-isolated document store, file-type/size/malware pipeline. (Only generic multer uploads exist.)

## 4. Provider status
| Provider | Status |
|---|---|
| SAP_ODATA | IMPLEMENTED (Phase 14) |
| GENERIC_REST | IMPLEMENTED (Phase 14) — use it for Oracle/Dynamics JSON APIs |
| ORACLE_REST | FOUNDATION_ONLY → `PROVIDER_NOT_SUPPORTED` |
| DYNAMICS_REST | FOUNDATION_ONLY → `PROVIDER_NOT_SUPPORTED` |
| GENERIC_SOAP | FUTURE |

No real API documentation or credentials for Oracle/Dynamics were available, so no adapter was written. Schedules on such connections are refused.

## 5. Scheduler architecture
```
timer (30 s) → schedulerTick: find due schedules → claim (compare-and-swap) → preflight → create QUEUED job
             → workerTick:    QUEUED scheduled jobs → claim QUEUED→RUNNING → generic sync engine → finalise schedule
```
- The scheduler **only creates jobs**; the worker runs them through the same `runSync`.
- Frequencies: `EVERY_15_MIN`, `EVERY_30_MIN`, `HOURLY`, `DAILY`. Nothing below 15 min is accepted.
- Schedule fields: `enabled`, `frequency`, `next_run_at`, `last_run_at` (+ `next_retry_at`, `retry_count`, `last_retry_at`, `last_status`, last error, `scope`).
- Enabling a schedule runs the manual-sync preflight (provider implemented, endpoint, mapping with key, direction, valid scope).
- Duplicate protection: CAS claim on `next_run_at`; Phase 14 UNIQUE `active_key` → a still-running job makes the slot `SKIPPED/SYNC_ALREADY_RUNNING`.
- No catch-up storm after downtime: one run, then `now + interval`.
- Crashed jobs (no heartbeat 15 min, `ERP_SYNC_STALE_MINUTES`) are closed FAILED by the scheduler.
- Concurrency cap: `ERP_SYNC_MAX_CONCURRENT` (default 2).
- Env: `ERP_SCHEDULER_ENABLED=false` turns it off; `ERP_SCHEDULER_INTERVAL_SECONDS`.
- **Limitation (honest):** there is no queue/cron service in this project, so the scheduler is in-process. If the Node process is down, nothing runs. It is safe with several processes (CAS claim) but not a replacement for a real job queue.

## 6. Sync monitoring
`GET /erp-sync/summary` (real rows only): total/active/error connections, running and queued syncs, **syncs today** (total/success/partial/failed), last successful sync, **next scheduled sync**, enabled schedules, and **per-ERP** last sync, last success, 7-day success/partial/failed, next sync, provider and **health**.

Health (computed, not hard-coded), per capability over the last 14 days, connection = worst capability:
- ERROR — last run FAILED (reason notes "N times in a row" at ≥3)
- WARNING — last run PARTIAL, or any of the latest 5 runs PARTIAL/FAILED
- HEALTHY — latest 5 runs all SUCCESS
- UNKNOWN — no completed run ("No data")

"Today" = server calendar day.

## 7. Error monitoring
`GET /erp-sync/errors` filters: `connectionId`, `capability`, `errorCode`, `status` (job), `from`/`to` (YYYY-MM-DD), `retryable`, paging; returns counts by error code. Run-level failures are now stored as errors too (`scope: RUN`, `record_index` NULL, not counted as failed records); record failures are `scope: RECORD`. Invalid filters → 400. New code `BUSINESS_DECISION_REQUIRED` (non-retryable).

## 8. Retry behavior
- Manual retry: Phase 14 (new job, attempt+1, max 3 attempts) — unchanged.
- Visibility on jobs: `retryable`, `retryCount`, `maxAttempts`, `lastRetryAt`. On schedules: `retryCount/maxAutoRetries`, `lastRetryAt`, `nextRetryAt`.
- **Automatic retry (scheduled jobs only):** only transient run-level errors (TIMEOUT, RATE_LIMITED, CONNECTION_ERROR, SERVER_ERROR); exponential backoff base·2ⁿ minutes (2, 4, 8; `ERP_SYNC_AUTO_RETRY_BASE_MINUTES`); at most 3 (`ERP_SYNC_AUTO_MAX_RETRIES`); never past the next regular slot. Auth, mapping, validation and per-record data errors are never auto-retried. Each retry is a new job (`trigger RETRY`, `retry_of_job_id`).

## 9. Outbound sync status
**NOT IMPLEMENTED.** DMS → ERP needs ERP-specific write APIs, idempotency keys on the ERP side and business rules about which system owns each document; none are defined. Capabilities configured `DMS_TO_ERP` are refused (no request made). The `ErpProvider` contract still refuses writes.

## 10. Data ownership rules
Exposed to the UI via `lookups.syncTargets[].ownership`. Declared direction is the ownership switch: a capability only syncs when configured ERP → DMS.
- **Customer** — ERP-owned: name, contact, phone, alt phone, email, GSTIN, PAN, address 1–3, city, state, PIN, territory, status (active/inactive). DMS-owned: customer_code, distributor, customer group, credit limit, shipping address, and *pending* status (never changed by a sync). Distributor and group come from the admin-chosen scope, never from the ERP. Empty ERP values never blank a field.
- **Distributor** — ERP-owned: name, contact, phone, GSTIN, PAN, address, city, state, postal code, country, territory, e-mail at creation only. DMS-owned: code, credit limit, payment terms, status, password/login. New distributors are created `pending` with no login. Pre-existing unlinked distributors (same e-mail/GSTIN) are never touched.
- **Pricing** — a sync creates a price only if none exists and updates only rows it created (linked). Existing manual or other-ERP prices fail with `BUSINESS_DECISION_REQUIRED`. Tax (HSN) and schemes stay DMS-owned. Products must be synced first.
- **Payment** — payments entered in the DMS are untouched; ERP payments are immutable once posted; `PAYMENT` defaults to DMS → ERP, so the admin must deliberately choose ERP → DMS. Payment mode is never guessed (mapped or chosen in scope, else `BUSINESS_DECISION_REQUIRED`).
- Whether ERP is the real owner of each of these in your business is **not known**; the rules above are the safe defaults and should be confirmed.

## 11. Database changes
Migration `20261008090000-erp-sync-phase15.js` (reversible, idempotent, additive, MySQL-compatible):
- NEW `erp_sync_schedules` (unique `connection_id+capability`, FK to `erp_connections`, indexes).
- `erp_sync_errors` + `connection_id`, `capability` (back-filled from jobs via portable sub-select) + 2 indexes.
- 2 indexes on `erp_sync_jobs`.
No business table is changed. Not run against MySQL here (tests use sqlite; the migration test covers up/down/up).

## 12. APIs (all behind `requireAdmin`, tenant from the session)
- `GET /erp-sync/summary` (extended) · `GET /erp-sync/errors`
- `GET /erp-sync/schedules[?connectionId]` · `GET /erp-sync/schedules/:id` · `POST /erp-sync/schedules/:id/run` (202)
- `PUT /erp-integrations/:id/schedules/:capability` (create/update/disable via `enabled:false`)
- Mappings/jobs/retry: Phase 14 routes, now valid for the new capabilities. Lookups add `syncUnsupportedCode/Reason`, `scheduleFrequencies`, target `ownership`/`requiredFields`.
Foreign connection/job/schedule/error → 404 (or empty), no ERP call.

## 13. Frontend changes
Dashboard (KPIs, last success, next scheduled, per-ERP cards with health); ERP Error Monitor page (`/admin/sap/errors`, new nav item); Schedule dialog (capability, frequency, scope, status, retry state, Run now); Start-sync and Mapping dialogs now driven by the target (scope fields, required fields, ownership notes, capability picker); Sync History drawer shows retry info. Routes keep the `/admin/sap/*` prefix; nothing is SAP-only.

## 14. Tests
- `tests/erp-sync-phase15.test.js`: **54 tests** — customer (create/update/skip/duplicate/mapping failure/pending/relink), distributor (create/update/preserved/tenant), pricing (create/update/effective dates via `pricing.service`/idempotent/manual price kept), payment (journal balanced/idempotent/crash-safe relink/immutable/mode/GL), unsupported capabilities, outbound refusal, scheduler (config, due/not-due, no duplicates incl. concurrent ticks, disabled, worker, concurrency cap, skip, stale reaping, run-now, tenant isolation), auto-retry (retryable, non-retryable, max, success reset, manual), health/dashboard, error filters, multi-ERP, audit events, routes, migration.
- Phase 13/14 tests updated only where Phase 15 intentionally changes behaviour (route counts, supported-capability list, customer/stock/sales error codes).
- **Full backend suite: 533 tests — 528 pass, 5 fail. All 5 failures are in `fefo-expiry-phase6.test.js`, are PRE-EXISTING** (identical 5 failures on the untouched Phase 14 zip; the test hard-codes a 2026-09-24 clock while Batch auto-deactivates against the real date; Phase 14 reported 1, the count varies with the real date). **Phase 15 failures: 0.**
- Not tested: Stock/Sales/Invoice/Return/Document sync (not implemented), real ERPs, MySQL.

## 15. Build / lint
- `npm run build` (frontend): PASS.
- ESLint: all Phase 15 / ERP files clean. The full-project lint still reports pre-existing errors in unrelated files (e.g. `adminSales/sample/sampleSalesApi.js`), untouched.
- No browser or HTTP-level manual run was performed in this environment (no MySQL/admin session); screens were verified by build/lint and the controller/service tests only. The manual flow in the brief (login → connection → mapping → sync → schedule → dashboard) should be walked through once on a real environment.

## 16. Real ERP verification
SAP: NOT VERIFIED · Oracle: NOT VERIFIED · Dynamics: NOT VERIFIED · Other: NOT VERIFIED. Every transport in tests is a mock `fetch`.

## 17. Known limitations
- In-process scheduler (no queue); min 15 min; stops when the process stops.
- Product/customer/distributor/pricing creation uses an in-process serialiser for DMS-generated codes (existing "last row + 1" code generation is not concurrency-safe across processes).
- Customer sync: retailers only; customers without GSTIN can only be matched through their ERP id (link), so a retailer created by hand and later also present in the ERP will be duplicated unless GSTIN matches.
- Pricing: ERP-linked rows are treated as ERP-owned (a manual edit of such a row is overwritten when the ERP value changes). One price per product/customer group/distributor (existing unique index): effective-date history is not kept.
- Payments: unallocated; no reversal; the ERP payment id must fit `[A-Za-z0-9._/#-]` (≤ ~50 chars).
- Audit events are `[erp-audit]` log lines (`ERP_SYNC_CREATED/STARTED/COMPLETED/PARTIAL/FAILED/RETRIED`, `ERP_SCHEDULE_CREATED/UPDATED/DISABLED/TRIGGERED/SKIPPED`); no persistent audit store exists.
- Per-ERP health ignores connection-test status (job data only); error filter by job status uses up to 20 000 job ids.
- Business decisions still open: ownership of stock, sales, invoices, returns, payments in your ERP landscape; plant ↔ warehouse and batch mappings; document storage.

## 18. Phase 16 integration points
Customer-group / HSN lookup by ERP code instead of a per-sync scope; add `external_id` columns to order/invoice models and decide ownership, then add SALES/INVOICE/RETURN targets over the existing services; STOCK target through `inventory.postAdjustment` after plant/batch mappings; Oracle/Dynamics providers behind the existing contract; outbound DMS → ERP with ERP-side idempotency keys; move the scheduler to a real queue/cron; persistent audit store; secure document storage.

---
## FINAL STATUS — PHASE 15
- Customer Sync: **COMPLETE**
- Distributor Sync: **COMPLETE**
- Pricing Sync: **PARTIAL** (ERP-owned rows only; manual prices protected)
- Stock Sync: **NOT SUPPORTED** (business decision required)
- Sales Sync: **NOT SUPPORTED** (business decision required)
- Invoice Sync: **NOT SUPPORTED** (business decision required)
- Return Sync: **NOT SUPPORTED**
- Payment Sync: **PARTIAL** (unallocated, immutable)
- Document Sync: **NOT SUPPORTED**
- Scheduler: **PARTIAL** (in-process, min 15 min)
- Monitoring: **COMPLETE**
- Retry: **COMPLETE**
- Outbound Sync: **NOT IMPLEMENTED**
- Multi-ERP: **COMPLETE**
- Tenant Isolation: **COMPLETE**
- Tests: **PASS** for Phase 15 (528/533 overall; 5 pre-existing `fefo-expiry-phase6` failures)
- Build: **PASS**
- Real ERP Verification: **NO**

### FILES CREATED
Backend: `migrations/20261008090000-erp-sync-phase15.js`, `models/erpsyncschedule.model.js`, `services/erpScheduler.service.js`, `services/erpMonitoring.service.js`, `tests/erp-sync-phase15.test.js`, `PHASE15_DELIVERABLES.md`.
Frontend: `features/erpIntegration/components/ErpScheduleModal.jsx`, `components/ErpScopeFields.jsx`, `pages/ErpErrorMonitorPage.jsx`, `scopeUtils.js`.

### FILES MODIFIED
Backend: `controllers/admin.erp.controller.js`, `routes/adminRoutes.js`, `server.js`, `models/index.js`, `models/erpsyncerror.model.js`, `services/erp/erpConstants.js`, `services/erp/erpErrors.js`, `services/erp/sync/targets.js`, `services/erp/sync/syncEngine.js`, `services/erpSync.service.js`, `services/erpIntegration.service.js`, `services/retailers.service.js` (export only), `services/adminDistributors.service.js` (export only), `tests/erp-sync-phase14.test.js`, `tests/erp-integration-phase13.test.js`.
Frontend: `App.jsx`, `config/adminNavigation.js`, `features/erpIntegration/api/erpApi.js`, `erpDisplay.js`, `components/ErpConnectionCard.jsx`, `components/ErpMappingModal.jsx`, `components/ErpStartSyncModal.jsx`, `pages/ErpConnectionsPage.jsx`, `pages/ErpIntegrationDashboardPage.jsx`, `pages/ErpSyncHistoryPage.jsx`.

### FILES NOT CHANGED
Dashboard, Sales, Inventory, Product Master, Distributor/Retailer management logic, Schemes, Claims, Accounts (incl. `payments.service`, `accounting.service`, `receivables.service`), Distributor portal, all provider adapters (`sapProvider`, `genericRestProvider`, `providerRegistry`), models of Product/Customer/Distributor/PricingMaster/Payment. No Retailer login/portal was added.
