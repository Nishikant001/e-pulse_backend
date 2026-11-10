# PHASE 22 — Proposed Admin permission matrix (DESIGN PROPOSAL — NOT IMPLEMENTED)

**Status: proposal only. No code, role, migration or user access was changed.** Final role→permission assignment is a business decision and is deliberately left blank (§4). Existing users keep exactly today's access.

## 1. Evidence (current state)
* 128 Admin routes (extracted from the live router, not by reading text). Guards: `requireAdmin` (any active admin session) on everything except `login/logout/session`; `erpPermission()` on the 32 `/erp-*` routes only.
* **39 non-ERP write routes** (sales 8, masters 13, distributors 3, retailers 4, schemes 4, claims 5, accounts 2) accept *any* active admin, including: posting/cancelling invoices, settling claims, recording payments, changing credit limits, editing pricing/tax masters.
* `admin_users.role` is a free label (default `ADMIN`); only ERP permissions are derived from it (`config/erpPermissions.js`). Existing ERP roles (`ERP_ADMIN`, `ERP_OPERATOR`, `ERP_VIEWER`, `SUPER_ADMIN`, `ADMIN`) say nothing about DMS modules and must not be reused as if they did.
* No Admin API exists for: Purchase/Suppliers, Users & roles, general Audit Logs, Settings, stock adjustments. Their permissions are listed as **reserved** (nothing to guard yet).

## 2. Naming and semantics
`<RESOURCE>_<ACTION>`; actions: **VIEW** read-only · **CREATE** new record/draft · **EDIT** change a draft/master · **APPROVE** a decision that releases/commits (order confirm, claim decision, scheme activation) · **POST** financial/inventory posting or reversal · **SETTLE** money leaves/enters the books against a claim · **MANAGE** configuration/status/activation/credit limits. A role never implies another action (no VIEW↔WRITE inheritance); WRITE permissions do not include VIEW unless granted.

## 3. Module × action matrix  (✔ = proposed permission exists for an existing route · ◻ = reserved, no Admin API yet · — = not applicable)
| Module | VIEW | CREATE | EDIT | APPROVE | POST | SETTLE | MANAGE | Notes |
|---|---|---|---|---|---|---|---|---|
| Dashboard | ✔ `DASHBOARD_VIEW` | — | — | — | — | — | — | Today guarded by a rate-limit policy only. ERP card already gated by `ERP_VIEW`. |
| Sales Orders | ✔ `SALES_ORDER_VIEW` | ✔ | ✔ (cancel) | ✔ (confirm) | — | — | — | Preview is non-mutating (could be VIEW). |
| Sales Invoices & posting | ✔ | ✔ (create from order) | — | — | ✔ `SALES_INVOICE_POST` (post, cancel/reverse) | — | — | **Financial.** Separate `…_CANCEL` possible. |
| Inventory & stock adjustments | ✔ `INVENTORY_VIEW` | ◻ | ◻ | ◻ | ◻ `INVENTORY_ADJUST_POST` | — | — | Admin API is read-only today; adjustments not exposed. |
| Product & pricing masters (product, batch, pricing, tax, scheme) | ✔ | ✔ | ✔ | ✔ (scheme status) | — | — | ✔ (activate/deactivate) | Pricing/tax edits change invoice values → flag as financial-impact. |
| Distributors & retailers | ✔ `PARTY_VIEW` | ✔ | ✔ | — | — | — | ✔ (status, retailer re-assign) | |
| Claims approval & settlement | ✔ | — | ✔ (review) | ✔ (approve/reject/needs-correction) | — | ✔ `CLAIM_SETTLE` | — | Segregation: approve ≠ settle. |
| Payments & accounts | ✔ `ACCOUNT_VIEW` | — | — | — | ✔ `PAYMENT_POST` | — | ✔ `CREDIT_LIMIT_MANAGE` | |
| Purchase & suppliers | ◻ | ◻ | ◻ | ◻ | ◻ | — | ◻ | No Admin API/UI (Distributor portal only). |
| Reports | ✔ `REPORT_SECONDARY_SALES_VIEW` | — | — | — | — | — | — | Other reports are placeholders (◻). |
| Users & roles | ◻ | ◻ | ◻ | — | — | — | ◻ `USER_MANAGE` | No API/UI; CLI scripts only. Needs last-super-admin protection (pattern exists in `set-admin-role.js`). |
| Audit Logs & Settings | ◻ `AUDIT_VIEW` | — | — | — | — | — | ◻ `SETTINGS_MANAGE` | Only the ERP audit log exists (`ERP_AUDIT`). |
| ERP Integration | existing `ERP_VIEW`, `ERP_AUDIT` | — | existing `ERP_MANAGE` | — | — | — | existing `ERP_SYNC/RETRY/SCHEDULE` | **Unchanged.** |

