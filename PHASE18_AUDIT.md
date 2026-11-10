# PHASE 18 — Pre-change audit (business-transaction integration, Phase 13–17 baseline)

Method: read the code of the Phase 17 delivery (not its claims), ran the existing suite for a baseline (**685 tests: 680 pass, 5 fail** — all `fefo-expiry-phase6`, date-dependent), then classified every capability.
Classes: **COMPLETE** (works end to end for what the DMS can do safely) · **PARTIAL** (works within stated limits, something is deliberately missing) · **BLOCKED** (cannot be built safely until a business decision / dependency exists) · **UNSUPPORTED** (no implementation).

## 1. Capability classification (before Phase 18 → after)

| Capability | ERP → DMS | DMS → ERP | Before | After Phase 18 | Evidence in code |
|---|---|---|---|---|---|
| Product master | `productTarget` (HSN via code mapping) | n/a | COMPLETE | COMPLETE (+ read-only reconciliation) | `targets.js` |
| Customer master | `customerTarget` | `BUILDERS.CUSTOMER_MASTER` | COMPLETE | COMPLETE (+ echo prevention, reconciliation) | `targets.js`, `erpOutbound.service.js` |
| Distributor master | `distributorTarget` | none | COMPLETE | COMPLETE (+ reconciliation) | |
| Pricing | `pricingTarget` (sync-created rows only) | none | COMPLETE | COMPLETE (+ reconciliation) | `assertNoManualPrice` |
| Stock | `stockTarget` (delta through `inventory.postAdjustment`) | none | PARTIAL | **PARTIAL** (+ reconciliation with ERP/DMS qty, difference, last snapshot) | `applyStock` |
| Sales order | `salesTarget` → DRAFT via `adminSalesOrder.createOrder` | none | PARTIAL | **PARTIAL** (+ ERP cancellation, DMS-edit conflict guard, reconciliation) | `external_source_*` on `SalesOrderHeaders` |
| Invoice | none (`UNSUPPORTED.INVOICE`) | none | BLOCKED | **BLOCKED** (+ external-id columns, decision checklist, preflight) | `SalesInvoiceHeader` has `uniq_salesinvoice_delivery`; posts accounting |
| Return | none | none | BLOCKED | **BLOCKED** (+ external-id columns, dependency chain documented) | `SalesReturn` needs `invoiceId`, `creditNoteId` |
| Payment | `paymentTarget` via `payments.createPayment` | `BUILDERS.PAYMENT` | PARTIAL (echo only by reference prefix; mode only DMS names inbound) | **COMPLETE** | see §3 |
| Document | none | none | UNSUPPORTED | **BLOCKED** (abstraction + readiness only; **not** complete) | `middleware/upload.js` is unscoped local disk |

## 2. Providers
SAP OData — IMPLEMENTED, mock verified only. Generic REST — IMPLEMENTED, mock verified only. Oracle REST, Dynamics REST — FOUNDATION_ONLY → **UNSUPPORTED** (no adapter; `create: null`). Generic SOAP — FUTURE → UNSUPPORTED. No real ERP has been reachable from this environment.

## 3. Findings (each verified against the code)

| # | Area | Finding in the Phase 17 code | Sev | Phase 18 action |
|---|---|---|---|---|
| 1 | Echo (DMS→ERP→DMS) | A payment sent to an ERP gets no link row (`link()` returns null, `onCreated` is a no-op). When the ERP lists it, `PAYMENT` inbound would create a **second DMS payment** — money booked twice. | H | Outbound records the ERP id (origin DMS); the engine adopts an ERP record that matches a SENT outbound event; payment target also adopts by the DMS payment number. |
| 2 | Echo (customers) | If the outbound link write fails after the ERP accepted a customer, the ERP's copy later imports as a **duplicate DMS customer**. | H | Same engine rule (SENT outbound event with that ERP id ⇒ link to the DMS row, create nothing). |
| 3 | Echo (ERP→DMS→ERP) | An ERP-created customer is pushed back as an UPDATE on the first outbound send (hash definitions differ inbound/outbound). | M | `origin` column; unchanged-since-ERP-sync records are not sent. |
| 4 | Payment mode (inbound) | Only exact DMS names accepted; ERP codes had no mapping path although `PAYMENT_MODE` code mappings exist for outbound. | M | Mapping first, exact DMS name second, else BUSINESS_DECISION_REQUIRED. |
| 5 | Sales change handling | A DRAFT imported from the ERP and then edited by a person is silently overwritten by the next ERP change; an ERP cancellation is not understood. | M | DMS-edit guard (BDR); `cancelled` field: never imported, DRAFT cancelled via DMS service, confirmed never touched. |
| 6 | Reconciliation | No way to compare ERP vs DMS; a refused first stock snapshot only lived in a per-record sync error. | M | Generic read-only reconciliation (6 statuses), link-level stored result, audit event. |
| 7 | Provider contract | `supports {fetch,create,update,delete}` only; no auth / pagination / idempotency / protocol declaration; no verification status. | M | `features[]` + `verification{mock,real}` per provider, checked against the real class in tests. |
| 8 | Verification honesty | UI/API had no "how far is this verified" notion; "REACHABLE" could be read as ready. | M | Verification ladder; PRODUCTION_VERIFIED is never automatic. |
| 9 | Mapping preflight | Start-sync checked only "a key is mapped"; missing required target fields surfaced as per-record errors. | M | Overview reports required-field gaps as blockers; **sync preflight left unchanged** (see limitations). |
| 10 | Invoice | No external id on `SalesInvoiceHeaders`; one invoice per delivery; posting creates journal + receivables. Importing would duplicate or bypass accounting. | — | Blocked. External-id foundation + 10-question decision checklist; nothing imports. |
| 11 | Return | Needs delivered invoice, batch, quantity, credit note and stock re-entry; none can be linked to ERP ids. | — | Blocked. Foundation columns only. |
| 12 | Document | No document table, no tenant isolation in `uploads/`, no scanner, no authorisation. | — | Abstraction + readiness; ingestion refused without an approved store + scanner. |
| 13 | Outbound builders | Only CUSTOMER_MASTER and PAYMENT; other capabilities answered a generic "not available". | L | Capability-specific reasons (`OUTBOUND_BLOCKERS`). |
| 14 | Monitoring | Capability-agnostic (jobs / alerts); no per-business-capability view. | M | `/erp-sync/business/overview`. |
| 15 | Stock, other | Opening/delta/negative-stock/idempotency/ownership are correct and tested; plant→warehouse and batch mappings never guessed; no direct ledger writes. | — | Verified, unchanged. |
| 16 | Pre-existing test failures | 5 × `fefo-expiry-phase6` (date dependent). Also observed while working: `inventory-phase5` "Stock Ledger entries" fails on the **untouched Phase 17 zip** on 2026-10-09 (passed in the baseline run on 2026-10-08). | — | Not touched. |

## 4. Not changed (verified safe)
Ownership gate (`erpOwnership.service.js`), RBAC, tenant isolation, SSRF/URL policy, redaction, audit immutability, scheduler, inventory/accounting services, FEFO, claims, schemes.
