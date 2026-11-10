# PHASE 16 — ERP Business Integration, Ownership & Advanced Sync

Architecture is unchanged: **ERP → Provider Adapter → Generic Sync Engine → Capability Target → existing DMS service.** SAP is one provider. The generic engine, mapper and targets contain no vendor vocabulary (a test enforces it, including "no CSRF").

## 1. Audit findings (before any change)
- `inventory.postMovement` is the only ledger writer; `postAdjustment` wraps it. `StockLedger` has a UNIQUE index on (reference_type, reference_id, reference_line_id, batchId, movement_type). Batches carry expiry/MRP and auto-inactivate on expiry. Warehouses are per distributor.
- `adminSalesOrder.createOrder` is the Admin "New order" path: PricingMaster is the only price source; schemes, GST and stock are validated there. `SalesOrderHeader` had no external id.
- Invoices and returns are created from deliveries inside controllers and post Phase 12 accounting. There is no external invoice id and no document store.
- `AdminUser.role` is a label only (no RBAC). No Redis / queue library exists (`package.json`).
- **Pre-existing bug found and fixed:** `salesOrder.controller.generateOrderNumber` read `split("-")[1]` (= `"SO"`), so every order of a distributor got number `…-0001` and the second one failed on the UNIQUE `order_number`. It now uses the last segment (and an `id` tie-break). Existing numbers are unchanged; regression test added.

## 2. Ownership mechanism
`erp_connection_capabilities.ownership` (`ERP_OWNED | DMS_OWNED | SHARED`, NULL = undecided) next to `direction` (`ERP_TO_DMS | DMS_TO_ERP | BIDIRECTIONAL | DISABLED`). One pure gate, `services/erpOwnership.service.js`, used by preflight, the engine (defence in depth) and outbound.
- Inbound needs ERP_OWNED or SHARED; outbound needs DMS_OWNED or SHARED; a conflict → `BUSINESS_DECISION_REQUIRED`.
- **STOCK, SALES, INVOICE, RETURN, DOCUMENT**: ownership unset → `BUSINESS_DECISION_REQUIRED`, naming the decision.
- **PRODUCT / CUSTOMER / DISTRIBUTOR / PRICING / PAYMENT** predate ownership: when unset, the direction chosen in Phase 14/15 is the decision (flagged `implied`). This keeps existing connections working; it is the one deliberate deviation from "unconfigured ⇒ blocked".
- A client that omits `ownership` never wipes a stored decision; changes are audited (`ERP_OWNERSHIP_UPDATED`).

## 3. ERP code mappings (Customer Group, HSN, Plant→Warehouse, Batch, Payment mode)
Stored in the **existing** `erp_external_links` (new nullable `dms_value` column; types `CODE_*`; scope `distributor:<id>`). No new mapping table. API: `GET/PUT /erp-integrations/:id/code-mappings`, `DELETE …/:mappingId`. The DMS row must belong to the chosen distributor; synced-record links cannot be deleted here. Missing code → per-record `BUSINESS_DECISION_REQUIRED` (never guessed).

