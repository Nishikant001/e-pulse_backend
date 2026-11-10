# PHASE 19 — Pre-change audit (Invoice / Return architecture, decisions, preflight, verification)

Method: unpacked the Phase 18 backend and frontend, read the **code** (not the phase reports), ran the full suite for a baseline on **2026-10-10 (IST)**, then classified every item.
Classes: **COMPLETE** (works end to end for what the DMS can do safely) · **PARTIAL** (works within stated limits) · **BLOCKED** (cannot be built safely until a decision / dependency exists) · **UNSUPPORTED** (no implementation).

## 0. Baseline test run (clean, single process, `npx jest --runInBand`)

| | Phase 18 report | This baseline (2026-10-10) |
|---|---|---|
| Tests | 726 | 726 |
| Passed / failed | 720 / 6 | **714 / 12** |
| Failing suites | `fefo-expiry-phase6` (5) + `inventory-phase5` (1) | `fefo-expiry-phase6` (12); `inventory-phase5` **passed** |

The failure count grew from 5 to 12 simply because real time passed: root cause in §3.9.

## 1. Capability classification

| Capability | ERP → DMS | DMS → ERP | Class (verified in code) | Evidence |
|---|---|---|---|---|
| Product master | `productTarget` | n/a | **COMPLETE** | `targets.js`, reconcile() |
| Customer master | `customerTarget` | `BUILDERS.CUSTOMER_MASTER` | **COMPLETE** | echo prevention in `syncEngine.js` |
| Distributor master | `distributorTarget` | none | **COMPLETE** | |
| Pricing | `pricingTarget` (sync-created rows only) | none | **COMPLETE** (manual-price ownership still an open decision) | `assertNoManualPrice` |
| Stock | `stockTarget` (delta via `inventory.postAdjustment`) | none | **PARTIAL** | first snapshot over DMS stock refused; no batches created |
| Sales order | `salesTarget` → DRAFT via `adminSalesOrder` | none | **PARTIAL** | no auto-confirm, no outbound |
| Invoice | none | none | **BLOCKED** | §2.1 |
| Return | none | none | **BLOCKED** | §2.2 |
| Payment | `paymentTarget` via `payments.createPayment` | `BUILDERS.PAYMENT` | **COMPLETE** (unallocated; allocation decision open) | |
| Document | none | none | **BLOCKED** (abstraction + readiness only) | §3.7 |

Providers: SAP OData — IMPLEMENTED, **mock verified only**. Generic REST — IMPLEMENTED, **mock verified only**. Oracle REST, Dynamics REST — **UNSUPPORTED** (no adapter). Generic SOAP — **UNSUPPORTED**. No real ERP has ever been reached from this environment.

## 2. Invoice and Return — what the existing DMS code actually allows

### 2.1 Invoice (read from `controllers/salesinvoice.controller.js`, `models/salesinvoiceheader.model.js`)
| Finding | Consequence for an imported ERP invoice |
|---|---|
| `create` and `post` are **controller functions on `req/res`**; there is no invoice service. (`adminSalesOrder.service` already calls controllers through an `invokeAsDistributor` shim, so a safe call path *exists* technically.) | Reuse is possible only by invoking the controllers; nothing to bypass, but also no seam for an external id. |
| An invoice is built from **one existing delivery** (`uniq_salesinvoice_delivery`). | An ERP invoice needs a DMS delivery first. |
| A delivery **moves stock OUT** (`salesdelivery`). | If the ERP is stock owner (stock sync books ERP deltas), creating deliveries for ERP invoices decreases the same stock a second time. **Cross-capability conflict.** |
| `invoice_number` is generated (`<DIST>-INV-nnnn`); `invoiceDate = new Date()`; prices from the **order line**; tax from the **product's HSN** (`tax.computeLineTax`). | The ERP's own number, date, prices, taxes and totals **cannot be stored**; "ERP invoice is authoritative" cannot be honoured. |
| `create` has **no input** for `external_source_type/id` (columns exist since Phase 18, nothing writes them). | Duplicate detection by external id cannot be applied on the create path. |
| `post` (DRAFT→POSTED) creates AR / Sales / Output-GST journals and `outstandingAmount` in one transaction. | If the ERP books accounting, importing must skip posting; if the DMS books it, posting must run exactly once. **Not decided.** |

Verdict: **BLOCKED**. Exact missing dependencies: (1) ownership/authority decision, (2) a way to carry the ERP number/date/figures (or a decision to accept DMS-computed figures and only *reconcile* differences), (3) delivery/stock-OUT rule consistent with stock ownership, (4) accounting/receivables rule, (5) existing-invoice rule, (6) an external-id input on the create path. None can be invented.

