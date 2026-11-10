# PHASE 18 — Business-transaction integration (safe subset)

## 1. Objective
Finish the business-transaction side of the vendor-neutral ERP integration **only where it is technically and business-wise safe**: payment echo prevention and mode mapping, sales change handling, stock/sales/payment reconciliation, a generic read-only reconciliation engine, a provider capability contract, an honest verification ladder, business-capability monitoring, external-ID foundations for invoice/return, and a secure-document-store abstraction. **Invoice, Return and Document synchronisation remain BLOCKED** — implementing them would have required inventing business decisions. Architecture unchanged: ERP → Provider Adapter → Generic Sync Engine → Capability Target → existing DMS service; no SAP logic moved into the engine; no second sync/outbound/accounting architecture; no direct StockLedger/Batch writes; no Retailer login/portal.

## 2. Pre-change audit
`PHASE18_AUDIT.md` (16 findings, classification table). Highest: a DMS payment sent to an ERP would be **booked again** when the ERP listed it (no link, no echo guard); same duplicate risk for DMS-created customers when the outbound link write is lost.

## 3. Capability matrix
| Capability | Class | Inbound | Outbound | Reconciliation |
|---|---|---|---|---|
| Product master | COMPLETE | ✔ | n/a | ✔ |
| Customer master | COMPLETE | ✔ | ✔ | ✔ |
| Distributor master | COMPLETE | ✔ | n/a | ✔ |
| Pricing | COMPLETE | ✔ (sync-created rows only) | n/a | ✔ |
| Stock | **PARTIAL** | ✔ delta only | ✘ | ✔ |
| Sales order | **PARTIAL** | ✔ DRAFT only | ✘ | ✔ |
| Invoice | **BLOCKED** | ✘ | ✘ | ✘ |
| Return | **BLOCKED** | ✘ | ✘ | ✘ |
| Payment | COMPLETE | ✔ | ✔ | ✔ |
| Document | **BLOCKED** (abstraction only) | ✘ | ✘ | ✘ |
Providers: SAP OData and Generic REST implemented (mock verified only); Oracle REST, Dynamics REST, Generic SOAP **UNSUPPORTED** (no adapter, `features: []`).
The same table is returned live by `GET /api/admin/erp-sync/business/overview` (`catalog`) and a test asserts it matches the code (COMPLETE ⇒ a target exists; BLOCKED ⇒ none).

## 4. Ownership decisions
Unchanged mechanism (`erpOwnership.service.js` is not modified, never bypassed). STOCK/SALES/INVOICE/RETURN/DOCUMENT still require an explicit ownership (else BUSINESS_DECISION_REQUIRED). Nothing was silently chosen. Reconciliation is allowed whatever the ownership, but when the capability does not allow importing, **every difference is reported as BLOCKED** (never as something a sync would fix).

## 5. Stock
Unchanged writer: `inventory.postAdjustment` only (test asserts no `StockLedger`/`Batch` writes in the stock code or the reconciliation service). First snapshot over existing DMS stock → BUSINESS_DECISION_REQUIRED (not auto-reconciled); plant→warehouse and batch mappings never guessed; negative stock refused by the ledger; batches never created (FEFO untouched).
New: read-only **stock reconciliation** returning ERP quantity, DMS quantity, difference, last synced snapshot, mapping context and status — MATCHED / MISMATCH / MISSING_IN_DMS (opening can be booked) / PENDING_REVIEW (DMS already holds stock) / BLOCKED (mapping missing).
**Not built (needs a decision):** a workflow to *accept* an ERP baseline over existing DMS stock; ERP-driven batch creation (expiry/MRP).

## 6. Sales
Existing: DRAFT import via `adminSalesOrder.createOrder`, DMS pricing/schemes/GST, external identity (`external_source_type/id` UNIQUE per distributor + link), crash recovery, update only while DRAFT, confirmed order → BDR.
New: optional `cancelled` field — cancelled before import ⇒ nothing created (skipped, no link); DRAFT ⇒ cancelled through the DMS cancel service; confirmed ⇒ **never cancelled by a sync** (BDR). A DRAFT edited in the DMS after the last sync is not overwritten (BDR). Reconciliation for orders. No automatic confirmation exists or was added.

