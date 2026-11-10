# PHASE 19 — Invoice/Return architecture, business decisions & production-integration validation

**Outcome in one line:** the preflight, reconciliation and document-store gaps are closed and tested; the 12 date-dependent test failures are explained and fixed in the tests only; **Invoice, Return and Document sync remain BLOCKED** (nothing was built that would require inventing a business decision); **no real ERP was reached**, so real verification is `NOT RUN`.

## 1. Audit findings
See `PHASE19_AUDIT.md`. Highlights: (a) reconciliation could say "the ERP no longer returns this record" for a record it still returns; (b) sync preflight accepted stale mappings that then failed every record; (c) a throwing scanner/store leaked raw adapter errors; (d) Invoice/Return cannot be imported safely with the existing controllers (details §3–4).

## 2. Business decision register
`PHASE19_DECISION_REGISTER.md` (23 questions across Stock, Sales, Invoice, Return, Payment/Pricing, Documents) and live in code: `services/erpDecisionRegister.service.js`, returned by `GET /api/admin/erp-sync/business/overview` as `decisionRegister` (no new route). Only ownership/direction has persistence; it is shown as **CONFIGURED** (explicitly *not* business approval). Everything else is **REQUIRED**. Nothing was approved, defaulted or inferred. Tests pin this.

## 3. Invoice architecture and status — **BLOCKED**
Design path (when approved) must go through `salesinvoice.create` → `salesinvoice.post` (via the existing `invokeAsDistributor` pattern used by `adminSalesOrder`), never insert invoices or journals directly and never add a second accounting engine. Exact missing dependencies, from the code:
1. Ownership/authority undecided.
2. `create` numbers the invoice itself, dates it *now*, recomputes prices from the order line and tax from the product HSN → ERP number/date/prices/taxes/totals cannot be stored; **either** add figure-carrying (needs a code change to a posted-accounting path) **or** decide to accept DMS figures and only reconcile.
3. An invoice needs one delivery, and a delivery moves stock OUT → double stock decrease if the ERP also owns stock.
4. Accounting/receivables rule undecided (skip vs. run `post` exactly once).
5. No existing-invoice rule; no external-id input on the create path (columns + UNIQUE index exist since Phase 18, unused).
Safest first step *if the ERP books accounting*: read-only invoice reconciliation. **Not implemented, not claimed.** Preflight/sync/outbound for INVOICE return 409 with these reasons; no job, ERP call, invoice, journal or stock change (tested, even with `ERP_OWNED`).

## 4. Return architecture and status — **BLOCKED** (depends on Invoice)
Reuse `salesreturn.create/post` (POSTED invoice + invoiceLineId + batchId, quantity ≤ returnable; post = stock IN via `inventory.postMovement` + credit note + accounting in one transaction). Needs: Invoice resolved, return ownership, original-invoice-not-found rule (refuse; no orphan), partial-return mapping (ERP line → invoice line), batch mapping, duplicate rule on a new external-id input, stock-posting rule when ERP owns stock. Never write StockLedger directly (source-level test added). Nothing creates returns, credit notes or stock movements.

## 5. Mapping preflight changes
New `services/erp/sync/mappingPreflight.js`, used by `erpSync.preflight` (manual start, retry, scheduler) and `erpBusiness.overview` (same evaluator).
* **Blockers** (409 `MAPPING_NOT_CONFIGURED`, `details.blockers[] = {code, rule, field, message}`, no job, no ERP call): `KEY_MISSING`, `KEY_SOURCE_EMPTY`, `SOURCE_EMPTY`, `FIELD_NOT_WRITABLE` (stale), `REQUIRED_FIELD_UNMAPPED` (per target schema), `PAYMENT_MODE_UNDEFINED` (no mapped mode and no default), `PAYMENT_TERMS_UNDEFINED` (SALES, same logic).
* **Warnings** (never block; returned by `preflight()` and `details.warnings`): product / customer not yet synchronised, no plant→warehouse mapping, no DMS batches, no payment-mode code mapping.
* Also: provider must have `READ`. Ownership, endpoint, provider status, scope validation were already enforced and keep their order and wording ("no key" message unchanged and still first).
* **Compatibility:** all 374 pre-existing ERP tests pass unchanged; `saveMappings` already required every `requiredFields`, so only stale/hand-edited sets are newly refused. Data-dependent prerequisites stay non-blocking so an ordered Product→Pricing schedule keeps working. No default is invented anywhere.
* Not done: a standalone read-only "preflight" HTTP route (would change the Phase 14 route count and RBAC matrix tests); the dashboard shows the blockers through the overview instead. Frontend not modified.

