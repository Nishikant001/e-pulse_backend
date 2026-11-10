# Pharma DMS — Module Mapping (Phase 1)

Companion to `PHARMA_DMS_ARCHITECTURE_AUDIT.md`.

**How to read this document**

- **Existing Module** = what is in the current ZIPs. **Pharma DMS Module** = where it lands in the target product.
- **Status:** `Implemented` (works today) · `Partial` (exists, pharma gaps) · `Broken` (present but not working) · `Missing`.
- **Action:** `Reuse` (keep, light extension) · `Redesign` (functionality kept, UI/model reworked) · `New` (must be built) · `Retire` (dead code, remove in a dedicated cleanup).
- Business rules are **not** taken from this document. They come from the senior's Pharma DMS document, which was not available during the audit. Rows marked *(validate)* need confirmation against it.
- No file renames are proposed for Phase 1 — renaming can break imports and routes.

---

## 1. Module Mapping (business modules)

| Existing Module | → Pharma DMS Module | Status | Action | Notes / gaps |
|---|---|---|---|---|
| `Distributor` (self-signup, login) | Distributor Master + Distributor Portal identity | Partial | Reuse (login) + New (master) | Login must stay untouched. Missing: drug licence, territory, approval workflow, status, SAP code, admin-driven onboarding |
| — | Admin / Super Admin portal, `AdminUser` | Missing | New | Separate identity, token audience, cookies |
| — | Company roles (Company Admin, Sales Manager, Accounts, Auditor) | Missing | New | RBAC tables + middleware |
| — | Distributor staff roles (Sales Rep, Accounts, Warehouse, Auditor, User) | Missing | New | `DistributorUser`; owner = implicit full access |
| `Customer` + `Address` + `CustomerGroup` | Retailer Master / Retailer Management | Partial | Reuse + Redesign | Missing: drug licence no. + expiry, GSTIN validation, route/area, credit limit/days, salesman, status, login. *(validate)* |
| `Vendor` + `VendorGroup` | Vendor Management (company/supplier) | Implemented | Reuse | In pharma, primary supply may come from the company/SAP *(validate)* |
| `Product` / `MaterialMaster` page | Pharmaceutical Product Master | Partial | Reuse + Redesign | Has `drug_licence_number`, `mfg_by`, GST fields. Missing: composition/salt, drug schedule (H/H1/X), pack size, shelf life, therapeutic category, MRP/PTR/PTS, SAP material no. |
| `ItemGroup`, `HSNGroup` | Product category / Tax classification | Implemented | Reuse | HSN carries `gst_rate` |
| `Batch` | Batch Management | Partial | Reuse | Has batch_no, mfg/exp dates, purchase price, status, life_remaining. Missing: MRP/PTR/PTS per batch, unique (distributor, product, batch_no), quarantine/blocked reason |
| `StockLedger` + `inventory.service` | Pharmaceutical Inventory (ledger, current, batch stock) | Implemented | Reuse | Best asset: ledger-derived stock, row locking, idempotency. Missing: warehouse/location, stock status (sellable/expired/damaged/quarantine), valuation |
| `batchAllocation` / FEFO in `inventory.service` | FEFO allocation | Implemented | Reuse | NULL expiry sorts first on MySQL — fix before pharma go-live |
| `updateExpiredBatches` (batch expiry job) | Expiry Management | Partial | Reuse + New | Job exists but is never scheduled; no near-expiry buckets, alerts, or expiry-return workflow |
| `PricingMaster` + `pricing.service` | Pricing Master | Partial | Reuse + Redesign | Product × customer-group × validity. Missing: MRP/PTR/PTS structure, margins, state-wise, batch-wise price, approval/history |
| — | Scheme Master (+ slabs, application engine) | Missing | New | Must integrate with order pricing and invoice lines |
| `tax.service` + `HSNGroup` | Tax Master | Partial | Reuse + Redesign | CGST/SGST vs IGST + rounding exist. Two tax paths (sales vs purchase); no place-of-supply table, cess, TCS/TDS |
| `SalesOrderHeader/Line` (+ `SalesOrderMaster` page) | Secondary Sales Order | Implemented | Reuse + Redesign | DRAFT → CONFIRMED → PARTIALLY/FULLY_DELIVERED → CANCELLED/CLOSED. Add retailer link, scheme, credit check, salesman *(validate)* |
| `SalesDeliveryHeader/Line` (+ `DeliveryPage`) | Dispatch / Delivery (FEFO stock-out) | Implemented | Reuse | Stock posted at delivery creation; delivery status enum differs from order statuses |
| `SalesInvoiceHeader/Line` (+ `InvoicePage`) | Pharmaceutical Sales Invoice | Implemented | Reuse + Redesign | Posting creates Dr Receivable / Cr Sales / Cr Output GST. No COGS, no scheme lines |
| — | **Secondary Sales (as a business view)** | Partial | New (views/reports on existing chain) | Existing distributor→customer chain *is* secondary sales; needs retailer/route/salesman dimensions and reporting. *(validate primary vs secondary definition)* |
| `SalesReturnHeader/Line` + `returnableQuantity.service` | Pharmaceutical Sales Return | Implemented | Reuse + Redesign | Over-return protection exists. Add return reasons (expiry/damage/wrong), batch/expiry validation, quarantine |
| `SalesCreditNote` (+ lines) | Credit Notes | Implemented | Reuse | Link to returns and claims |
| `SalesDebitNote` | Debit Notes | Implemented | Reuse | — |
| `PurchaseOrderHeader/Line` | Purchase / Primary Order | Implemented | Reuse | Later mapped to company/SAP supply *(validate)* |
| `PurchaseDelivery*` | Goods Receipt (batch creation) | Implemented | Reuse | Creates batches + stock-in |
| `PurchaseInvoice*` | Purchase Invoice | Implemented | Reuse | Uses HSN rate + place comparison for tax |
| `PurchaseReturn*`, `PurchaseDebitNote` | Purchase Return / Debit Note | Implemented | Reuse | — |
| `payment.controller` (journal only) | Accounts → Receipts / Payments | Partial | Redesign | **No payment table, no invoice allocation, `outstandingAmount` never reduced, PAID/PARTIALLY_PAID never set** |
| `GLMaster`, `JournalEntry`, `accounting.service` | Accounts (chart of accounts, journals) | Implemented | Reuse | Needs voucher id, financial year, default CoA seeding on signup |
| Customer/Vendor ledger, Trial Balance, Balance Sheet | Ledgers & financial reports | Implemented | Reuse | Opening balances = 0; no FY filter |
| — | Claims (scheme / expiry / damage) | Missing | New | Depends on schemes, returns, credit notes |
| — | Reports (sales, scheme, expiry, ageing, coverage) | Missing | New | Only stock, ledger, TB, BS exist |
| Dashboard page | Dashboard (Admin / Distributor / Retailer) | Partial | Redesign | 4 real counts; charts and % are hardcoded demo data |
| — | Notifications | Missing | New | Expiry, low stock, claim, approvals |
| — | Audit Logs | Missing | New | No user/timestamp trail on documents or journals |
| — | Settings | Missing | New | |
| — | RBAC | Missing | New | |
| — | SAP Integration, SAP Sync, SAP Jobs, Failed Transactions, API Monitor | Missing | New | Outbox pattern; needs field mapping from business doc. **No SAP credentials to be added until then** |
| `authFetch`, Login/Signup/Forgot/Reset pages | Distributor portal auth UI | Implemented | Reuse | Do not replace; restyle later |
| `Sidebar`, `DashboardLayout` | Portal shell | Implemented | Redesign | Fixed-width, desktop-only; becomes per-portal layout |
| `utils/api.js` (axios) | — | Broken (unused) | Retire | |
| `Delivery.jsx`, `Invoice.jsx`, `Viewinvoice.jsx` (+ `/dashboard/delivery`, `/invoice/creation`, `/invoice/view`) | superseded by `sales/delivery`, `sales/invoice` | Broken | Retire | Call removed endpoints; read a never-set `token` |
| `ProductMaster.jsx` | superseded by `MaterialMaster` | Orphan | Retire | Not imported anywhere |
| `delivery.controller.js`, `invoice.controller.js`, `delivery.model.js`, `invoice.model.js` | — | Dead | Retire | Not registered/required |

