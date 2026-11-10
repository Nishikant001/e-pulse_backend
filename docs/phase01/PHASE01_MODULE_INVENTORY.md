# PHASE 01 — MODULE INVENTORY

Status vocabulary: **Implemented** (route + API + logic + DB all traced), **Partial**, **Missing**, **Broken**, **Planned** (sidebar placeholder only, no route), **Requires Verification** (needs runtime/DB check).
"Nav state" comes from evaluating the real `src/config/adminNavigation.js` and `src/config/portals.js` (bundled and executed during the audit), not from reading the code by eye.
Sidebar note: planned items are hidden by default (`showPlanned` defaults to `false`, key `dms.sidebar.showPlanned`) but a user toggle reveals them, so "planned" ≠ removed from configuration.
Test coverage column: ✔ = backend Jest suite exists for the area (all 30 suites passed, §PHASE01_TEST_RESULTS); frontend has only unit tests for helpers (48 pass), **no component/route tests anywhere**.

All paths are relative to `secondary_frontend_phase24/` (FE) or `secondary_backend_phase24/` (BE).

---

## 1. Admin Portal (`/admin/*`, API `/api/admin/*`, auth `requireAdmin`)

Common: layout `src/features/adminAuth/AdminLayout.jsx`, guard `AdminGuard.jsx`, login `/admin/login`. Write routes carry **no role check** (finding S1) except ERP.