## 6. Document readiness
`erpDocumentStore.service.js`: fail closed — scanner or store exceptions → `CONNECTION_ERROR` (`stage` SCAN/STORE, fixed message, redacted internal detail), nothing stored; any scanner verdict other than exactly `{clean:true}` rejects; `readiness()` now returns `status: "BUSINESS_DECISION_REQUIRED"` and `requiredDecisions` (storage provider, scanner, access/retention). Registering an adapter in code is reported as `TECHNICALLY_REGISTERED`, never as approved; `ready` stays false (no document record, authorisation, audit, retention). Ingestion without store/scanner → `BUSINESS_DECISION_REQUIRED`. The module never uses `./uploads` (source test). **Document sync not activated, not claimed.**

## 7. Provider verification status
SAP OData: mock verified, **real NOT RUN**. Generic REST: mock verified, **real NOT RUN**. Oracle REST, Dynamics REST, Generic SOAP: **UNSUPPORTED** (no adapter). No credentials/staging access exist here. Repeatable 10-step procedure with an evidence record: `docs/ERP_REAL_VERIFICATION_CHECKLIST.md` (all steps `NOT RUN`; writes only to an authorised test ERP).

## 8. Test-failure investigation
Baseline 2026-10-10: **726 tests, 714 passed, 12 failed** — all `fefo-expiry-phase6`.
* **fefo-expiry-phase6 (12):** the suite seeds expiry dates relative to a pinned `NOW = 2026-09-24` but production code (`inventory.allocateStock`, `previewFefoAllocation`, delivery, batch validation) reads the real clock. Batches seeded "+15 days" (2026-10-09) are now truly expired, so FEFO correctly skips them. Count rises as days pass (5 → 12). **Production behaviour is correct.** Fix: `jest.useFakeTimers({now: NOW, doNotFake: <everything except Date>})` for the file; no assertion edited, no production code changed.
* **inventory-phase5 "Stock Ledger › entries…" (1):** did **not** fail in this baseline (UTC 19:5x on Oct 9). Cause reproduced: the test seeds rows at real time and filters by `new Date().toISOString().slice(0,10)`; the ledger filter is UTC (`dayStart`), so a run that crosses 00:00 UTC (05:30 IST) sees different dates (reproduced by starting a clock 300 ms before midnight: expected 7, received 0). I cannot prove that this is what the Phase 18 observation hit, but it is the only mechanism found. Fix: freeze `Date` in that describe only. **No inventory logic changed.**
* **Latent (not changed):** tests pinning `2027-01-01` (`inventory.service`, `admin-masters-phase7`, `inventory-phase5` MFG_IN_FUTURE) will fail on/after 2027-01-01.

