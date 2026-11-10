# PHASE 02 — CHANGED FILES

Frontend only. **Backend: no file changed** (the backend ZIP is the Phase 1 source plus `docs/phase02/`). Paths are relative to the frontend project root.

| File | Change | Why |
|---|---|---|
| `src/config/adminNavigation.js` | Rewritten as a **self-contained** Admin menu (no longer derived from the Distributor model). Removed entries are deleted, not flagged. `customer-master` is now live at `/admin/masters/customers`. | Source of truth for Admin sidebar, mobile drawer, global search, breadcrumbs. Deleting (not hiding) means the "Show planned modules" toggle cannot restore anything. |
| `src/config/navigation.js` | Distributor model: removed FEFO Monitor, Masters group, Schemes & Claims group, Financial View group, Vendor Ledger, Secondary Sales (Sales + Reports), Notifications, Audit Logs. Also dropped the Admin-only `distributor-management` and `sap` groups that the portal previously filtered out. | Distributor sidebar / search / breadcrumbs. |
| `src/config/portals.js` | Distributor portal uses the model directly (filter removed); Admin portal no longer defines `sapStatus`. | No hidden filtering; no ERP/SAP header badge for Admin. |
| `src/config/pageInfo.js` | Removed help text for removed routes; added help for `/admin/masters/customers/*`; reworded Dashboard and Payments hints. | No stale help for pages that no longer exist. |
| `src/PrivateApp.jsx` | Removed routes + lazy imports: Admin `sales/orders/new`, `sales/orders/:id/edit`, `sales/secondary`, `retailers*`, `sap/*`; Distributor `inventory/fefo`, all Masters routes, `claims*`, `finance*`, `accounts/VendorLedger`. Added Admin `masters/customers*`. Added a `*` route in `/dashboard` rendering `DistributorNotFound`. | Direct-URL blocking: removed Admin paths fall to the existing `AdminNotFound`; removed Distributor paths render the new not-found view inside the shell. |
| `src/components/Distributers/dashboard/DistributorNotFound.jsx` | **New.** | Distributor equivalent of `AdminNotFound` (there was no catch-all under `/dashboard`). |
| `src/components/Distributers/dashboard/accounts/Payments.jsx` | Removed the "Pay Vendor" tab, vendor state, vendor fetch and `POST /payment/vendor` call. Customer receipts unchanged. Fixed the unused imports/state and the hook-dependency warning in this file. | Requirement B.2 (vendor payment UI). |
| `src/components/Distributers/dashboard/pages/Dashboard.jsx` | Removed the Add Customer / Manage Stock / Add Vendor quick actions. "New Order" kept. | They linked to Masters routes that are now blocked (dead links). |
| `src/components/layout/Header.jsx` | SAP status chip rendered only when the portal defines `sapStatus`. | Hides the ERP/SAP badge in the Admin header. |
| `src/features/adminDashboard/AdminDashboardPage.jsx` | Removed `SapStatusCard`; Near Expiry card is full width; subtitle no longer mentions integration health. | Requirement: remove Admin dashboard SAP/ERP status cards. |
| `src/features/adminSales/orders/SalesOrdersPage.jsx` | Removed "New order" button and the row "Edit" action. | Sales Creation entry points. |
| `src/features/adminSales/orders/OrderDrawer.jsx` | Removed the "Edit" button. | Same. |
| `src/features/retailers/api/retailersApi.js` | Admin base → `/admin/masters/customers`; added `noun` and `retailerLabels()`; `api.noun`. API calls/URLs to the backend unchanged. | Customer Master wording and route. |
| `src/features/retailers/pages/RetailersPage.jsx`, `RetailerDetailPage.jsx`, `RetailerFormPage.jsx`, `components/RetailerDialogs.jsx` | Visible labels use "Customer" in the Admin portal, "Retailer" in the Distributor portal. In the form, the link to the Distributor-portal customer-group page (now blocked) became plain text. | Customer Master consistency; no dead link. |
| `vite.config.js` | `import process from 'node:process'`. | Fixes the Phase 1 `no-undef` lint error. |
| `src/testing/viteLoader.mjs` | **New** test helper (Vite SSR loader). | Lets `node --test` load JSX, the real route table and configs. |
| `src/config/navigation.test.mjs` | **New** — 21 tests. | Navigation regression. |
| `src/routes/routeGuards.test.mjs` | **New** — 107 tests. | Route / dead-link / import regression. |
| `src/features/sharedPortals.test.mjs` | **New** — 6 tests. | Shared-component behaviour in both portals. |
| `docs/phase02/*` | **New** — the four Phase 2 reports. | Deliverable. |

## Intentionally NOT changed
Backend (all of it); `features/accounts/*`, `features/claims/*`, `features/inventory/*` (shared); ERP source files (`features/erpIntegration/*`, `SapStatusCard.jsx`, `SapStatusIndicator.jsx`); `CreateSalesOrderPage.jsx`, `SecondarySalesPage.jsx`, `ClaimFormPage.jsx` and all Distributor Masters pages (kept on disk, just not routed); database, migrations, schedulers, secrets.