## 7. Invoice — BLOCKED
Preflight/sync/reconciliation/outbound all return a 409 with the reasons; no job, no ERP call, no invoice/journal/stock change (tested, even with `ERP_OWNED` configured). Added: external-ID **foundation** (`SalesInvoiceHeaders.external_source_type/external_source_id`, UNIQUE (distributor, type, id), NULLs never collide — nothing reads or writes them), and a 10-question decision checklist in the overview (ownership, authority, direction, external id, delivery mapping, accounting, receivables, duplicates, existing invoice). Only owner/authority/direction can be DECIDED from configuration; **accounting, receivables, delivery mapping and "already exists in DMS" have no configuration to record them and stay REQUIRED.** No fake invoice sync, no direct invoice insert, no second accounting path.

## 8. Return — BLOCKED
Depends on Invoice and delivery sync. A return must reference a delivered invoice, delivery, batch, quantity, stock re-entry and a credit note; none can be tied to ERP ids yet. Added the same external-ID foundation on `SalesReturns`. Nothing creates returns, credit notes or stock movements (tested).

## 9. Payment — COMPLETE
Inbound still posts only through `payments.createPayment` (journal + balances, unallocated, immutable). New: **mode** = configured `PAYMENT_MODE` code mapping → exact DMS mode name → sync default → else BDR (previously an unknown mode failed validation: intentional assertion change, §18). **Echo prevention** both ways (§12). Outbound: stable idempotency key, ERP id remembered with origin DMS, duplicates answered from the SENT event.

## 10. Document — BLOCKED
`services/erpDocumentStore.service.js`: safe filename, content-type allow-list (PDF/PNG/JPEG) + magic-byte check, size limit (`ERP_DOCUMENT_MAX_BYTES`, default 10 MB), tenant/distributor/external-id storage keys (traversal-proof), SHA-256 and key-exists duplicate detection, malware-scan **hook**, adapter interface (must attest `tenantIsolated`). Nothing is registered by default and the existing `./uploads` disk is deliberately not used; `ingest()` refuses (BDR) without an approved store **and** scanner. `readiness()` lists what is missing: approved store, scanner, document record/external id, access authorisation, audit events, retention policy. **Document sync is not claimed.**

## 11. Outbound
No second architecture: the Phase 16 `send()` is used. Builders unchanged (CUSTOMER_MASTER, PAYMENT). Other capabilities answer `OUTBOUND_SYNC_BLOCKED` with the specific reason (`OUTBOUND_BLOCKERS`). Gates re-verified by test: ERP_OWNED → BDR, missing idempotency attestation → BLOCKED, retry with the same key + correlation id in audit.

## 12. Echo prevention
| Flow | Rule |
|---|---|
| DMS → ERP → DMS (customer, payment) | Engine: an inbound ERP id that equals the `external_id` of a SENT outbound CREATE for the same entity type is linked to that DMS row (origin DMS), never created again — works even if the outbound link write was lost. |
| first inbound sight of a DMS-origin link | binds the hash only; the DMS row is not rewritten. Later genuine ERP changes follow the target's update rules. |
| Payment adoption | ERP `reference_no` equal to a DMS `payment_number` (same customer & amount) ⇒ adopted/linked; different customer/amount ⇒ BDR. |
| ERP → DMS → ERP | `origin = ERP` links: customers are not sent back until the DMS changed them after the last ERP sync; payments with an ERP link (or `ERP<id>-` reference) are blocked outbound. |
Source tracking: `erp_external_links.origin` ("ERP" | "DMS"); correlation ids already flow to jobs/outbound/audit.

## 13. Idempotency (natural identity; never names or random ids)
Product/Customer/Pricing/Payment/Sales/Stock identities are published per target (`identity` in `describeTargets()` and the overview): ERP connection + ERP id + distributor (+ customer group for prices; + product/plant/batch row key and last-snapshot quantity for stock). DB guarantees: `uq_erp_link_identity`, `uq_sales_order_external_source`, payment `(distributor, reference_no)`, `uq_erp_outbound_idem`, and (foundation) the invoice/return external-source indexes.