## 9. Database changes
**None.** No migration added; no model changed. (MySQL not available here; nothing to verify, and Phase 18's migration remains *not verified against MySQL*.)

## 10. Tests and exact results
Clean single process `npx jest --runInBand`, 2026-10-10 IST:
* Baseline (Phase 18 code): 726 tests — 714 passed, 12 failed.
* Final: **22 suites, 753 tests, 753 passed, 0 failed** (726 + 27 new).
* New `tests/erp-phase19.test.js` (27): mapping preflight (pure rules, every target compat, stale mapping, key precedence, PAYMENT mode, SALES terms, warnings not blockers, overview consistency); reconciliation (false-MISSING_IN_ERP reproduction/fix, no business writes, bounded + correlation id, tenant isolation); document store (fail-closed ×4, validation, traversal, tenant keys, duplicates, no `./uploads`); decision register (coverage, REQUIRED-by-default, CONFIGURED≠approved, tenant scope); Invoice/Return blocked with exact reasons, no direct ledger/journal/invoice writes in ERP code, DMS invoice/return controllers untouched.
* Existing assertions: **none weakened or removed.** Two suites got a frozen Date only. (A first draft of the Return reason text broke an existing Phase 16 assertion; the production text was adjusted instead of the test.)

## 11. Build / lint
Frontend (unchanged, byte-identical to Phase 18 upload): `npm run build` succeeded; `eslint src/features/erpIntegration` clean. Project-wide `npm run lint` reports 33 errors / 10 warnings in unrelated, pre-existing files (e.g. `components/Distributers/**`, `adminSales/sample/**`); not touched. No backend lint config exists.

## 12. Security regression
Phase 17 suites (`erp-security`, `erp-reliability`) pass unchanged: ERP-scoped RBAC matrix, tenant isolation, SSRF/URL policy, redaction, rate limiting, audit immutability, scheduler. No check removed. New: foreign-tenant reconciliation → null/404 with no ERP call; register tenant-scoped; document errors secret-free; correlation id verified in reconciliation audit.

## 13. Files
**Created:** `services/erp/sync/mappingPreflight.js`, `services/erpDecisionRegister.service.js`, `tests/erp-phase19.test.js`, `docs/ERP_REAL_VERIFICATION_CHECKLIST.md`, `PHASE19_AUDIT.md`, `PHASE19_DECISION_REGISTER.md`, `PHASE19_DELIVERABLES.md`.
**Modified:** `services/erpSync.service.js` (preflight), `services/erpBusiness.service.js` (shared evaluator, decision register), `services/erpReconciliation.service.js` (missing-record fix), `services/erpDocumentStore.service.js` (fail closed, decisions), `services/erp/sync/targets.js` (Invoice/Return reason text only), `tests/fefo-expiry-phase6.test.js`, `tests/inventory-phase5.test.js` (frozen clock).
**Frontend:** none.

## 14. Remaining blockers
Invoice, Return, Document sync (all decisions in the register); stock baseline-acceptance workflow and batch creation; DMS→ERP sales; payment allocation; manual-price ownership; real SAP/REST verification; Oracle/Dynamics/SOAP adapters; MySQL verification of the Phase 18 migration; UI for the decision register and preflight blockers (API only); per-process rate limiter (Phase 17); the 2027-01-01 test clock risk.

## 15. Production acceptance checklist (a capability is COMPLETE only if all are true)
- [ ] Ownership and direction **approved by the business** (the system records configuration, not approval).
- [ ] Mapping preflight returns no blockers; warnings reviewed.
- [ ] Provider supports the operations **and** has real-ERP evidence (checklist steps 1–10 PASS, signed).
- [ ] Only existing DMS services used (inventory / accounting / payments); no direct ledger or journal writes.
- [ ] External identity + idempotency implemented; idempotent re-run proven on the real ERP.
- [ ] Tenant isolation, failure recovery and retry tested.
- [ ] Accounting / inventory effects verified (no double stock, no duplicate journals/receivables).
- [ ] Reconciliation shows MATCHED for a bounded sample; differences understood and never auto-fixed on posted transactions.
- [ ] Migrations (if any) verified up/up/down/down/up **on MySQL**.
- [ ] Full suite green on a clean single-process run; limitations disclosed.

Today: Product, Customer, Distributor, Pricing, Payment — COMPLETE *in code and mock tests only*; Stock, Sales — PARTIAL; Invoice, Return, Document — BLOCKED. None is production-verified.