## 2. Frontend Page → Portal Mapping

Current URLs stay valid in Phase 1. Future groups: `/admin/*`, `/distributor/*`, `/retailer/*`. `/dashboard/*` later becomes an alias of `/distributor/*`.

| Current route (`/dashboard/…`) | Component | Future portal / module | Action |
|---|---|---|---|
| *(index)* | `Dashboard` | Distributor Dashboard | Redesign |
| `salesorder-master` | `SalesOrderMaster` | Distributor → Sales Orders | Reuse |
| `sales/delivery` | `DeliveryPage` | Distributor → Deliveries | Reuse |
| `sales/invoice` | `InvoicePage` | Distributor → Sales Invoices | Reuse |
| `sales/credit`, `sales/debit` | `CreditNotePage`, `DebitNotePage` | Distributor → Credit/Debit Notes | Reuse |
| `sales/return` | `SalesReturnPage` | Distributor → Sales Returns | Reuse |
| `customer`, `customerGroup` | `Customer`, `CustomerGroup` | Distributor → Retailers; Admin → Retailer Mgmt | Redesign |
| `vendor`, `vendorsGroup` | `Vendor`, `VendorGroup` | Distributor → Vendors | Reuse |
| `material-master`, `itemsGroup`, `hsn-master` | `MaterialMaster`, `ItemGroup`, `HSNMaster` | Product master (Admin owns pharma master; distributor view) | Redesign |
| `pricing` | `PricingMaster` | Admin → Pricing Master | Redesign |
| `stock-master`, `inventory/current`, `inventory/batch`, `inventory/ledger` | `StockMaster`, `CurrentStock`, `BatchStock`, `StockLedger` | Distributor → Inventory / Batch / Expiry | Reuse + Redesign |
| `purchase/po`, `purchase/delivery`, `purchase/invoice`, `purchase/return`, `purchase/debit` | `Po`, `PODeliveryManagement`, `PurchaseInvoiceSystem`, `PurchaseReturnPage`, `PurchaseDebitNotePage` | Distributor → Purchase / Primary | Reuse |
| `accounts/GLMaster`, `CustomerLedger`, `VendorLedger`, `TrialBalance`, `BalanceSheet`, `Payments` | accounts pages | Distributor → Accounts | Reuse; Payments Redesign |
| `logout` | `Logout` | Shared | Reuse |
| `delivery`, `invoice/creation`, `invoice/view` | legacy | — | Retire |