| Sidebar item | Nav state | FE page / route | API (BE) | Models | Tests | Status | Requirement | Intended action / phase |
|---|---|---|---|---|---|---|---|---|
| Dashboard | LIVE `/admin/dashboard` | `features/adminDashboard/AdminDashboardPage.jsx` | `GET /api/admin/dashboard/summary` (`controllers/admin.dashboard.controller.js`, `services/adminDashboard.service.js`) | Orders, Invoices, Batches, Journal… | ✔ | Implemented (Live). Has Sample switch; includes ERP/SAP card and distributor widgets | A7 (SAP card), A8 | P2: remove SAP card; review sample switch |
| Super Admin | LIVE `/admin/super-admin` role-gated | `features/superAdmin/pages/SuperAdminDashboardPage.jsx` | `GET /api/admin/superadmin/overview`, `GET /api/admin/superadmin/admins/:id/distributors` (`requireSuperAdmin`) | AdminUser, Distributor, Customer | ✔ (`superadmin-phase25.test.js`) | Implemented (see §3) | C | P6 |
| Sales › Sales Orders | LIVE `/admin/sales/orders` | `features/adminSales/orders/SalesOrdersPage.jsx`, `OrderDrawer.jsx` | `GET/POST/PUT /api/admin/sales/orders…`, `/preview`, `/:id/confirm`, `/:id/cancel`, `/:id/create-invoice` (`admin.sales.controller.js`) | SalesOrderHeader/Line | ✔ | Implemented | A1 | P2: hide list entry points that create; P3: **block writes in BE** |
| Sales › (Create/Edit order, not in sidebar) | routed `/admin/sales/orders/new`, `/:id/edit` | `orders/CreateSalesOrderPage.jsx` | `POST /api/admin/sales/orders`, `PUT …/:id` | same | ✔ | Implemented | A1 "Remove Sales Creation" | P2 remove routes; P3 403 on write endpoints |
| Sales › Sales Invoices | LIVE `/admin/sales/invoices` | `invoices/SalesInvoicesPage.jsx`, `InvoiceDrawer.jsx` | `GET /api/admin/sales/invoices[/:id]`, `POST …/:id/post`, `…/:id/cancel` | SalesInvoiceHeader/Line, SapSyncRecord | ✔ | Implemented (read + post/cancel) | not named in A1 | Decision: are post/cancel in "sales creation"? |
| Sales › Secondary Sales | LIVE `/admin/sales/secondary` | `secondary/SecondarySalesPage.jsx` | `GET /api/admin/sales/secondary[/summary|/:key]` | derived from orders/invoices | ✔ | Implemented (derived view) | A8 "remove Secondary Sales features" (stated for Reports; also in A10 list) | P2: decide scope |
| Sales › Sales Returns | PLANNED | none | **none under `/api/admin`** (Distributor `…/sales-return` exists) | SalesReturn, SalesReturnLine | ✔ (distributor side) | **Missing in Admin** | A2 view-only | P3: build read-only GET endpoints + page; no write endpoint |
| Sales › Credit Notes | PLANNED | none | none under `/api/admin` | SalesCreditNote(+Line) | ✔ (distributor side) | **Missing in Admin** | A3 preserve | Decision needed (§Audit 8.2) |
| Inventory › Current/Batch Stock, Stock Ledger, Near Expiry, Expired, FEFO Monitor | LIVE `/admin/inventory/{current,batch,ledger,near-expiry,expired,fefo}` | `features/inventory/pages/*` (`portal="admin"`) | `GET /api/admin/inventory/{lookups,summary,current,batches,batches/:id,ledger,movement,transfers,expiry-summary,fefo-preview}` (`admin.inventory.controller.js` → `inventory.service`) | Batch, StockLedger, Warehouse, StockTransfer | ✔ | Implemented (read-only) | not in A | Keep |
| Inventory › Stock Transfer | PLANNED | none (action lives on batch rows) | Distributor `POST /api/inventory/transfers` | StockTransfer | ✔ | Planned | – | Keep hidden |
| Masters › Product / Batch / Pricing / Tax | LIVE `/admin/masters/{products,batches,pricing,taxes}` (+ detail routes) | `features/adminMasters/pages/*` | `GET/POST/PUT /api/admin/masters/{products,batches,pricing,taxes}…`, deactivate/reactivate (`admin.masters.controller.js`) | Product, Batch, PricingMaster, HSNGroup | ✔ | Implemented (cross-distributor writes!) | – | Keep; add RBAC in P3/P4 |
| Masters › Scheme Master | LIVE `/admin/masters/schemes` (+new/:id/edit) | `features/schemes/pages/*` | `/api/admin/schemes…` (`admin.schemes.controller.js`, `schemeEngine.service.js`) | Scheme, SchemeProduct/Distributor/Retailer | ✔ | Implemented | – | Keep |
| Masters › Distributor Master | PLANNED | none (live equivalent is Distributor List) | – | – | – | Planned | A4 hide | P2 remove from config |
| Masters › Retailer Master | PLANNED | none | – | – | – | Planned | A4 hide | P2 remove |
| Masters › Customer Master | **PLANNED (no route)** | none in Admin. Data is shown by Retailer List `/admin/retailers` | `/api/admin/retailers` (Customer table) | Customer, Address | ✔ | **Missing as "Customer Master" in Admin** | A5 "retain" | Decision: re-point to retailer pages renamed Customer Master (P2/P3) |
| Distributor Mgmt › Distributor List | LIVE `/admin/distributors` (+new,:id,:id/edit) | `features/adminDistributors/pages/*` | `GET/POST/PUT /api/admin/distributors…`, `/:id/status`, `/:id/retailers`, `/lookups` | Distributor | ✔ | Implemented. Create sets `created_by_admin_id`; **no login created** (password NULL) | A9/A10 | Keep |
| Distributor Mgmt › Performance, Credit Limit, Outstanding | PLANNED | none | – (credit/outstanding exist under Accounts) | – | – | Planned | A10 hide | P2 remove from config |
| Distributor Mgmt › Ledger | PLANNED | none (Accounts › Ledger has distributor mode `/admin/accounts/ledger`) | `GET /api/admin/accounts/ledger` | JournalEntry, GLMaster | ✔ | Partial (data exists elsewhere) | A9 add Ledger | P3: link/route |
| Distributor Mgmt › SAP Sync | **no item exists** | none | ERP/SAP code (`/api/admin/erp-*`, `SapSyncRecord`) | SapSyncRecord, Erp* | ✔ | Missing item; **conflicts with A7 (hide ERP)** | A9 vs A7 | Decision (§Audit 8.3) |
| Distributor Mgmt › Settings | **no item exists**; global Settings PLANNED | none | none | none | – | Missing | A9 | P3/P4: define Settings scope |
| Retailer Mgmt › Retailer List | LIVE `/admin/retailers` (+new,:id,:id/edit) | `features/retailers/pages/*` | `/api/admin/retailers…`, `/:id/assign` (only ownership-changing route) | Customer | ✔ | Implemented | A4/A5 | P2 hide group; keep API |
| Retailer Mgmt › Pharmacy, Hospital, Doctor/Clinic, License/Compliance | PLANNED | none | – | – | – | Planned | A4 hide | P2 remove |
| Schemes & Claims › Claims | LIVE `/admin/claims` (+/:id) | `features/claims/pages/*` | `/api/admin/claims…` review/approve/reject/needs-correction/settle | Claim, ClaimItem, ClaimStatusHistory, JournalEntry | ✔ | Implemented | A10 lists Claim Settlement/Credit Notes/Active Schemes/Scheme Calculation to hide | P2: hide planned siblings only |
| Schemes & Claims › Active Schemes, Scheme Calculation, Claim Settlement, Credit Notes | PLANNED | none | – | – | – | Planned | A10 | P2 remove |
| Accounts › Overview, Outstanding, Ageing, Ledger, Payments, Credit Limits | LIVE `/admin/accounts[/outstanding|/ageing|/ledger|/payments|/credit]` | `features/accounts/pages/*` (`portal="admin"`) | `/api/admin/accounts/{lookups,summary,outstanding,ageing,ledger,credit,open-invoices,payments}`; writes `POST /payments`, `PUT /credit/:entityId` | Payment, PaymentAllocation, JournalEntry, Customer | ✔ | Implemented, **retailer-keyed** (`entityType` RETAILER/DISTRIBUTOR; payment modal "Money received from a retailer") | A6 remove retailer options | P3: needs decision; high regression risk |
| ERP Integration (5 live + 6 planned) | LIVE `/admin/sap/{dashboard,connections,sync-history,errors,audit}` gated by `ERP_VIEW`/`ERP_AUDIT` | `features/erpIntegration/pages/*`, `ErpAccessGate.jsx` | ~35 routes `/api/admin/erp-integrations…`, `/erp-sync…` (`admin.erp.controller.js`; scheduler started by `server.js` unless `ERP_SCHEDULER_ENABLED=false`) | Erp* (10 models) | ✔ (7 suites) | Implemented (generic REST/SAP OData provider) | A7 hide | P2 hide UI; P3 API/scheduler policy |
| Reports (10 items) | PLANNED | none | none | – | – | **Missing** (all) | A8 remove Secondary Sales | P2 clean list; reports built later |
| Notifications, Audit Logs | PLANNED | none | none | none (no audit table for non-ERP) | – | Missing | A10 hide | Keep hidden |
| Settings | PLANNED | none | none | none | – | Missing | A9 | later phase |