### 2.2 Return (read from `controllers/salesreturn.controller.js`, `salescreditnote.controller.js`, `returnableQuantity.service.js`)
| Finding | Consequence |
|---|---|
| `create` needs a **POSTED** invoice, `invoiceLineId` and `batchId` per line; quantity capped at what is still returnable. | A return cannot exist without a linked DMS invoice → depends on Invoice. |
| `post` does stock IN (`inventory.postMovement`) **and** `createFromReturn` + `postCreditNoteAccounting` in one transaction. | Good atomic design to reuse later; never write StockLedger directly. |
| Return number generated; no external-id input. | Same gap as invoice. |
| Stock IN while ERP owns stock ⇒ the ERP's own return would also arrive as a stock delta. | Double counting unless ownership is decided consistently. |

Verdict: **BLOCKED** (dependent on Invoice). Orphan returns are refused by the existing service and remain impossible.

## 3. Findings and actions

| # | Area | Finding (verified) | Sev | Action in Phase 19 |
|---|---|---|---|---|
| 3.1 | Mapping preflight | `erpSync.preflight` checked only "a key row exists". Required target fields were enforced only at **save** (`saveMappings`), so a stale/hand-edited mapping set started a job and failed record by record. | M | New `mappingPreflight.js`: field-level blockers (key, empty source path, non-writable stale field, unmapped required field, PAYMENT mode source, SALES payment-terms source) + non-blocking warnings; used by sync start/retry/scheduler **and** the dashboard overview (single evaluator). |
| 3.2 | Preflight compat | Would stricter validation break supported configs? | — | Verified: all 374 pre-existing ERP tests pass unchanged; `saveMappings` already required every `requiredFields`; data-dependent prerequisites are **warnings only**. |
| 3.3 | Provider capability | Start-sync did not check the provider's `READ` feature (engine failed later). | L | Checked in preflight. |
| 3.4 | Reconciliation | A linked record that the ERP **does** return but whose mapping fails (e.g. bad number) was reported `MISSING_IN_ERP` ("the ERP no longer returns it") — a false statement. **Reproduced by a failing test.** | M | Its id is now "seen"; an unreadable key makes absence unprovable (`complete=false`, `unidentifiedRecords`). |
| 3.5 | Reconciliation (rest) | Bounded reads (50 pages / 5 000 records / 200 items), tenant isolation (foreign connection → null/404, no ERP call), no business writes (only `reconcile_*` columns + one audit event), correlation id in result and audit, bounded fetch retry. | — | Verified by tests; unchanged. |
| 3.6 | Echo / idempotency | Phase 18 controls re-read in `syncEngine.js`. | — | Unchanged; suites pass. |
| 3.7 | Document store | `ingest()` already refuses without store/scanner and `readiness()` is never ready. But a throwing scanner or store propagated **raw adapter errors** (may contain paths/secrets) and readiness reported no decision list. | M | Fail closed with fixed, redacted `CONNECTION_ERROR` (`stage` SCAN/STORE); readiness returns `status: BUSINESS_DECISION_REQUIRED` and `requiredDecisions`. The module still never touches `./uploads` (tested). |
| 3.8 | Decisions | No single place listed the open business decisions; only ownership/direction has persistence. | M | `erpDecisionRegister.service.js` + `PHASE19_DECISION_REGISTER.md`; exposed in `overview().decisionRegister`. Ownership = `CONFIGURED` (never "approved"); everything else `REQUIRED`. |
| 3.9 | Test failures | See `PHASE19_DELIVERABLES.md` §8. 12× `fefo-expiry-phase6`: tests seed expiry relative to a pinned `NOW` (2026-09-24) but production allocation reads the real clock → "+15 day" batches are now genuinely expired → FEFO correctly skips them. 1× `inventory-phase5` ledger: seeds rows at real time and filters by `new Date().toISOString()` date → fails only if a run straddles 00:00 UTC. **Reproduced.** Neither is a production bug. | — | Deterministic clock (Date only) in the tests. No production change. |
| 3.10 | Latent date risks | Other tests hard-code `2027-01-01` (`inventory.service`, `admin-masters-phase7`, `inventory-phase5` MFG_IN_FUTURE) and will start failing on/after **2027-01-01**. | L | **Not changed**; documented. |
| 3.11 | Security | RBAC matrix, SSRF policy, redaction, rate limiting, audit immutability, scheduler reliability: Phase 17 suites unchanged and green. | — | No change; no check removed. |

## 4. Not changed (verified safe)
`erpOwnership.service.js`, RBAC (`config/erpPermissions.js`, `middleware/erpAccess.js`), authentication, tenant isolation, SSRF/URL policy, redaction, scheduler, `sapProvider.js`, `odataClient.js`, `genericRestProvider.js`, inventory / accounting / payments services, FEFO, claims, schemes, `middleware/upload.js`, all migrations. **No migration was added.** The frontend source is byte-identical to the Phase 18 upload.