## 3. API Mapping (existing → future pharma functionality)

All 147 routes are mounted under `/api` in `routes/allRoutes.js`. **Exactly 7 routes are public** (`/signup`, `/login`, `/logout`, `/refresh-token`, `/forgot-password`, `/verify-otp`, `/reset-password`); every other route is behind `authMiddleware` (JWT, tenant = `req.user.id`). None has a role check.

| Existing API group | Methods | Future pharma functionality | Action |
|---|---|---|---|
| `/signup`, `/login`, `/logout`, `/refresh-token`, `/forgot-password`, `/verify-otp`, `/reset-password` | POST | Distributor portal auth — **keep unchanged** | Reuse (harden later, additive) |
| `/customer`, `/customer/:id`, `/customer/count`, `/customer/by-code/:code`, `/customer/:id/addresses` | CRUD | Retailer master/management | Reuse + extend (tenant scoping fixed in Phase 1) |
| `/customergroup` | CRUD + bulk | Retailer classes / price groups | Reuse |
| `/vendor` | CRUD | Supplier master | Reuse (tenant scoping fixed) |
| `/vendorgroup` | create / list / delete + bulk (no update) | Supplier classes | Reuse; add update |
| `/product` (+ `bulk-upload`) | CRUD | Pharma product master | Reuse + extend; bulk upload **Broken** |
| `/itemgroup`, `/hsn` | create / list / delete + bulk (no update) | Categories, tax classes | Reuse; add update |
| `/pricing` | CRUD | Pricing master | Reuse + Redesign |
| `/stock`, `/stock/count` (+ `/stock/bulk-upload`) | CRUD | Batch master | Reuse; bulk upload **Broken/unreachable** |
| `/stockLedger/current`, `/batch`, `/batch/:batchId`, `/ledger` (GET); `/in`, `/out`, `/adjustment` (POST) | GET/POST | Inventory, batch stock, ledger | Reuse |
| `/salesorder` (+ `/count`, `/by-number/:n`, confirm, cancel) | CRUD | Secondary sales order | Reuse + extend |
| `/sales-delivery` (+ `/count`) | document lifecycle | Dispatch (FEFO out) | Reuse |
| `/sales-invoice` | document lifecycle (create/list/get/post/…) | Sales invoice | Reuse + extend |
| `/sales-creditnote`, `/sales-debitnote` | document lifecycle | Credit / debit notes | Reuse |
| `/sales-return` | create / list / get / post / cancel | Sales return | Reuse + extend |
| `/purchase-orders`, `/po-delivery`, `/po-invoice`, `/purchase-return`, `/purchase-debitnote` | document lifecycle | Primary purchase / GRN | Reuse |
| `/payment` | POST ×2 | Receipts/payments | **Redesign** (allocation) |
| `/gl-master` (+ upload) | CRUD | Chart of accounts | Reuse |
| `/ledger/customer/:code`, `/ledger/vendor/:code`, `/trial-balance`, `/balance-sheet` | GET | Financial reports | Reuse |
| *(none)* | — | Admin, Retailer, RBAC, Schemes, Claims, Notifications, Audit, Settings, Reports, SAP | **New** |

