# Phase 10 — Scheme Engine: Deliverables

## 1. Summary
Admin-only Scheme Master (`/admin/masters/schemes`), a single backend evaluation service, read-only Distributor visibility, and an informational scheme result on the Admin order preview. No Retailer login/portal/JWT added. Prices, tax, totals, FEFO, inventory and invoices are unchanged.

## 2. Frontend (new unless noted)
- features/schemes/api/schemesApi.js
- features/schemes/pages/SchemesPage.jsx, SchemeFormPage.jsx, SchemeDetailPage.jsx
- features/schemes/components/SchemeStatusDialog.jsx, CheckList.jsx
- App.jsx (modified: 4 routes), config/adminNavigation.js (modified: Scheme Master live), components/ui/statusConfig.js (modified: `scheme` status domain)

## 3. Backend
- models/scheme.model.js (new), models/index.js (modified: registration)
- services/schemes.service.js (admin validation/CRUD/list), services/schemeEngine.service.js (evaluation)
- controllers/admin.schemes.controller.js, controllers/scheme.controller.js (distributor, read-only)
- routes/adminRoutes.js, routes/allRoutes.js (modified)
- services/adminSalesOrder.service.js (modified: informational `scheme` per preview line, never blocks preview)
- tests/schemes-phase10.test.js, docs/PHARMA_DMS_SCHEME_ENGINE.md

## 4. Migration
`20261003090000-scheme-engine-phase10.js` — creates Schemes, SchemeProducts, SchemeDistributors, SchemeRetailers. Additive, idempotent, reversible (verified up → up → down → up).

## 5. API
Admin (requireAdmin): GET /api/admin/schemes, /lookups, /:id; POST /api/admin/schemes; PUT /:id; POST /:id/status; POST /evaluate.
Distributor (existing auth, read-only): GET /api/schemes/applicable; POST /api/schemes/evaluate.

## 6. Calculation service
See docs/PHARMA_DMS_SCHEME_ENGINE.md. Types: QUANTITY_FREE, PERCENT_DISCOUNT, FIXED_DISCOUNT. Lowest priority number wins; equal top priority = conflict, nothing applied; no stacking. Purchased / free / total quantity kept separate.

## 7. Sales integration
Admin order preview returns `lines[].scheme`. Nothing is persisted, no stock deducted for free goods.

## 8. Authorization
All admin routes behind requireAdmin (asserted in tests). Distributor identity is always the session user; body/query distributor ids are ignored; distributor controller exports only two read handlers.

## 9. Test results
Backend: 260 / 261 pass (27 new Phase 10 tests, all pass). The 1 failure (`fefo-expiry-phase6` tenant isolation / fefo.priority) fails identically on the unmodified Phase 9 code — pre-existing, not touched.
Frontend: no test suite exists in the project.

## 10. Build / lint
`vite build` succeeds. ESLint is clean on all Phase 10 files; `eslint .` on the whole project reports 43 pre-existing problems in other files. No Phase 10 file is among them.

## 11. Known limitations
- No inventory/batch deduction for free goods; scheme result is advisory until order/invoice persistence stores a snapshot (scheme id, code, benefit) so edits never alter history.
- No audit-log table exists; changes are written to the server log (admin id, changed fields) and stored as created_by / updated_by / status_changed_at.
- Not implemented: cross-product free goods (Buy A get B), territory applicability, slab/value schemes, stacking.
- Type and code are immutable after creation; schemes are deactivated, never deleted.
- Frontend screens were verified by build/lint only, not exercised in a browser.

## 12. Manual testing
1. Run the migration; log in as Admin → Masters → Scheme Master.
2. Add "Buy 10 Get 1" for a product; confirm duplicate code, bad dates, zero quantity are rejected.
3. Use filters (type, validity, product, distributor), sort and pagination.
4. Deactivate/activate from the list and detail page.
5. Admin → Sales → new order preview with 9 vs 10 vs 20 units: totals unchanged, `scheme` shows 0 / 1 / 2 free.
6. As a Distributor call GET /api/schemes/applicable: only your products' schemes appear; /api/admin/schemes is rejected.

## 13. Phase 8 / Phase 9
Distributor and Retailer code is untouched; their existing tests all still pass.