Direct-URL exposure (Admin): every routed page above stays reachable by URL after hiding; unknown paths fall to `AdminNotFound`.

---

## 2. Distributor Portal (`/dashboard/*`, API `/api/*`, auth `authMiddleware` + `req.user.id` scoping)

Layout `src/components/Distributers/dashboard/DashboardLayout.jsx` (shared `AppShell`), guard `src/routes/ProtectedRoute.jsx` (**client-side check of `localStorage["user"]` only**; the server is the real control). Portal navigation = `distributorNavigation` minus `distributor-management` and `sap` groups.

| Sidebar item | Nav state | FE page / route | API | Status | Requirement | Action |
|---|---|---|---|---|---|---|
| Dashboard | LIVE `/dashboard` | `pages/Dashboard.jsx` | four count endpoints (`/customer/count`, `/sales-delivery/count`, `/salesorder/count`, `/stock/count`) | Implemented | – | – |
| Sales (Orders, Deliveries, Invoices, Returns, Credit Notes, Debit Notes) | LIVE | `pages/SalesOrderMaster.jsx`, `delivery/sodelivery/DeliveryPage.jsx`, `invoice/soinvoice/InvoicePage.jsx`, `returns/salesreturn/SalesReturnPage.jsx`, `creditnotes/socredit/CreditNotePage.jsx`, `debitnotes/sodebit/DebitNotePage.jsx` | `/api/salesorder`, `/sales-delivery`, `/sales-invoice`, `/sales-return`, `/sales-creditnote`, `/sales-debitnote` | Implemented | – | Keep (A2 is Admin-only) |
| Sales › Secondary Sales | PLANNED | none | – | Planned | hide | – |
| Purchase (PO, Deliveries, Invoices, Returns, Debit Notes) | LIVE | `Po.jsx`, `delivery/podelivery/Podel.jsx`, `invoice/poinvoice/Poinvoice.jsx`, `returns/purchasereturn/PurchaseReturnPage.jsx`, `debitnotes/podebit/PurchaseDebitNotePage.jsx` | `/api/purchase-orders`, `/po-delivery`, `/po-invoice`, `/purchase-return`, `/purchase-debitnote` | Implemented | B7 "Purchase Orders (PO)" report needs this data | – |
| Inventory › Current, Batch, Ledger, Near Expiry, Expired | LIVE | `pages/InventoryStock/*` | `/api/inventory/*`, `/api/stockLedger/*`, `/api/stock*` | Implemented | – | – |
| Inventory › **FEFO Monitor** | LIVE `/dashboard/inventory/fefo` | `InventoryStock/FefoMonitor.jsx` | `GET /api/inventory/fefo-preview` | Implemented | B1 hide | P2 hide nav (route + API stay) |
| **Masters** group | LIVE (Product, Batch, Customer, Vendor, Pricing, Tax(HSN), Customer/Vendor/Item Groups); Retailer Master, Scheme Master PLANNED | `MaterialMaster.jsx`, `StockMaster.jsx`, `Customer.jsx`, `Vendor.jsx`, `PricingMaster.jsx`, `HSNMaster.jsx`, `customerGroup.jsx`, `VendorGroup.jsx`, `ItemGroup.jsx` | `/api/product`, `/stock`, `/customer`, `/vendor`, `/pricing`, `/hsn`, `/customergroup`, `/vendorgroup`, `/itemgroup` | Implemented | B1 hide whole group | P2 hide nav. **Dependency:** Masters pages are the only place to create products/customers/vendors/batches — hiding breaks distributor operations unless "Masters" is relocated (decision) |
| Retailer Management › Retailer List | LIVE | `features/retailers/pages/*` (`portal="distributor"`) | `/api/retailers…` | Implemented | not in B | decision |
| **Schemes & Claims** | LIVE (Claims) + 4 PLANNED | `features/claims/pages/*` | `/api/claims…`, `/api/schemes/applicable`, `/schemes/evaluate` | Implemented | B1 hide | P2 hide nav |
| Accounts (Customer Ledger, **Vendor Ledger**, Payments, GL Master, Trial Balance, Balance Sheet) | LIVE | `accounts/CustomerLedger.jsx`, `VendorLedger.jsx`, `Payments.jsx` (customer receipts **and vendor payments**), `GLMaster.jsx`, `TrialBalance.jsx`, `BalanceSheet.jsx` | `/api/ledger/customer/:code`, `/ledger/vendor/:code`, `/payment/receive`, `/payment/vendor`, `/gl-master`, `/trial-balance`, `/balance-sheet` | Implemented | B2 remove vendor options | P2/P3: hide Vendor Ledger + vendor payment tab (`Payments.jsx`); keep API unless decided |
| **Financial View** (Overview, Outstanding, Ageing, Ledger, Payments Received, Credit Limit) | LIVE `/dashboard/finance*` | `features/accounts/pages/*` (`portal="distributor"`) | `/api/accounts/{lookups,summary,outstanding,ageing,ledger,credit,payments}` (read-only, `accounts.controller.js`) | Implemented | B1 hide | P2 hide nav |
| **"My Ledger"** | **does not exist as a label**; nearest: Financial View › Ledger (`/dashboard/finance/ledger`, "My account" mode + scheme-claim account) and Accounts › Customer Ledger | – | `GET /api/accounts/ledger` | **Partial — cannot be called complete.** The data model has no distributor↔admin transactions: no primary sales/purchase from the company, no distributor-to-company payment record. Only scheme-claim settlement (`Scheme Claims Receivable`) links a distributor to the company | B3 | Decision (§Audit 8.4); P3/P4 |
| Reports (10 items) | PLANNED | none | none | **Missing** (all) | B7 list: Sales, Stock, Expiry, Scheme, Returns, Outstanding, **Purchase Orders** | P4: add; PO report item is new (not in current list) |
| Notifications, Audit Logs | PLANNED | none | none | Planned | B6 keep hidden | – |
| Settings | PLANNED | none | none | Missing | B5 | later phase |