Read-only vs changing: every `*_VIEW` is read-only. Financial/inventory-changing: `SALES_INVOICE_POST`, `PAYMENT_POST`, `CLAIM_SETTLE`, `CREDIT_LIMIT_MANAGE`, pricing/tax `*_EDIT`, scheme `APPROVE`, `INVENTORY_ADJUST_POST` (reserved).

## 4. Role assignment — BUSINESS DECISION REQUIRED (intentionally blank)
| Role (to be named by business) | Permissions granted | Approved by | Date |
|---|---|---|---|
| _e.g. Sales executive_ | _to be decided_ | | |
| _e.g. Finance_ | _to be decided_ | | |
| _e.g. Claims reviewer / Claims settler_ | _to be decided_ | | |
| _e.g. Auditor (read-only)_ | _to be decided_ | | |
No role names, groupings or user assignments were invented here.

## 5. Safe rollout design (when approved)
1. `admin_role_permissions` (role, permission) table + `adminPermission(perm)` middleware mirroring `erpPermission()` (role re-read per request, deny by default, denial recorded).
2. Feature switch `ADMIN_RBAC_MODE = off | audit | enforce`, **default `off`** (today's behaviour). `audit` logs "would be denied" without blocking so the business can see the impact before enforcing.
3. Legacy role `ADMIN` maps to *all* permissions at first (no silent loss of access, same as the ERP compatibility rule); users are tightened explicitly, one by one.
4. Last-super-admin protection and an audited role-change path; UI hiding is cosmetic only.
5. Tests per route: allowed role, denied role, unknown role (deny), inactive admin, cross-distributor scope unchanged, ERP RBAC unchanged.

**Implementation dependencies:** (a) approved §4 matrix; (b) decision on `off/audit/enforce` timing and who owns the first SUPER_ADMIN; (c) Users/Roles API+UI (none exists); (d) a migration for the permission table (needs the fresh-install question D4 answered first); (e) decision on borderline routes marked "business may…" below.

## 6. Per-route mapping (generated from the live router)
| # | Method | Path | Module | Proposed permission | Class | Notes | Guard today |
|---|---|---|---|---|---|---|---|
| 1 | POST | `/login` | (authentication only) | — | - | none — pre-auth endpoint | none |
| 2 | POST | `/logout` | (authentication only) | — | - | none — pre-auth endpoint | none |
| 3 | GET | `/session` | (authentication only) | — | - | none — pre-auth endpoint | none |
| 4 | GET | `/me` | (authentication only) | — | - | session identity; no permission | requireAdmin |
| 5 | GET | `/dashboard/summary` | Dashboard | `DASHBOARD_VIEW` | READ | read-only | requireAdmin |
| 6 | GET | `/sales/lookups/filters` | Sales Orders | `SALES_ORDER_VIEW` | READ | read-only lookups | requireAdmin |
| 7 | GET | `/sales/lookups/retailers` | Sales Orders | `SALES_ORDER_VIEW` | READ | read-only lookups | requireAdmin |
| 8 | GET | `/sales/lookups/products` | Sales Orders | `SALES_ORDER_VIEW` | READ | read-only lookups | requireAdmin |
| 9 | GET | `/sales/lookups/batches` | Sales Orders | `SALES_ORDER_VIEW` | READ | read-only lookups | requireAdmin |
| 10 | GET | `/sales/orders` | Sales Orders | `SALES_ORDER_VIEW` | READ |  | requireAdmin |
| 11 | POST | `/sales/orders/preview` | Sales Orders | `SALES_ORDER_CREATE` | WRITE | non-mutating price preview; business may downgrade to VIEW | requireAdmin |
| 12 | POST | `/sales/orders` | Sales Orders | `SALES_ORDER_CREATE` | WRITE |  | requireAdmin |
| 13 | GET | `/sales/orders/:id` | Sales Orders | `SALES_ORDER_VIEW` | READ |  | requireAdmin |
| 14 | PUT | `/sales/orders/:id` | Sales Orders | `SALES_ORDER_EDIT` | WRITE |  | requireAdmin |
| 15 | POST | `/sales/orders/:id/confirm` | Sales Orders | `SALES_ORDER_APPROVE` | WRITE | status change; reserves/commits order | requireAdmin |
| 16 | POST | `/sales/orders/:id/cancel` | Sales Orders | `SALES_ORDER_EDIT` | WRITE | status change; business may require APPROVE | requireAdmin |
| 17 | POST | `/sales/orders/:id/create-invoice` | Sales Invoices | `SALES_INVOICE_CREATE` | WRITE | creates a draft invoice from an order | requireAdmin |
| 18 | GET | `/sales/invoices` | Sales Invoices | `SALES_INVOICE_VIEW` | READ | read-only | requireAdmin |
| 19 | GET | `/sales/invoices/:id` | Sales Invoices | `SALES_INVOICE_VIEW` | READ | read-only | requireAdmin |
| 20 | POST | `/sales/invoices/:id/post` | Sales Invoices | `SALES_INVOICE_POST` | WRITE | FINANCIAL: posts journals (AR / Sales / GST) | requireAdmin |
| 21 | POST | `/sales/invoices/:id/cancel` | Sales Invoices | `SALES_INVOICE_POST` | WRITE | FINANCIAL: reverses/voids; separate SALES_INVOICE_CANCEL is an option | requireAdmin |
| 22 | GET | `/sales/secondary/summary` | Reports | `REPORT_SECONDARY_SALES_VIEW` | READ | read-only report | requireAdmin |
| 23 | GET | `/sales/secondary` | Reports | `REPORT_SECONDARY_SALES_VIEW` | READ | read-only report | requireAdmin |
| 24 | GET | `/sales/secondary/:key` | Reports | `REPORT_SECONDARY_SALES_VIEW` | READ | read-only report | requireAdmin |
| 25 | GET | `/inventory/lookups` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 26 | GET | `/inventory/summary` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 27 | GET | `/inventory/current` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 28 | GET | `/inventory/batches` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 29 | GET | `/inventory/batches/:id` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 30 | GET | `/inventory/ledger` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 31 | GET | `/inventory/movement` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 32 | GET | `/inventory/transfers` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 33 | GET | `/inventory/expiry-summary` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 34 | GET | `/inventory/fefo-preview` | Inventory | `INVENTORY_VIEW` | READ | read-only (no stock-adjustment endpoint exists in the Admin API) | requireAdmin |
| 35 | GET | `/masters/lookups` | Product & pricing masters | `MASTER_VIEW` | READ | read-only lookups | requireAdmin |
| 36 | GET | `/masters/products` | Product & pricing masters | `PRODUCT_VIEW` | READ | read-only | requireAdmin |
| 37 | GET | `/masters/products/:id` | Product & pricing masters | `PRODUCT_VIEW` | READ | read-only | requireAdmin |
| 38 | POST | `/masters/products` | Product & pricing masters | `PRODUCT_CREATE` | WRITE | master-data change | requireAdmin |
| 39 | PUT | `/masters/products/:id` | Product & pricing masters | `PRODUCT_EDIT` | WRITE | master-data change | requireAdmin |
| 40 | POST | `/masters/products/:id/deactivate` | Product & pricing masters | `PRODUCT_MANAGE` | WRITE | activation state change | requireAdmin |
| 41 | POST | `/masters/products/:id/reactivate` | Product & pricing masters | `PRODUCT_MANAGE` | WRITE | activation state change | requireAdmin |
| 42 | GET | `/masters/batches` | Product & pricing masters | `BATCH_VIEW` | READ | read-only | requireAdmin |
| 43 | GET | `/masters/batches/:id` | Product & pricing masters | `BATCH_VIEW` | READ | read-only | requireAdmin |
| 44 | POST | `/masters/batches` | Product & pricing masters | `BATCH_CREATE` | WRITE | master-data change | requireAdmin |
| 45 | PUT | `/masters/batches/:id` | Product & pricing masters | `BATCH_EDIT` | WRITE | master-data change | requireAdmin |
| 46 | POST | `/masters/batches/:id/deactivate` | Product & pricing masters | `BATCH_MANAGE` | WRITE | activation state change | requireAdmin |
| 47 | POST | `/masters/batches/:id/reactivate` | Product & pricing masters | `BATCH_MANAGE` | WRITE | activation state change | requireAdmin |
| 48 | GET | `/masters/pricing` | Product & pricing masters | `PRICING_VIEW` | READ | read-only | requireAdmin |
| 49 | GET | `/masters/pricing/:id` | Product & pricing masters | `PRICING_VIEW` | READ | read-only | requireAdmin |
| 50 | POST | `/masters/pricing` | Product & pricing masters | `PRICING_CREATE` | WRITE | master-data change (FINANCIAL IMPACT: affects invoice values) | requireAdmin |
| 51 | PUT | `/masters/pricing/:id` | Product & pricing masters | `PRICING_EDIT` | WRITE | master-data change (FINANCIAL IMPACT: affects invoice values) | requireAdmin |
| 52 | POST | `/masters/pricing/:id/deactivate` | Product & pricing masters | `PRICING_MANAGE` | WRITE | activation state change | requireAdmin |
| 53 | GET | `/masters/taxes` | Product & pricing masters | `TAX_VIEW` | READ | read-only | requireAdmin |
| 54 | GET | `/masters/taxes/:id` | Product & pricing masters | `TAX_VIEW` | READ | read-only | requireAdmin |
| 55 | POST | `/masters/taxes` | Product & pricing masters | `TAX_CREATE` | WRITE | master-data change (FINANCIAL IMPACT: affects invoice values) | requireAdmin |
| 56 | PUT | `/masters/taxes/:id` | Product & pricing masters | `TAX_EDIT` | WRITE | master-data change (FINANCIAL IMPACT: affects invoice values) | requireAdmin |
| 57 | GET | `/distributors/lookups` | Distributors & retailers | `PARTY_VIEW` | READ | read-only lookups | requireAdmin |
| 58 | GET | `/distributors` | Distributors & retailers | `DISTRIBUTOR_VIEW` | READ |  | requireAdmin |
| 59 | POST | `/distributors` | Distributors & retailers | `DISTRIBUTOR_CREATE` | WRITE |  | requireAdmin |
| 60 | GET | `/distributors/:id` | Distributors & retailers | `DISTRIBUTOR_VIEW` | READ |  | requireAdmin |
| 61 | PUT | `/distributors/:id` | Distributors & retailers | `DISTRIBUTOR_EDIT` | WRITE |  | requireAdmin |
| 62 | GET | `/distributors/:id/retailers` | Distributors & retailers | `DISTRIBUTOR_VIEW` | READ |  | requireAdmin |
| 63 | POST | `/distributors/:id/status` | Distributors & retailers | `DISTRIBUTOR_MANAGE` | WRITE | status change blocks/permits trading | requireAdmin |
| 64 | GET | `/retailers/lookups` | Distributors & retailers | `PARTY_VIEW` | READ | read-only lookups | requireAdmin |
| 65 | GET | `/retailers` | Distributors & retailers | `RETAILER_VIEW` | READ |  | requireAdmin |
| 66 | POST | `/retailers` | Distributors & retailers | `RETAILER_CREATE` | WRITE |  | requireAdmin |
| 67 | GET | `/retailers/:id` | Distributors & retailers | `RETAILER_VIEW` | READ |  | requireAdmin |
| 68 | PUT | `/retailers/:id` | Distributors & retailers | `RETAILER_EDIT` | WRITE |  | requireAdmin |
| 69 | POST | `/retailers/:id/status` | Distributors & retailers | `RETAILER_MANAGE` | WRITE | status change | requireAdmin |
| 70 | POST | `/retailers/:id/assign` | Distributors & retailers | `RETAILER_MANAGE` | WRITE | re-assigns retailer between distributors | requireAdmin |
| 71 | GET | `/schemes/lookups` | Product & pricing masters | `SCHEME_VIEW` | READ |  | requireAdmin |
| 72 | POST | `/schemes/evaluate` | Product & pricing masters | `SCHEME_VIEW` | WRITE | non-mutating evaluation | requireAdmin |
| 73 | GET | `/schemes` | Product & pricing masters | `SCHEME_VIEW` | READ |  | requireAdmin |
| 74 | POST | `/schemes` | Product & pricing masters | `SCHEME_CREATE` | WRITE |  | requireAdmin |
| 75 | GET | `/schemes/:id` | Product & pricing masters | `SCHEME_VIEW` | READ |  | requireAdmin |
| 76 | PUT | `/schemes/:id` | Product & pricing masters | `SCHEME_EDIT` | WRITE |  | requireAdmin |
| 77 | POST | `/schemes/:id/status` | Product & pricing masters | `SCHEME_APPROVE` | WRITE | activation affects discounts / claims | requireAdmin |
| 78 | GET | `/claims/lookups` | Claims | `CLAIM_VIEW` | READ | read-only | requireAdmin |
| 79 | GET | `/claims` | Claims | `CLAIM_VIEW` | READ | read-only | requireAdmin |
| 80 | GET | `/claims/:id` | Claims | `CLAIM_VIEW` | READ | read-only | requireAdmin |
| 81 | POST | `/claims/:id/review` | Claims | `CLAIM_EDIT` | WRITE | workflow step; business may map to APPROVE | requireAdmin |
| 82 | POST | `/claims/:id/approve` | Claims | `CLAIM_APPROVE` | WRITE | decision on a claim | requireAdmin |
| 83 | POST | `/claims/:id/reject` | Claims | `CLAIM_APPROVE` | WRITE | decision on a claim | requireAdmin |
| 84 | POST | `/claims/:id/needs-correction` | Claims | `CLAIM_APPROVE` | WRITE | decision on a claim | requireAdmin |
| 85 | POST | `/claims/:id/settle` | Claims | `CLAIM_SETTLE` | WRITE | FINANCIAL: settlement / credit | requireAdmin |
| 86 | GET | `/accounts/lookups` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 87 | GET | `/accounts/summary` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 88 | GET | `/accounts/outstanding` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 89 | GET | `/accounts/ageing` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 90 | GET | `/accounts/ledger` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 91 | GET | `/accounts/credit` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 92 | PUT | `/accounts/credit/:entityId` | Payments & accounts | `CREDIT_LIMIT_MANAGE` | WRITE | FINANCIAL: changes credit limit | requireAdmin |
| 93 | GET | `/accounts/open-invoices` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 94 | GET | `/accounts/payments` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 95 | POST | `/accounts/payments` | Payments & accounts | `PAYMENT_POST` | WRITE | FINANCIAL: records payment and allocates to invoices | requireAdmin |
| 96 | GET | `/accounts/payments/:id` | Payments & accounts | `ACCOUNT_VIEW` | READ | read-only | requireAdmin |
| 97 | GET | `/erp-integrations/lookups` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 98 | GET | `/erp-integrations/health/readiness` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 99 | GET | `/erp-integrations` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 100 | POST | `/erp-integrations` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 101 | GET | `/erp-integrations/:id` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 102 | PUT | `/erp-integrations/:id` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 103 | PATCH | `/erp-integrations/:id/status` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 104 | PATCH | `/erp-integrations/:id/default` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 105 | POST | `/erp-integrations/:id/test` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 106 | GET | `/erp-integrations/:id/mappings/:capability` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 107 | PUT | `/erp-integrations/:id/mappings/:capability` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 108 | GET | `/erp-sync/summary` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 109 | GET | `/erp-sync/jobs` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 110 | POST | `/erp-sync/jobs` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 111 | GET | `/erp-sync/jobs/:id` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 112 | GET | `/erp-sync/jobs/:id/errors` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 113 | POST | `/erp-sync/jobs/:id/retry` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 114 | GET | `/erp-sync/errors` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 115 | GET | `/erp-sync/schedules` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 116 | GET | `/erp-sync/schedules/:id` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 117 | POST | `/erp-sync/schedules/:id/run` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 118 | PUT | `/erp-integrations/:id/schedules/:capability` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 119 | GET | `/erp-sync/audit` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 120 | GET | `/erp-sync/alerts` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 121 | GET | `/erp-integrations/:id/code-mappings` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 122 | PUT | `/erp-integrations/:id/code-mappings` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 123 | DELETE | `/erp-integrations/:id/code-mappings/:mappingId` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 124 | POST | `/erp-sync/outbound` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 125 | GET | `/erp-sync/outbound` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 126 | GET | `/erp-sync/business/overview` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 127 | POST | `/erp-sync/reconciliation` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
| 128 | GET | `/erp-sync/reconciliation` | ERP Integration | `existing ERP_* (unchanged)` | - | already enforced by erpPermission() | requireAdmin+erpPermission |