## 4. Customer Group and HSN / Tax
- Customer target: optional field `customer_group_code` → mapped group for **new** customers (else the sync's default group). An existing retailer's group stays DMS-owned.
- Product target: optional field `hsn_code` → mapped HSN record (`hsn_id`). **Limit:** the product's GST rate columns (`cgst/sgst/igst/gst`) — which `tax.service` actually uses for sales — stay DMS-managed; the mapping sets the HSN record only.

## 5. Stock — **PARTIAL (implemented, constrained)**
Delta posting only, through `inventory.postAdjustment` (a test asserts the target never writes `StockLedger`/`Batch` directly).
- ERP value = on-hand snapshot per product + plant + batch; posted = ERP qty − previous ERP qty (kept on the link row). ERP rows are separate ledger entries (first snapshot `OPENING`, later `CORRECTION`, reason `ERP-SYNC job …`), so DMS sales/returns/transfers are never overwritten.
- First snapshot is refused (`BUSINESS_DECISION_REQUIRED`) if the DMS already holds stock for that batch + warehouse.
- Plant→warehouse mapping is mandatory. Batches are **never created**: the batch must exist (Batch code mapping `<ERP product>|<batch no>`, else exact batch number). FEFO untouched; negative stock refused by the ledger.
- Constraints: the mapped key field must identify one product+plant+batch row; whole-unit quantities; ownership ERP_OWNED or SHARED. ERP-sourced rows are distinguishable by `reason`/`reference_type` only (the ledger has no source column and `postAdjustment` takes no reference id).

## 6. Sales — **PARTIAL (implemented, constrained)**
ERP order → DMS **DRAFT** order via `adminSalesOrder.createOrder` (update via `updateOrder`). Prices/totals from the ERP are ignored; PricingMaster, schemes, GST and stock validation apply. The sync never confirms, delivers or invoices — credit-limit and approval still happen when a person confirms.
- New generic columns `external_source_type` (`ERP:<connection id>`) and `external_source_id`, UNIQUE per distributor; plus the link row. A remarks marker recovers from a crash between "created" and "stamped" (no duplicate).
- ERP change applied only while the DMS order is DRAFT; later → `BUSINESS_DECISION_REQUIRED`.
- Lines use a generic line mapping: `lines.product_external_id` ← `Items.results[].Material`, `lines.quantity` ← `Items.results[].Qty`. The ERP endpoint must return the lines inside the order record (e.g. OData `$expand` via the endpoint/query settings). Payment terms must be mapped or given as the sync's default. Discounts are not imported.

## 7. Invoice — **BLOCKED**
Decision needed: (1) which system owns invoices; (2) approval to add an external invoice id to the invoice; (3) how an ERP invoice maps to a DMS delivery + invoice (a DMS invoice comes from a delivery and posts Phase 12 journals and receivables). Importing without it would duplicate accounting. No `erpAccounting.service` was created.

## 8. Return — **BLOCKED**
Needs delivered DMS invoices/deliveries with external ids (see Invoice) before a return can be attached; it also drives stock re-entry and credit notes.

## 9. Payment — **COMPLETE for what was asked**
Payment-mode mapping through code mappings (`PAYMENT_MODE`); outbound payments resolve the ERP mode code or fail with `BUSINESS_DECISION_REQUIRED`. Inbound (Phase 15) keeps its explicit `defaultMode` behaviour; wiring inbound mode resolution to the code mapping is **not** done (documented, not claimed).

## 10. Document — **BLOCKED / NOT_SUPPORTED**
No tenant-isolated document store (allow-list, size limit, safe filename, path-traversal protection, malware-scan hook, external document id, duplicate detection). Nothing was added to the file-upload code.

## 11. Outbound DMS → ERP foundation — **IMPLEMENTED (foundation; mock-verified only)**
- Provider write contract `create` / `update` (base class still refuses → `PROVIDER_NOT_SUPPORTED`; delete nowhere).
- Generic REST: `POST`, `PUT`/`PATCH` on `<endpoint>/<ERP id>`, `Idempotency-Key` header. SAP OData: `POST` / `PATCH <set>('<key>')`; **CSRF token + session cookie fetched, replayed and refreshed once on 403 inside `sapProvider.js`** (never in the engine or outbound service; never logged).
- `OUTBOUND_SYNC_BLOCKED` unless the capability config attests `outbound.idempotencySupported` (and the provider can write). `erp_outbound_events.idempotency_key` is UNIQUE: a SENT key is never sent again; a failed one is retried with the same key.
- Builders exist for **CUSTOMER_MASTER** (create/update) and **PAYMENT** (create only; posted payments are immutable; payments that came from the ERP are not echoed back). Mapping rows are reused in reverse (ERP field ← DMS value); transforms are not applied outbound; flat field names only.
- API: `POST/GET /erp-sync/outbound`. **No UI** for outbound in this phase.

## 12. Provider expansion — **FOUNDATION_ONLY (unchanged)**
Oracle and Dynamics remain `FOUNDATION_ONLY`: no API documentation or credentials were provided, so no adapter was written and they are not production-ready (GENERIC_REST can be used if the system exposes plain JSON).

## 13. Scheduler and real queue — **No real queue**
Redis/Memurai/queue libraries were inspected: none exist. The DB-backed scheduler + worker is kept (persistent jobs, retry with backoff, concurrency cap, CAS claim / `active_key` job locking, stale-job reaping). Added: graceful shutdown (`SIGTERM`/`SIGINT`: stop timers, wait up to `ERP_SHUTDOWN_GRACE_SECONDS`, default 20, jobs still running are reaped on next start). **Missing for a real queue:** an external broker (e.g. Redis + BullMQ), dead-letter queue, cross-process worker scaling. Documented as required for high volume.

## 14. Persistent audit — **COMPLETE**
`erp_audit_events` (append-only: model hooks refuse update/destroy; no write route). Fields: tenant, actor, event, ERP, capability, entity, entity id, timestamp, correlation id, safe metadata (secret-looking keys dropped, strings truncated). Events: connection created/updated/activated/deactivated/tested, mapping and ownership and code-mapping updates, sync created/started/completed/partial/failed/retried, schedule created/updated/disabled/triggered/skipped, outbound started/completed/failed/blocked. Existing `audit()` calls feed it (console line kept). API `GET /erp-sync/audit` with filters date, ERP, capability, user, event, status, correlation; UI page *ERP Audit Log*. Names: Phase 13's `ERP_CREATED/UPDATED` are stored as `ERP_CONNECTION_CREATED/UPDATED`.

## 15. RBAC — **PARTIAL / not enforced**
`AdminUser.role` is only a label and no permission system exists; inventing one would change authentication for every Admin module. ERP_VIEW / MANAGE / SYNC / RETRY / SCHEDULE / AUDIT are **not** enforced; every ERP route requires an Admin session (unchanged, tested). Needed: a role/permission table and middleware agreed for all modules.

## 16. Monitoring & alerts
Summary adds success/failure rate (7 days, `null` when nothing completed — no invented numbers), partial, queued, scheduled jobs, last failed sync, worker description; per-ERP 7-day counts already existed. Alert foundation (`GET /erp-sync/alerts`, also in the summary): connection error, repeated sync failure, stuck job, overdue scheduler, retries exhausted, undecided ownership, outbound problems. Monitoring only — no e-mail/SMS/webhook.

## 17. Performance
Paged lists (audit, code mappings, outbound, errors), batched provider pages (existing), controlled concurrency (`ERP_SYNC_MAX_CONCURRENT`), bounded alert query sizes. No load test was run.

## 18. Tenant isolation
Tenant comes only from the admin session. Foreign-tenant connection → 404 and **no ERP call** (tested for code mappings, outbound, audit, alerts).

## 19. Migration
`20261009090000-erp-phase16.js`: additive, idempotent, reversible (up/down/up tested on sqlite): `ownership`, `dms_value`, `erp_audit_events`, `erp_outbound_events`, `SalesOrderHeaders.external_source_*` + UNIQUE `(distributor_id, external_source_type, external_source_id)`. Not run on MySQL here (no MySQL available); written with portable QueryInterface calls only.

## 20. Tests
`tests/erp-sync-phase16.test.js` — 36 tests (ownership, code mappings, stock, sales, blocked capabilities, outbound incl. SAP CSRF, audit, alerts, shutdown, migration). Earlier suites updated only where Phase 16 intentionally changes behaviour (route counts, directions list, supported capabilities, provider write flags). **Mock fetch is used everywhere: these tests prove our protocol handling, not ERP connectivity.** There is no queue test because there is no real queue.

## 21. Regression, build, lint
Backend full run: **564 of 569 pass** (Phase 16: 36/36; Phases 13–15: all pass after the intentional assertion updates). The only 5 failures are the pre-existing `fefo-expiry-phase6` ones. Pre-existing failures (identical on the Phase 14 zip): 5 in `fefo-expiry-phase6` (hard-coded 2026-09-24 clock vs real-date batch expiry). Frontend `npm run build` passes; ERP files lint clean. Backend has no lint script.

## 22. Manual flow testing
Not possible here: no MySQL, no admin session, no ERP. Flows were exercised through controllers/services with mocked transports only.

## 23. Real ERP verification
| ERP | Verified against a real system? |
|---|---|
| SAP | **NO** (OData/CSRF verified against mocks only) |
| Oracle | **NO** (no adapter) |
| Dynamics | **NO** (no adapter) |
| Other / generic REST | **NO** |

## Business decisions still required
1. Stock: confirm ERP-vs-DMS ownership per distributor, plant→warehouse and batch mappings, and how to reconcile existing DMS stock before the first snapshot.
2. Sales: confirm order ownership and default payment terms; whether ERP orders should ever be auto-confirmed (currently never).
3. Invoice / Return: decisions in §7–8.
4. Document: approve a secure store (§10).
5. RBAC model (§15). 6. A real queue/broker (§13). 7. Which ERPs besides SAP, with API docs and credentials.

## Final status
- Stock: **PARTIAL** · Sales: **PARTIAL** · Invoice: **BLOCKED** · Return: **BLOCKED** · Payment: **COMPLETE** (as scoped) · Document: **BLOCKED**
- Outbound: **IMPLEMENTED (foundation, no UI)** · Provider expansion: **FOUNDATION_ONLY** · Scheduler: **IMPLEMENTED (DB-backed, graceful shutdown)** · Real queue: **NOT IMPLEMENTED** · Persistent audit: **COMPLETE** · RBAC: **PARTIAL (not enforced)** · Multi-ERP: **COMPLETE** · Tenant isolation: **COMPLETE**
- Tests: 564/569 (5 pre-existing, unrelated) · Build: frontend PASS, ERP files lint clean
- Real ERP verification: SAP NO · Oracle NO · Dynamics NO · Other NO

### FILES CREATED (backend)
`migrations/20261009090000-erp-phase16.js`, `models/erpauditevent.model.js`, `models/erpoutboundevent.model.js`, `services/erpAudit.service.js`, `services/erpOwnership.service.js`, `services/erpCodeMapping.service.js`, `services/erpOutbound.service.js`, `tests/erp-sync-phase16.test.js`, `PHASE16_DELIVERABLES.md`
### FILES CREATED (frontend)
`features/erpIntegration/pages/ErpAuditLogPage.jsx`, `features/erpIntegration/components/ErpCodeMappingModal.jsx`
### FILES MODIFIED (backend)
`models/index.js`, `models/erpconnectioncapability.model.js`, `models/erpexternallink.model.js`, `models/salesorderheader.model.js`, `controllers/salesOrder.controller.js` (order-number bug fix), `controllers/admin.erp.controller.js`, `routes/adminRoutes.js`, `server.js`, `services/erpIntegration.service.js`, `services/erpSync.service.js`, `services/erpMonitoring.service.js`, `services/erpScheduler.service.js`, `services/erp/erpConstants.js`, `services/erp/erpErrors.js`, `services/erp/httpClient.js`, `services/erp/providerContract.js`, `services/erp/providerConfig.js`, `services/erp/genericRestProvider.js`, `services/erp/sapProvider.js`, `services/erp/sync/{targets,syncEngine,mapper}.js`, `tests/erp-integration-phase13.test.js`, `tests/erp-sync-phase14.test.js`, `tests/erp-sync-phase15.test.js`
### FILES MODIFIED (frontend)
`App.jsx`, `config/adminNavigation.js`, `features/erpIntegration/api/erpApi.js`, `components/ErpFormModal.jsx`, `components/ErpConnectionCard.jsx`, `pages/ErpConnectionsPage.jsx`, `pages/ErpIntegrationDashboardPage.jsx`
### NOT CHANGED
Inventory, accounting, receivables, payments, pricing, tax, scheme, claims, retailer and distributor services; invoice / return / delivery controllers; authentication and `AdminUser`; upload code. No Retailer login or portal.