## 4. Database Mapping

| Existing table (model) | Category | Pharma role | Action |
|---|---|---|---|
| `Distributor` | Auth + tenant | Distributor master + owner login | Reuse; add master fields later (additive) |
| `Customer`, `Address` | Master | Retailer master | Reuse; additive columns later |
| `Vendor` | Master | Supplier | Reuse |
| `CustomerGroup`, `VendorGroup`, `ItemGroup`, `HSNGroup` | Master | Classification / tax | Reuse |
| `Product` | Master | Pharma product | Reuse; additive pharma attributes |
| `PricingMaster` | Pricing | Price structure | Redesign (additive) |
| `Batch` | Inventory/Batch | Batch master | Reuse; add price/status fields |
| `StockLedger` | Inventory | Stock movements | Reuse |
| `SalesOrder*`, `SalesDelivery*`, `SalesInvoice*`, `SalesCreditNote*`, `SalesDebitNote`, `SalesReturn*` | Sales transactions | Secondary sales chain | Reuse |
| `PurchaseOrder*`, `PurchaseDelivery*`, `PurchaseInvoice*`, `PurchaseReturn*`, `PurchaseDebitNote` | Purchase transactions | Primary purchase | Reuse |
| `GLMaster`, `JournalEntry` | Accounting | Accounts | Reuse; add voucher id/FY |
| *(none)* | Payments | Receipts + allocation | New: `PaymentReceipt`, `PaymentAllocation` |
| *(none)* | Audit | Audit log | New: `AuditLog` |
| *(none)* | Auth | Admin/retailer/staff identities, roles | New: `AdminUser`, `DistributorUser`, `RetailerUser`, `Role`, `Permission`, `RolePermission` |
| *(none)* | Pharma commercial | Schemes, claims | New: `Scheme`, `SchemeSlab`, `Claim`, `ClaimLine` |
| *(none)* | Platform | Notifications, settings, sequences, FY | New: `Notification`, `Setting`, `NumberSequence`, `FinancialYear` |
| *(none)* | Integration | SAP | New: `SapOutbox`, `SapSyncJob`, `ApiLog` |
| `delivery`, `invoice` (unregistered legacy models) | — | — | Retire |

**Rules for all DB work:** additive migrations only; no drops, no resets, no data rewrites; each new table documented here before creation. Nothing was created in Phase 1.

## 5. Role & Protected-Surface Map

| Role (target) | Portal | Identity today | Protected today |
|---|---|---|---|
| Super Admin | Admin | none | — |
| Company Admin | Admin | none | — |
| Sales Manager | Admin | none | — |
| Accounts User | Admin / Distributor | none | — |
| Auditor | Admin / Distributor | none | — |
| Distributor Sales Representative | Distributor | none | — |
| Warehouse User | Distributor | none | — |
| Distributor User | Distributor | `Distributor` (single login, full access) | 140 of 147 routes require login; `/dashboard/*` gated by `ProtectedRoute` (UX only) |
| Retailer User | Retailer | none | — |

**Where authorization must improve first:** (1) a `requirePortal`/`requireRole` layer so future admin endpoints can't be reached by distributor tokens; (2) automated cross-tenant tests for every controller; (3) tenant-scoping helper so `distributor_id` filtering is enforced centrally rather than hand-written per query.

## 6. Reusable Frontend Building Blocks

| Asset | Reuse verdict |
|---|---|
| `authFetch` (cookie auth + refresh retry) | Reuse as the single API client; now reads `VITE_API_BASE_URL` |
| `ProtectedRoute` (new) | Reuse; extend with `portal`/`role` props |
| `DashboardLayout`, `Sidebar` | Redesign into per-portal shells |
| Hand-rolled tables/modals/badges/forms | Replace with shared design-system components (no shared components exist today) |
| Recharts usage | Reuse library; replace demo data with real endpoints |
| Credential pages | Keep behaviour; restyle from the visual reference |
| Unused libs (html2pdf.js, jspdf, pdfmake, qrcode.react, react-qr-code) | Remove in cleanup, or adopt deliberately for invoice PDFs/QR |