Report feasibility (B7) — whether a calculation basis exists in the code today:

| Report | Page | API | Data basis already in DB | Verdict |
|---|---|---|---|---|
| Sales | none | none | SalesInvoiceHeader/Line, SalesOrder* | Basis exists; no report endpoint (admin dashboard has some aggregates) |
| Stock | none | `/api/inventory/summary|current` exist | Batch, StockLedger | Basis + endpoints exist; no report page |
| Expiry | none | `/api/inventory/expiry-summary` | Batch.expiry | Basis + endpoint exist |
| Scheme | none | `/api/schemes/applicable` only | Scheme, Claim | Partial |
| Returns | none | `/api/sales-return`, `/purchase-return` lists | SalesReturn/PurchaseReturn | Basis exists |
| Outstanding | none | `/api/accounts/outstanding` | Payment, invoices | Endpoint exists (Financial View) |
| Purchase Orders | none | `/api/purchase-orders` list | PurchaseOrderHeader/Line | Basis exists; no report |

---

## 3. Super Admin Portal (`/admin/super-admin`, same login as Admin, role `SUPER_ADMIN`)

| Item | Detail | Status |
|---|---|---|
| Page | `src/features/superAdmin/pages/SuperAdminDashboardPage.jsx`; client `features/superAdmin/api/superAdminApi.js`; nav entry `super-admin` with `requiresRole: "SUPER_ADMIN"` (UX only) | Implemented |
| API | `GET /api/admin/superadmin/overview`, `GET /api/admin/superadmin/admins/:id/distributors` → `controllers/superAdmin.controller.js`, `services/superAdmin.service.js`, guarded by `requireAdmin` + `requireSuperAdmin` (role from DB) | Implemented, tested |
| C.1 Total Admin accounts | `totals.admins {total, active, inactive}` from `admin_users` (**counts every admin_users row, including SUPER_ADMIN and ERP_* roles, as "admins"**) | Implemented; definition of "Admin/company" needs decision |
| C.2 Total distributors | `totals.distributors {total, active, inactive, pending, unassigned}` | Implemented |
| C.3 Distributors per onboarding Admin | `GROUP BY created_by_admin_id`; drill-down lists max **1,000** rows (no pagination) | Implemented; Partial for scale |
| C.4 Unassigned | `created_by_admin_id IS NULL` → "unassigned" (no guessing) | Implemented, correct policy |
| C.5 Network totals | only counts; `retailers` = `COUNT(*) FROM Customers` (all customers, not retailers by type) | Partial — no sales/stock/outstanding network totals |
| Reports section | none | **Missing** |
| ERP hidden (Super Admin) | Super Admin sees the same Admin ERP group (`SUPER_ADMIN` has all ERP permissions) | Not done (P2) |
| Ownership reliability | `created_by_admin_id` has no FK, no history; set only by Admin-portal create after migration; not changed by any reassignment route; Super Admin has no UI to assign owners | Limitation — see DB document |
| Network-only dashboard | Super Admin currently *also* gets the whole Admin menu (Sales, Inventory, …), i.e. the portal is not separated from the Admin dashboard | Gap for C (P6) |

---

## 4. Cross-module dependencies to check before hiding anything
1. `src/config/adminNavigation.js` derives groups from `distributorNavigation` by id; removing an item from `navigation.js` silently changes the Admin menu and vice-versa. Prefer editing the Admin file and add a test.
2. `visibleNavigation`/`filterAdminNavigation` hide a whole ERP group when no entry has `requires`; the Admin Dashboard has a SAP status card and `AppShell` shows a `SapStatusIndicator` header badge — both survive hiding the sidebar group.
3. Distributor "Masters", "Schemes & Claims" and "Financial View" contain the only create/edit screens or read-only finance views; hiding them removes the user's way to maintain products, customers, vendors, batches, pricing, HSN, groups.
4. `features/accounts` is shared by Admin and Distributor (`portal` prop); a retailer-option removal changes `LedgerPage`, `OutstandingPage`, `PaymentsPage`, `CreditPage`, `RecordPaymentModal.jsx`, `accountsHooks.js`, `accountsApi.js` for both portals.
5. `features/retailers`, `features/inventory`, `features/claims` are also shared.
6. Global search (`GlobalSearch.jsx`) and breadcrumbs (`useBreadcrumbs.js`, `EXTRA_ROUTE_LABELS`) read the same config — hidden items disappear there too.