## 14. Reconciliation
`POST /erp-sync/reconciliation` (ERP_SYNC; reads the ERP) · `GET /erp-sync/reconciliation` (ERP_VIEW; stored results). One service for every ERP: provider read → mapping → target `reconcile()` → status. Statuses: MATCHED, MISMATCH, MISSING_IN_DMS, MISSING_IN_ERP (only when the whole ERP result set was read), BLOCKED, PENDING_REVIEW. **Writes nothing to business data**; stores only `reconcile_status/at/detail` on the compared link rows and one `ERP_RECONCILIATION_RUN` audit event. Supported: product, customer, distributor, pricing, stock, sales order, payment (posted-payment difference ⇒ BLOCKED, never rewritten). Tenant isolated (foreign connection ⇒ 404, no ERP call); bounded (50 pages / 5 000 records / 200 returned items).
**Limit:** MISSING_IN_DMS for records without a link is shown in the run result and audit counts only (nothing to attach a stored note to).

## 15. Provider capabilities
`providerRegistry`: `features[]` from READ, CREATE, UPDATE, DELETE, PAGINATION, IDEMPOTENCY, OAUTH, BASIC_AUTH, BEARER_AUTH, API_KEY_AUTH, ODATA, REST + `unsupportedFeatures[]` + `verification{mock,real}`. SAP: READ CREATE UPDATE PAGINATION IDEMPOTENCY BASIC_AUTH ODATA. REST: + BEARER/API_KEY/REST. Nobody provides DELETE or OAUTH. Non-implemented providers report no features whatever they list. A test checks the declared READ/CREATE/UPDATE/DELETE against each class's real `supports`.

## 16. UI changes (existing ERP dashboard only)
`ErpBusinessPanel` on the ERP Integration dashboard: per-capability table (classification, status, last success/failure, processed/failed, pending decisions, differences, highest verification), per-connection capability list with blockers explained in plain words (e.g. "Business decision required: …"), ownership, mapping status, last-run counts (created/updated/skipped/failed), outbound counts, reconciliation counts, invoice decision checklist, document-store blockers, and a **Compare** action (`ErpReconcileModal`, needs ERP_SYNC; UX only — the server enforces). States: READY / WARNING / BLOCKED / RUNNING / SUCCESS / PARTIAL / FAILED. No stack traces; no "production ready" wording.

## 17. Database changes
`migrations/20261011090000-erp-phase18.js` — additive, idempotent, reversible, **no new table**: `erp_external_links` + `origin`, `reconcile_status`, `reconciled_at`, `reconcile_detail` and `ix_erp_link_reconcile`; `SalesInvoiceHeaders` and `SalesReturns` + `external_source_type/id` and UNIQUE indexes. Verified on sqlite (up / up / down / down / up) in the Phase 18 suite. **MySQL migration not verified** (no MySQL server here) — run on a staging copy first.

## 18. Tests
New `tests/erp-business-phase18.test.js` — **41 tests**: stock (opening/delta/conflict/mappings/negative/reconciliation/no direct writes), sales (create/duplicate/update/confirmed/cancel/DMS-edit/reconcile/ownership), invoice (blocked, decisions, accounting untouched, external-id indexes), return (dependency, nothing created), document (blocked, abstraction), payment (inbound/outbound/mode/duplicate/echo ×3/reconcile), outbound gates & retry, customer echo ×3, generic reconciliation (+tenant isolation, validation, audit), provider contract, verification ladder, monitoring, migration. All transports are mocks.
**Intentional assertion changes** (existing tests, nothing weakened): `erp-sync-phase14` route count 16 → 19 (3 new routes); `erp-security-phase17` RBAC matrix — 3 rows **added**; `erp-sync-phase15` payment errors `["BDR","VALIDATION_ERROR","VALIDATION_ERROR"]` → `["BDR","BDR","VALIDATION_ERROR"]` (an unmapped ERP payment mode now needs a mapping decision instead of failing validation); `erp-integration-phase13` comment only.

## 19. Build / lint
Backend `npx jest --runInBand`: **726 tests, 720 passed, 6 failed** (21 suites: 19 passed, 2 failed). **NEW failures: 0.** **PRE-EXISTING: 6** — 5 in `fefo-expiry-phase6` (real-date dependent, same as baseline) and 1 in `inventory-phase5` "Stock Ledger › entries, running balance…", which passed in the baseline run on 2026-10-08 but fails on the **untouched Phase 17 zip** when run on 2026-10-09 (date-dependent; root cause not investigated here). Baseline 685 + 41 new = 726. Frontend `npm run build`: success; ESLint on `src/features/erpIntegration`: no findings.

