# Phase 3 (first slice) — Changed files

## Backend
New
- controllers/admin.purchaseorders.controller.js — read-only Admin PO handlers
- controllers/report.controller.js — Distributor reports (GET only)
- controllers/settings.controller.js — Distributor settings
- migrations/20261013090000-po-optional-vendor-phase1.js
- services/adminPurchaseOrders.service.js
- services/distributorReports.service.js
- tests/epulse-phase1-po.test.js, tests/epulse-phase1-reports.test.js, tests/epulse-phase1-settings.test.js
Changed
- controllers/purchaseorder.controller.js — vendor optional; `vendor.state` → `region` fix
- controllers/purchaseinvoice.controller.js — invoicing a vendor-less PO is blocked with a clear 400
- models/purchaseorderheader.model.js — `vendorId` allowNull
- routes/adminRoutes.js — 3 GET routes under /purchase-orders
- routes/allRoutes.js — GET /reports, GET /reports/:section, GET/PUT /settings…, POST /settings/change-password

## Frontend
New
- src/features/reports/{api/reportsApi.js, pages/DistributorReportPage.jsx}
- src/features/settings/pages/DistributorSettingsPage.jsx
- src/features/adminPurchaseOrders/{api/purchaseOrdersApi.js, pages/AdminPurchaseOrdersPage.jsx, pages/AdminPurchaseOrderDetailPage.jsx}
- src/features/epulsePhase1.test.mjs
Changed
- src/config/navigation.js (Customers, 9 Reports, Settings), src/config/adminNavigation.js (Purchase Orders), src/config/pageInfo.js
- src/PrivateApp.jsx (routes + retailers→customers redirect)
- src/components/Distributers/dashboard/pages/Po.jsx (no vendor field)
- src/components/layout/useBreadcrumbs.js (detail crumbs for top-level links)
- src/features/retailers/{api/retailersApi.js, components/RetailerDialogs.jsx, pages/RetailersPage.jsx, pages/RetailerDetailPage.jsx, pages/RetailerFormPage.jsx} (Customers wording / base path)
- src/config/navigation.test.mjs, src/features/sharedPortals.test.mjs (updated to the new behaviour)
