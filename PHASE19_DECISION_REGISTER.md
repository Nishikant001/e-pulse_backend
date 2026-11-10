# PHASE 19 — Business Decision Register (for review)

**Status key.** `REQUIRED` = the business has not answered and the system has no way to record an answer. `CONFIGURED` = an administrator set an *ownership / direction* on an ERP connection; the system **cannot confirm business approval**, and configuration alone does not unblock anything the code does not implement.
**Nothing in this register is approved. No answer has been invented.** The "interim behaviour" column is a safeguard of the current code, not a decision.
The same register is returned live by `GET /api/admin/erp-sync/business/overview` → `decisionRegister` (code: `services/erpDecisionRegister.service.js`).

Persistence available today: only `erp_connection_capabilities.ownership` / `.direction`. Every other row below needs a decision **and** a place to record it before it can be anything but REQUIRED.

## Stock — capability PARTIAL
| ID | Question | Status | Interim (current safe behaviour) | Blocks |
|---|---|---|---|---|
| stock.owner | Who owns stock quantities? | REQUIRED / CONFIGURED per connection | Sync refuses while unset (BUSINESS_DECISION_REQUIRED) | STOCK |
| stock.openingSnapshot | How does an ERP opening snapshot interact with existing DMS stock? | REQUIRED | First snapshot over existing stock refused per record; reconciliation shows PENDING_REVIEW; no baseline-acceptance workflow | STOCK |
| stock.batchCreation | Can ERP data create batches (expiry, MRP)? | REQUIRED | Never; unknown batch fails the record | STOCK |
| stock.warehouseMappingOwner | Who owns plant→warehouse (and batch) mappings? | REQUIRED | Admin-entered code mappings; unmapped/ambiguous never guessed | STOCK |

## Sales — capability PARTIAL
| ID | Question | Status | Interim (current safe behaviour) | Blocks |
|---|---|---|---|---|
| sales.owner | ERP or DMS authoritative for orders? | REQUIRED / CONFIGURED | Sync refuses while unset | SALES |
| sales.autoConfirm | May an ERP order ever be auto-confirmed? | REQUIRED | Never; imports are DRAFT with DMS pricing/schemes/GST | SALES |
| sales.dmsOrderRepresentation | How is a DMS order represented in the ERP? | REQUIRED | Outbound sales not implemented | SALES |

## Invoice — capability BLOCKED
| ID | Question | Status | Interim | Blocks |
|---|---|---|---|---|
| invoice.owner | Who owns invoice creation? | REQUIRED / CONFIGURED | Nothing imports whatever the ownership | INVOICE, RETURN |
| invoice.erpAuthoritative | Is an ERP invoice authoritative? | REQUIRED | DMS computes number, date (=now), prices (order line), tax (HSN); ERP figures cannot be stored | INVOICE, RETURN |
| invoice.deliveryMapping | How does an ERP invoice map to a DMS delivery (one delivery per invoice; delivery moves stock OUT)? | REQUIRED | No rule; creating deliveries would decrease stock twice if ERP owns stock | INVOICE, RETURN |
| invoice.accountingReceivables | How are journals and receivables created (skip vs. run `salesinvoice.post` once)? | REQUIRED | Nothing posts | INVOICE, RETURN |
| invoice.existingInvoice | What if the invoice already exists in the DMS (adopt / compare / refuse)? | REQUIRED | No rule | INVOICE |
| invoice.duplicatePrevention | Which stable ERP field is the external invoice identity? | REQUIRED | Columns + UNIQUE index exist; create path has no input; nothing writes them | INVOICE |

## Return — capability BLOCKED (depends on Invoice)
| ID | Question | Status | Interim (current safe behaviour) | Blocks |
|---|---|---|---|---|
| return.owner | Who owns returns? | REQUIRED / CONFIGURED | Nothing imports | RETURN |
| return.invoiceDeliveryReference | How must a return reference original invoice, delivery, invoice line, batch? | REQUIRED | Existing DMS rule: POSTED invoice + invoiceLineId + batchId, quantity ≤ returnable | RETURN |
| return.creditNote | How are credit notes created? | REQUIRED | `salesreturn.post` posts credit note + accounting atomically with stock IN | RETURN |
| return.stockPosting | How is returned stock posted, esp. if the ERP also owns stock? | REQUIRED | Stock IN via `inventory.postMovement`; risk of counting the same return twice | RETURN |
| return.originalMissing | What if the original invoice cannot be found? | REQUIRED | Refuse; no orphan return is ever created | RETURN |

## Payment and pricing — capabilities COMPLETE within stated limits
| ID | Question | Status | Interim (current safe behaviour) | Blocks |
|---|---|---|---|---|
| payment.autoAllocate | Auto-allocate ERP payments to invoices? | REQUIRED | No — booked unallocated | PAYMENT |
| pricing.manualOwner | Who owns manually entered prices? | REQUIRED | Sync never overwrites a row it did not create | PRICING |

## Documents — capability BLOCKED
| ID | Question | Status | Interim (current safe behaviour) | Blocks |
|---|---|---|---|---|
| document.storageProvider | Which tenant-isolated storage provider is approved? | REQUIRED | None registered; `ingest()` refuses; local `./uploads` never used | DOCUMENT |
| document.malwareScanner | Which malware scanner is approved? | REQUIRED | None registered; `ingest()` refuses | DOCUMENT |
| document.accessRetention | Which access-control and retention rules apply? | REQUIRED | No document record, route, permission or policy exists | DOCUMENT |

## What each answer unlocks (so reviewers can see the cost)
* **Invoice** — needs answers to all six rows **and** a code change to the invoice create path (external-id input, and either figure-carrying or a "reconcile-only" decision). Recommended safest first step if the ERP books accounting: *read-only invoice reconciliation* (link ERP↔DMS invoice, compare totals, write nothing). That is **not implemented** and not claimed.
* **Return** — only after Invoice; reuse `salesreturn.create/post` through the same controller path; never write StockLedger.
* **Documents** — approve a store and a scanner, add a document table with external id, an authorised download route, audit events and a retention policy; only then can `readiness().ready` become true.
