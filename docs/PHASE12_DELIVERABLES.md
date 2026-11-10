# Phase 12 — Deliverables
See `PHARMA_DMS_ACCOUNTS.md` for design details.

**Backend new:** models/payment.model.js · services/receivables.service.js · services/payments.service.js · controllers/admin.accounts.controller.js · controllers/accounts.controller.js · migrations/20261005090000-accounts-phase12.js · tests/accounts-phase12.test.js · docs/PHARMA_DMS_ACCOUNTS.md
**Backend modified:** services/accounting.service.js (settleClaim, ensureGL, parsePaymentTermsToDays) · services/claims.service.js (approve→settle, `settle`, financialStatus) · controllers/admin.claims.controller.js · controllers/salescreditnote.controller.js (refresh invoice balance) · models/{index,customer,claim}.model.js · routes/{adminRoutes,allRoutes}.js · tests/claims-phase11.test.js (2 assertions updated: approval now posts a settlement; 8th admin claims route)
**Frontend new:** features/accounts/{api,components,pages}/* (Dashboard, Outstanding, Ageing, Ledger, Payments + RecordPaymentModal, Credit)
**Frontend modified:** App.jsx · config/navigation.js · config/adminNavigation.js · features/claims/pages/ClaimDetailPage.jsx · features/claims/api/claimsApi.js

**Tests:** backend 351/352 pass — 66 new Phase 12 tests all pass; the 1 failure is the pre-existing `fefo-expiry-phase6` tenant-isolation test (same as Phases 9–11, unrelated). Frontend: no test suite exists.
**Build/lint:** `vite build` OK; ESLint clean on all changed/new frontend files. Backend has no ESLint config.
**Migration:** up → up → down → up verified (sqlite, in test). Not run against MySQL.