## 20. Real ERP verification
**SAP: mock verified; real SAP connection NOT verified.** Generic REST: mock verified; no real REST ERP verified. Oracle / Dynamics: **no adapter — not supported**; no production support claimed. Verification ladder per connection + capability: NOT_CONFIGURED < CONFIGURED < MOCK_VERIFIED < CONNECTION_TESTED < READ_VERIFIED < WRITE_VERIFIED < PRODUCTION_VERIFIED. CONNECTION_TESTED = a real connection test passed; READ_VERIFIED = a completed job read records; WRITE_VERIFIED = an outbound write was SENT. **PRODUCTION_VERIFIED is never set automatically** (needs a recorded sign-off the system does not have). Configuration alone never exceeds MOCK_VERIFIED.

## 21. Known limitations
* Rate limiter / denial throttle remain per process (Phase 17).
* Overview reports missing required field mappings as blockers, but **`startSync` preflight was not tightened** (it still checks only "a key is mapped"), because that would change Phase 14–16 behaviour; per-record validation still fails safely.
* Stock: no baseline-acceptance workflow, no batch creation, no outbound.
* Sales: no outbound, no automatic confirmation, order lines are compared by content hash (not line by line).
* Payments are booked unallocated; reversal unsupported.
* Echo adoption relies on the ERP returning the id it assigned (`outbound.externalIdPath`) or echoing the DMS payment number in the mapped reference field.
* `MISSING_IN_DMS` for unlinked records is not persisted.
* READ_VERIFIED cannot distinguish a test double from a real ERP; in production only real transports exist.
* Alerts remain screen-only; no external queue (Phase 17 limitations stand).

## 22. Remaining business decisions
Stock: ownership; baseline rule for existing DMS stock; plant→warehouse mappings; whether ERP data may create batches. Sales: ownership; whether auto-confirmation may ever exist; DMS→ERP order/line representation. **Invoice:** ownership/authority; accounting & receivables rule for an imported invoice; ERP invoice ↔ DMS delivery mapping; behaviour when the invoice already exists. **Return:** ownership; invoice+delivery sync (or alternative); credit-note and stock-re-entry rule. Payment: whether ERP payments should be auto-allocated. Pricing: ownership of manually entered prices. **Document:** approved tenant-isolated store, malware scanner, document record/access rules, retention period. Providers: real Oracle/Dynamics API details; real SAP access for verification.

## 23. Files created
Backend — `services/erpBusiness.service.js`, `services/erpReconciliation.service.js`, `services/erpDocumentStore.service.js`, `migrations/20261011090000-erp-phase18.js`, `tests/erp-business-phase18.test.js`, `PHASE18_AUDIT.md`, `PHASE18_DELIVERABLES.md`.
Frontend — `src/features/erpIntegration/components/ErpBusinessPanel.jsx`, `components/ErpReconcileModal.jsx`, `erpBusinessDisplay.js`.

## 24. Files modified
Backend — `services/erp/sync/syncEngine.js` (echo prevention, skip/adopt outcomes, origin), `services/erp/sync/targets.js` (payment mode + adoption, sales cancel/guard, stock/sales/payment/other `reconcile`, identity & change policy, invoice/return reasons), `services/erpOutbound.service.js` (payment link + source tracking, echo rule, blockers), `services/erp/providerRegistry.js`, `services/erpAudit.service.js` (1 event name), `controllers/admin.erp.controller.js`, `routes/adminRoutes.js` (3 routes), models `erpexternallink`, `salesinvoiceheader`, `salesreturn`, tests `erp-sync-phase14`, `erp-sync-phase15`, `erp-security-phase17`, `erp-integration-phase13` (comment).
Frontend — `api/erpApi.js`, `pages/ErpIntegrationDashboardPage.jsx`.

## 25. Intentionally unchanged
`erpOwnership.service.js`; RBAC (`config/erpPermissions.js`, `middleware/erpAccess.js` — the new routes use existing permissions); authentication; tenant isolation; URL/SSRF policy; redaction; scheduler; `sapProvider.js`, `odataClient.js`, `genericRestProvider.js`; `inventory.service`, `accounting.service`, `payments.service`, `adminSalesOrder.service`; FEFO, claims, schemes; Distributor/Retailer modules; `middleware/upload.js`; existing migrations. No Retailer login/portal, no Oracle/Dynamics adapter, no second accounting path, no direct StockLedger writes.
