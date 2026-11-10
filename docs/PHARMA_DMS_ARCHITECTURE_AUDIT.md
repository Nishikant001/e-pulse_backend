# Pharma DMS — Phase 1 Architecture Audit

| | |
|---|---|
| **Scope** | Phase 1 only: audit + safe, non-breaking preparation. No pharma features built. |
| **Sources kept separate** | Business = senior's Pharma DMS document · Technical = existing ZIPs · Visual = standalone Pharma DMS demo |
| **Audited** | `secondary_backend_updated.zip`, `secondary_frontend_updated.zip` |
| **Companion doc** | `PHARMA_DMS_MODULE_MAPPING.md` |

> **Verification status (read first).** The audit sandbox had no access to the npm registry (HTTP 403), so dependencies could not be installed. Therefore the frontend was **not built**, the backend was **not started**, and the Jest suite was **not run**. The only automated check performed on Phase 1 code changes is `node --check` (syntax) on every backend file, plus a crude bracket-balance check on edited frontend files. Section 17 gives the exact commands to verify locally. Nothing in this document should be read as "tested at runtime".

> **Business-document caveat.** The senior's requirements document was **not** available to the auditor. Requirement mapping (section 8) is built from the module list in the Phase 1 brief. Every pharma business rule (scheme logic, claim rules, price structure, SAP field mapping, expiry policy) must be validated against that document before Phase 2 design.

---

## 1. Current Architecture

Two independent applications, one implicit tenant model.

```
┌────────────────────────────┐         ┌───────────────────────────────┐
│ secondary_frontend         │  HTTP   │ secondary_backend             │
│ React 19 + Vite 7          │ ──────► │ Express 5 + Sequelize 6       │
│ Tailwind 4, React Router 7 │  JSON   │ MySQL (mysql2)                │
│ port 5173                  │ cookies │ port 5000, all routes → /api  │
└────────────────────────────┘         └───────────────────────────────┘
```

**Tenant model.** The `Distributor` row is *both* the tenant and the login identity. Every business table carries `distributor_id` (FK to `Distributor.id`), except the accounting tables (`GLMaster`, `JournalEntry`) which are keyed by `distributor_code` (string). There is no separate user, role, admin or retailer identity.

**Stack detail**

| Layer | Technology |
|---|---|
| Frontend runtime | React 19, Vite 7, `@tailwindcss/vite` (Tailwind 4), react-router-dom 7 |
| Frontend libs used | recharts (Dashboard only), framer-motion (Sidebar only), lucide-react |
| Frontend libs installed but **unused** | html2pdf.js, jspdf, pdfmake, qrcode.react, react-qr-code |
| Backend runtime | Express 5, Sequelize 6 + mysql2, jsonwebtoken, bcryptjs, cookie-parser, cors, multer, xlsx, nodemailer, dotenv |
| Tests | Jest + supertest, in-memory sqlite (6 files, ~106 test cases) |
| Not present | helmet, rate limiter, validation library (Joi/zod/express-validator), logger, ORM-level audit hooks, job scheduler, TypeScript |

## 2. Frontend Structure

```
src/
  main.jsx, App.jsx           # BrowserRouter + all routes in one file
  routes/ProtectedRoute.jsx   # NEW in Phase 1 (UX gate only)
  utils/authFetch.js          # fetch wrapper: cookies + 401→refresh→retry (used by ~30 pages)
  utils/api.js                # axios instance (no importers — effectively dead)
  components/Distributers/
    credential/               # Login, Signup, ForgotPassword, ResetPassword
    dashboard/
      DashboardLayout.jsx, Sidebar.jsx, Header
      pages/                  # ~25 master/transaction screens
      pages/delivery/{sodelivery,podelivery}/
      accounts/               # GL master, ledgers, trial balance, balance sheet, payments
```

**Routing.** Public: `/`→redirect to `/login`, `/login`, `/signup`, `/forgot-password`, `/reset-password`. Private: everything under `/dashboard/*` rendered inside `DashboardLayout` (now wrapped by `ProtectedRoute`). Legacy/broken routed pages (not in the sidebar): `/dashboard/delivery`, `/dashboard/invoice/creation`, `/dashboard/invoice/view`.

**Auth in the UI.** Login posts credentials with `credentials: "include"`; server sets httpOnly cookies. UI stores the returned distributor profile in `localStorage["user"]`. `authFetch` retries once after `POST /refresh-token` on 401, then clears `user` and redirects to `/login`.

**State management.** None global. Local `useState` only (large pages carry ~19–21 state hooks). No context, store, or data-fetching cache.

**Forms / tables / modals.** All hand-rolled controlled forms; hand-rolled tables (12 pages wrap with `overflow-x-auto`); ~16 files implement their own `fixed inset-0` modal; status badges re-implemented per page (`DeliveryPage`, `Podel`, `StockMaster`, others inline).

**Charts.** Recharts on Dashboard only. The four KPI counts come from real endpoints; the change percentages ("+12%"), monthly-orders chart, stock-distribution chart ("Steel Rods", "Cement Bags") and customer-growth chart are **hardcoded generic ERP demo data**.

**Styling.** Tailwind utility classes throughout (no Bootstrap). `index.css` only imports Tailwind; `App.css` is empty. Colour usage is inconsistent: blue dominant (~186 uses), then purple (~82), indigo (~48), emerald (~31), teal (~21, login screens).

**Responsiveness.** Sidebar is `fixed w-64` with a fixed content offset and no mobile collapse. Breakpoint utilities are sparse (`md:` 57, `lg:` 9, `sm:` 5 across the dashboard). The dashboard is effectively desktop-only today.

**Other observations.** 0 uses of `React.lazy`/`Suspense` (single bundle); no error boundary; no PropTypes/TypeScript; ~103 `alert()`/`confirm()` calls used for feedback; 13 files hardcode `http://localhost:5000`; `ProductMaster.jsx` is an orphan (not imported); `assets/credentials/login.png` and `signup.png` (~160 KB) are not referenced by any component.

## 3. Backend Structure

```
server.js                     # Express bootstrap, CORS (localhost:5173), cookie-parser, mounts /api
config/{db,dbSync}.js         # Sequelize + dev-only sync switches (DB_SYNC / DB_FORCE / DB_ALTER)
routes/allRoutes.js           # ONE file, ~147 routes
middleware/auth.js            # JWT from cookie or Bearer header → req.user
middleware/upload.js          # unused (controllers create their own multer instance)
controllers/                  # ~28 files (delivery.controller.js and invoice.controller.js are dead)
services/                     # inventory, batchAllocation (deprecated shim), pricing, tax, accounting, returnableQuantity
models/                       # 34 registered models + 2 unregistered legacy (delivery, invoice)
migrations/                   # 24 files: 5 createTable, 19 alterations (no baseline — see §4)
tests/                        # Jest
```

**Strengths worth preserving**

- `inventory.service`: stock is **derived from `StockLedger`**, FEFO allocation, row locking, idempotency index on movements.
- `pricing.service` (customer-group + validity resolution), `tax.service` (CGST/SGST vs IGST, rounding), `returnableQuantity.service` (prevents over-return).
- Document lifecycle with per-line delivered/invoiced quantity tracking; controllers for orders/deliveries/invoices/returns use DB transactions.
- Tenant scoping is generally correct in transaction controllers and services (exceptions fixed in Phase 1, see §10).

**Weaknesses:** single 147-route file; no validation layer; no central error handler (each handler returns `error.message`); no logging framework; no scheduler (batch-expiry job exists but is never invoked); no request IDs/audit trail.

## 4. Database Structure

34 registered Sequelize models. Tenant root: **Distributor**.

| Category | Models |
|---|---|
| Authentication | `Distributor` (holds `password`, `reset_otp`, `reset_otp_expiry`) — no other identity table |
| Masters | `Product`, `Customer`, `Address`, `Vendor`, `CustomerGroup`, `VendorGroup`, `ItemGroup`, `HSNGroup` |
| Pricing / Tax | `PricingMaster` (product × customer group × validity), `HSNGroup.gst_rate`, `Product.{gst,cgst,sgst,igst}` |
| Inventory / Batch | `Batch` (batch_no, mfg_date, exp_date, purchase_price, status active/inactive, life_remaining), `StockLedger` (signed movements, reference type/id, idempotency) |
| Sales | `SalesOrderHeader/Line`, `SalesDeliveryHeader/Line`, `SalesInvoiceHeader/Line`, `SalesCreditNote(+Line)`, `SalesDebitNote`, `SalesReturn(+Line)` |
| Purchase | `PurchaseOrderHeader/Line`, `PurchaseDeliveryHeader/Line`, `PurchaseInvoiceHeader/Line`, `PurchaseReturn(+Line)`, `PurchaseDebitNote` |
| Accounting | `GLMaster`, `JournalEntry` |
| Payments | **No table.** Customer/vendor payments are written only as `JournalEntry` rows (`CUSTOMER_PAYMENT`, `VENDOR_PAYMENT`) |
| Audit | **None** (only `StockLedger.created_by`) |

**Dependency map (simplified)**

```
Distributor ─┬─ Product ── Batch ── StockLedger
             │     └─ HSNGroup, ItemGroup
             ├─ Customer ── Address ; CustomerGroup ── PricingMaster ── Product
             ├─ Vendor ── Address ; VendorGroup
             ├─ SalesOrderHeader ── SalesOrderLine ── Product
             │        └─ SalesDeliveryHeader ── SalesDeliveryLine ── Batch  (stock OUT, FEFO)
             │                └─ SalesInvoiceHeader ── SalesInvoiceLine     (POSTED → JournalEntry)
             │                         └─ SalesCreditNote / SalesDebitNote
             ├─ SalesReturn ── SalesReturnLine (stock IN, batch-wise)
             ├─ Purchase* (mirror of the sales chain, stock IN)
             └─ GLMaster ── JournalEntry  (keyed by distributor_code)
```

**Database findings**

1. **Migrations cannot rebuild the schema.** Only 5 of 24 migrations create tables; base tables originate from `sequelize.sync()`. A fresh environment cannot be created from migrations alone.
2. **Business codes are global, short, and hook-generated.** `material_code`, `customer_code`, `vendor_code`, `distributor_code` are `STRING(6)`, `unique` across *all tenants*, generated in `beforeCreate` hooks as prefix + 3 digits by reading the last row. They overflow after 999 records system-wide (`MTC1000` is 7 chars) and are race-prone. `SalesOrderHeader.order_number` is globally unique while invoice numbers are per-distributor — inconsistent.
3. **Tenant key inconsistency:** `distributor_id` (business tables) vs `distributor_code` (accounting).
4. **`ON DELETE CASCADE` from `Customer` to sales documents** — deleting a customer can remove financial documents. Should become restrict/soft-delete before pharma data (retailers with invoices) exists.
5. **`JournalEntry` has no voucher/transaction group id** — balanced-entry validation and reversal rely on `reference_type + reference_no`.
6. **Payments are not allocated to invoices.** `SalesInvoiceHeader.outstandingAmount` is set at posting and never reduced; status values `PARTIALLY_PAID`/`PAID` exist but no code sets them.
7. **No chart-of-accounts seeding on signup.** Invoice posting needs 7 canonical GL accounts to exist; a new distributor gets "GL not configured" until they are created manually.
8. **No COGS/inventory valuation entries** — sales posting is Dr Receivable / Cr Sales / Cr Output GST only.
9. `Batch` has no unique constraint on (distributor, product, batch_no); no MRP/PTR/PTS fields.
10. Two unregistered legacy models (`delivery.model.js`, `invoice.model.js`) — dead.

**Phase 1 rule honoured:** no tables dropped, no data touched, no migration added or run. `.env` currently has `DB_SYNC=false`, `DB_FORCE=false`, `DB_ALTER=false` (safe). `DB_FORCE=true` would drop all tables in development mode — do not enable.

## 5. Authentication Architecture

**As-is (Distributor only)**

| Aspect | Current behaviour |
|---|---|
| Identity | `Distributor` (email + bcrypt password, cost 10) |
| Signup | Public, creates a new tenant |
| Login | `POST /api/login` → sets `accessToken` (httpOnly, 15 min cookie) and `refreshToken` (httpOnly, 7 day cookie) |
| JWT | Payload `{id, email, name, distributor_code}`; access expiry 1 d, refresh 30 d; **same secret and same payload** |
| Middleware | `authMiddleware` accepts cookie or `Authorization: Bearer`; sets `req.user`; **no role, no portal claim** |
| Refresh | `POST /api/refresh-token` |
| Logout | `POST /api/logout` clears cookies (UI logout page did not call it before Phase 1) |
| Forgot / reset | `POST /forgot-password` (emails 6-digit OTP), `/verify-otp`, `/reset-password` |
| Authorization | Tenant scoping by `req.user.id`; no roles |

**Target boundary (prepared, not built)**

```
/admin/*        Admin login   → AdminUser  (roles: Super Admin, Company Admin, Sales Manager, Accounts, Auditor, …)
/distributor/*  EXISTING Distributor login (unchanged) → Distributor owner + DistributorUser (Sales Rep, Accounts, Warehouse, Auditor, Distributor User)
/retailer/*     Retailer login (future) → RetailerUser
```

Design rules for the extension (all additive):

1. **Keep** `/api/login`, `/signup`, `/forgot-password`, `/verify-otp`, `/reset-password`, `/refresh-token`, `/logout` and the `Distributor` table exactly as they are. A token without a `portal` claim is treated as `portal=distributor`.
2. New portals get **separate token audiences** (`portal` claim), **separate cookie names**, **separate identity tables**, and **separate middleware** (`requirePortal('admin')`, `requireRole([...])`). An admin token must never satisfy `requirePortal('distributor')` and vice-versa.
3. Add a token-type claim (`typ: access|refresh`) for *new* tokens and use a distinct refresh secret; keep accepting legacy tokens until they expire.
4. Roles → permissions via a table (`Role`, `Permission`, `RolePermission`) instead of hard-coded checks. The distributor owner maps to an implicit "Distributor Admin" role.
5. Frontend: three route groups, each with its own guard and layout; `/dashboard/*` stays as-is and later becomes an alias of `/distributor/*`.

**Role readiness**

| Role | Portal | Today |
|---|---|---|
| Super Admin, Company Admin, Sales Manager | Admin | Missing (no admin identity) |
| Accounts User, Auditor | Admin and/or Distributor | Missing |
| Distributor Sales Representative, Warehouse User | Distributor | Missing (only the owner logs in) |
| Distributor User | Distributor | **Exists** as the single distributor login (implicitly full access) |
| Retailer User | Retailer | Missing (`Customer` has no credentials) |

## 6. Existing Distributor Flow

**Setup prerequisites** (manual): HSN groups → item groups → customer/vendor groups → products (+ batches) → customers/vendors → pricing per customer group → 7 GL accounts.

**Order-to-cash**

```
Sales Order (DRAFT → CONFIRMED)
  → Sales Delivery (stock OUT, FEFO batch allocation, at creation; order → PARTIALLY/FULLY_DELIVERED)
    → Sales Invoice (DRAFT → POSTED: Dr Receivable, Cr Sales, Cr Output GST)
      → Credit/Debit Note
  → Sales Return (stock IN into the original batch, returnable-qty controlled) → Credit Note
  → Customer Payment (journal only; not allocated to invoices)
```

**Procure-to-pay** mirrors this: Purchase Order → Purchase Delivery (stock IN, creates batches) → Purchase Invoice (Dr Purchase/Input GST, Cr Payable) → Purchase Return / Debit Note → Vendor Payment.

**Reports available:** stock (current, batch-wise, ledger), customer/vendor ledger, trial balance, balance sheet.

## 7. Existing Reusable Modules

See `PHARMA_DMS_MODULE_MAPPING.md` for the full table. Highest-value reuse: inventory ledger + FEFO + batch model, order/delivery/invoice chain, returnable-quantity control, pricing resolution, tax computation, GL/journal engine, group masters, bulk-upload plumbing (after fixes), `authFetch` wrapper, Sidebar/Layout shell (visual redesign later).

## 8. Pharma Requirement Mapping

Status legend: **Reusable** (as-is or light extension) · **Partial** (exists, pharma gaps) · **Redesign** · **Missing** · Phase = target phase from §15. Full row-level detail is in the mapping document.

| Requirement | Existing | Status | Phase |
|---|---|---|---|
| Dashboard | 4 real counts + demo charts | Partial / Redesign | 3 |
| Sales Orders | SalesOrder* | Reusable | 5 |
| Sales Invoices | SalesInvoice* | Reusable | 5 |
| Secondary Sales | Distributor→Customer chain | Partial | 5 |
| Sales Returns | SalesReturn* + returnable qty | Reusable | 6 |
| Credit Notes | SalesCreditNote | Reusable | 6 |
| Inventory / Batch / FEFO | StockLedger, Batch, FEFO service | Reusable | 4–5 |
| Expiry Management | `exp_date`, auto-inactive; job unscheduled | Partial | 4 |
| Product Master | Product/MaterialMaster | Partial | 4 |
| Distributor Master | Distributor (self-signup) | Partial | 3 |
| Retailer Master | Customer | Partial | 3 |
| Pricing Master | PricingMaster | Partial | 4 |
| Scheme Master | — | Missing | 4 |
| Tax Master | HSNGroup + product rates | Partial | 4 |
| Distributor / Retailer Management (admin) | — | Missing | 3 |
| Schemes / Claims | — | Missing | 4 / 6 |
| Accounts | GL, journal, ledgers, TB, BS | Partial | 7 |
| SAP Integration / Sync / Jobs / Failed Txns / API Monitor | — | Missing | 9 |
| Reports | stock, ledgers, TB, BS | Partial | 8 |
| Notifications | — | Missing | 8 |
| Audit Logs | — | Missing | 2 |
| Settings | — | Missing | 3 |
| RBAC | — | Missing | 2 |

## 9. Missing Modules

RBAC and multi-identity auth · Admin portal and distributor onboarding/approval · Retailer portal and retailer credentials · Scheme master and scheme application engine · Claims · Pharma product attributes (composition, schedule, pack, MRP/PTR/PTS) · Expiry alerts and expired/quarantine stock states · Payment receipts with invoice allocation, ageing, financial-year handling · Audit log · Notification system · Settings · SAP outbox, sync jobs, failed-transaction queue, API monitor · Reporting layer · Number-sequence service · Job scheduler.

**Future tables (documented only — none created in Phase 1):** `AdminUser`, `DistributorUser`, `RetailerUser`, `Role`, `Permission`, `RolePermission`, `AuditLog`, `Scheme`, `SchemeSlab`, `Claim`, `ClaimLine`, `Notification`, `PaymentReceipt`, `PaymentAllocation`, `FinancialYear`, `NumberSequence`, `Setting`, `SapOutbox`, `SapSyncJob`, `ApiLog`, `StockStatus`/quarantine, and pharma attribute columns/table for `Product` and `Batch`.

## 10. Security Audit

Severity: **Critical / High / Medium / Low / Info**. "Fixed" means changed in Phase 1 **and not runtime-tested** (see verification note).

| ID | Sev | Finding | Status |
|---|---|---|---|
| S-01 | **Critical** | **Cross-tenant access.** `Customer` and `Vendor` `getOne/update/delete/addresses/by-code` used `findByPk(id)` with no owner check. Any authenticated distributor could read, edit, delete another's records (delete cascades to orders) and reassign `distributor_id` via update body. | **Fixed** (scoped by `req.user.id`) |
| S-02 | **Critical** | Backend ZIP contains a real-looking `.env` (DB, JWT, Gmail app password); no `.gitignore`. | **Partial:** `.gitignore` + `.env.example` added; `.env` untouched. **Owner must rotate all secrets.** |
| S-03 | High | No rate limiting or lockout on login, forgot-password, verify-otp, reset-password. | Open |
| S-04 | High | OTP uses `Math.random`, stored in plaintext, no attempt limit; 6 digits is brute-forceable without S-03. | Open |
| S-05 | High | Access and refresh tokens share secret and payload → 30-day refresh token is accepted as a Bearer access token; no revocation/rotation; cookie lifetimes (15 min / 7 d) differ from JWT lifetimes (1 d / 30 d). | Open (changing it alters auth flow — deferred) |
| S-06 | High | `xlsx` 0.18.5 (last npm release) has known advisories (prototype pollution, ReDoS; fixed only in non-npm builds). Parsing user-uploaded spreadsheets while signup is open. *Verify with `npm audit`.* | Open |
| S-07 | High | Upload endpoints have no file-type or size limits (`multer({dest})`). | Open |
| S-08 | High | No role model — every authenticated distributor has full access; nothing prevents future admin endpoints being reachable by distributor tokens. | Open (Phase 2 design) |
| S-09 | Medium | Mass assignment on update: `update(req.body)` in customer, vendor, product, pricing allowed changing `distributor_id`, ids, codes; pricing accepted cross-tenant `productId`/`customer_group_id`. | **Fixed** (protected fields stripped; references ownership-checked) |
| S-10 | Medium | Public signup creates tenants without approval (spam / fake distributors). | Open |
| S-11 | Medium | No security headers (helmet); CORS origin hardcoded to `http://localhost:5173`. | Open |
| S-12 | Medium | ~64 handlers return raw `error.message` (leaks Sequelize/SQL detail). No central error handler. | Open |
| S-13 | Medium | User enumeration: forgot-password returns "Email not found"; signup returns "Email already registered". | Open |
| S-14 | Medium | No server-side validation layer; password strength/email format not enforced server-side. | Open |
| S-15 | Medium | Uploaded temp files are kept on error paths; 14 spreadsheets were shipped in the ZIP (`uploads/`). | Partial (`uploads/*` gitignored) |
| S-16 | Medium | No frontend route guard on `/dashboard/*`; logout page did not clear httpOnly cookies. | **Fixed** (guard is UX-only; backend remains the boundary) |
| S-17 | Low | Full distributor profile (incl. tax/PAN/phone) stored in `localStorage`; login screen logged the user object and an undefined `token` to the console. | Console logging **fixed**; localStorage storage open |
| S-18 | Low | `bcryptjs` cost 10 (acceptable; consider 12). No password-change/reset session invalidation (stateless JWT). | Open |
| S-19 | Low | Print windows use `document.write` with `innerHTML` copied from already-escaped React DOM — low XSS risk; review when print templates are redesigned. | Open |
| S-20 | Low | CSRF: cookies are `sameSite=lax` and APIs are JSON; acceptable for same-site. Cross-site production hosting will need explicit cookie/CORS design. | Info-level design note |
| S-21 | Info | No raw SQL/`literal()` found; all queries via ORM (SQL injection surface low). | Positive |
| S-22 | Info | `JWT_SECRET` length adequate; password hashes and OTP fields are excluded from login responses; `.env` `DB_FORCE/DB_SYNC/DB_ALTER` are `false`. | Positive |

## 11. SEO Audit

| Item | Before Phase 1 | After Phase 1 |
|---|---|---|
| `<title>` | "Vite + React" | "Pharma DMS \| Pharmaceutical Distributor Management System" |
| Meta description | none | added |
| `theme-color` | none | added |
| `robots.txt` | none | added: disallows `/dashboard`, `/admin`, `/distributor`, `/retailer`, `/reset-password`, `/forgot-password` |
| Canonical / Open Graph / sitemap | none | **Not added** — need a real domain and a public landing page |
| Favicon | Vite default | unchanged |

**Public pages today:** `/login`, `/signup`, `/forgot-password`, `/reset-password` only. There is no landing, help, or documentation page. All content is client-rendered by a single SPA shell.

**Recommendations (deferred):** build the public landing as a separate static/prerendered site (or SSG) rather than inside the dashboard SPA; per-route titles via `react-helmet-async`; keep all portals `noindex` (add `X-Robots-Tag: noindex` at the hosting layer for `/dashboard`, `/admin`, `/distributor`, `/retailer`); add OG image and canonical once the domain is known; semantic landmarks (`header/nav/main`) on auth pages; alt text when images are introduced (the two login images are currently unused); code-split routes (`React.lazy`) and remove unused libraries for Core Web Vitals; make the dashboard responsive (mobile sidebar). No effort was spent on dashboard SEO by design.

## 12. Technical Debt

- Duplicate/dead code: `delivery.controller.js`, `invoice.controller.js`, `delivery.model.js`, `invoice.model.js`, `middleware/upload.js`, `utils/sendEmail.js` (auth controller creates its own transporter), `utils/api.js`, `ProductMaster.jsx`, deprecated `batchAllocation.service` shim.
- Broken: product bulk upload (writes `quantity`/`price`/`status:"available"` that `Batch` doesn't have; quantity silently dropped, no ledger entry); stock bulk upload (`material_code` undefined, route shadowed by `/stock/:id`, no multer middleware); legacy pages `/dashboard/delivery`, `/invoice/creation`, `/invoice/view` (call removed `/api/delivery`, `/api/invoice`, read a `token` never set).
- Missing endpoints: no update route for `/hsn`, `/itemgroup`, `/vendorgroup` (create/list/delete/bulk only); sales returns cannot be edited or deleted (only posted or cancelled).
- Unscheduled: `updateExpiredBatches` job. FEFO ordering puts NULL expiry first on MySQL.
- Unused dependencies (5) and unused assets (2 PNGs).
- Hardcoded: API base URL in 13 files (helper + env var added, files not yet migrated), demo dashboard data, business defaults.
- Very large components (2,000+ lines, ~20 state hooks) mixing fetching, forms, modals and print templates; no shared table/modal/badge/form components.
- No loading/empty/error-state consistency (`alert()` for errors); no validation library; no central error middleware; single 147-route file.
- Two API client styles (fetch wrapper vs axios); two tax paths (sales uses product rates, purchase uses HSN rate).

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Credentials leaked via shared ZIP | Full DB/mail compromise | Rotate now; never share `.env` |
| 999-record global code cap | Inserts fail or duplicate codes in production | `NumberSequence` service (per tenant/entity) before onboarding more distributors |
| Auth changes break existing Distributor login | Lockout of live users | Additive claims only; legacy tokens accepted; keep endpoints |
| Cascade deletes on financial docs | Data loss | Restrict/soft-delete before pharma data |
| Unallocated payments | Wrong outstanding, no ageing, blocks claims/credit control | `PaymentAllocation` in accounts phase |
| Phase 1 code changes untested | Regression | Run §17 checks before merging |
| Tenant IDOR elsewhere | Data exposure | Phase 1 reviewed customer/vendor/product/pricing and the services; add automated cross-tenant tests for **every** controller in Phase 2 |
| Senior's document not yet mapped | Wrong pharma rules | Validate matrix against the document first |
| Visual reference not yet applied | Rework | Take design tokens from the demo in Phase 3, not before |

## 14. Recommended Future Architecture

**Backend** — keep Express/Sequelize; evolve in place:

```
routes/
  legacy.routes.js        # today's /api/* (unchanged paths)
  admin/  distributor/  retailer/   # new, namespaced, each behind requirePortal()
middleware/  auth.js (legacy) · portalAuth.js · requireRole.js · validate.js · errorHandler.js · rateLimit.js
services/    (existing) + numberSequence · audit · scheme · claim · payment · sapOutbox
jobs/        batchExpiry · sapSync · notifications
```

Introduce, in order: central error handler + validation → audit log → identities/RBAC → number sequences → payment allocation. SAP integration uses an **outbox pattern** (`SapOutbox` rows written in the same transaction as the business document; a worker sends with idempotency keys; failures land in the failed-transaction queue; API monitor reads `ApiLog`).

**Frontend** — no mass file moves in Phase 1. Target layout for later phases:

```
src/portals/{admin,distributor,retailer}/   # routes + pages per portal
src/shared/{ui,api,auth,hooks,utils}/       # design-system components (Table, Modal, StatusBadge, FormField)
```

`components/Distributers` becomes `portals/distributor` via a scripted move with import rewrite, done only after regression tests exist. Visual system: Premium Pharmaceutical Enterprise SaaS (light, professional blue, subtle gradients, rounded cards, enterprise tables) taken from the standalone demo.

**Multi-tenant integrity:** central `scopeToDistributor(model)` helper (or a Sequelize default scope) so tenant filtering isn't hand-written per query; automated cross-tenant test per controller.

## 15. Phase-wise Implementation Dependencies

Indicative — to be confirmed against the senior's document.

| Phase | Theme | Depends on | Key deliverables |
|---|---|---|---|
| 2 | **Foundation & security** | Phase 1, secret rotation | Error handler + validation, rate limiting/helmet, refresh/access token separation (additive), audit log, identity tables + RBAC middleware, number-sequence service, cross-tenant tests |
| 3 | **Admin portal shell + masters** | 2 | `/admin/*` layout, admin login, Distributor & Retailer masters/management, settings, design tokens from the demo |
| 4 | **Pharma masters** | 3 | Product pharma attributes, MRP/PTR/PTS, pricing master upgrade, tax master, scheme master, expiry policy/job |
| 5 | **Secondary sales** | 4 | Orders/invoices with schemes, credit limits, FEFO+expiry rules, retailer linkage |
| 6 | **Returns, credit notes, claims** | 5 | Return reasons, expiry/damage handling, claims |
| 7 | **Accounts** | 5–6 | Payment receipts + allocation, ageing, financial year, COGS/valuation decision |
| 8 | **Reports & notifications** | 4–7 | Report layer, expiry/low-stock/claim alerts |
| 9 | **SAP integration** | 5–7 | Outbox, jobs, failed-transaction queue, API monitor (needs SAP field mapping from business doc) |
| 10 | **Retailer portal** | 2, 5 | `/retailer/*`, retailer login, ordering |
| 11 | **UI rollout** | 3+ (parallel) | Migrate existing distributor screens to the new design system, responsive layout |

Phase 2 recommendation: **Foundation & security** — it unblocks every later phase and closes the open High findings. Do not start it until requested.

## 16. Phase 1 Changes Made (all additive / non-breaking by intent)

**Backend**

| File | Change |
|---|---|
| `controllers/customer.controller.js` | Tenant-scoped `getOne`, `update`, `delete`, `getCustomerAddresses`, `getCustomerByCode`; open transaction rolled back on not-found in `update`; protected fields (`id`, `distributor_id`, `customer_code`, `addresses`, timestamps) stripped from update body |
| `controllers/vendor.controller.js` | Same set of fixes for vendors |
| `controllers/product.controller.js` | Protected fields stripped on update; HSN change validated to belong to the same distributor |
| `controllers/pricingmaster.controller.js` | Protected fields stripped on update; `productId` / `customer_group_id` validated as owned by the distributor on create and update |
| `.gitignore`, `.env.example`, `uploads/.gitkeep` | New. `.env` **not** modified |

**Frontend**

| File | Change |
|---|---|
| `src/routes/ProtectedRoute.jsx` (new) + `src/App.jsx` | Wraps `/dashboard` in a session gate (redirects to `/login` when no `user` in localStorage). UX only |
| `dashboard/pages/Logout.jsx` | Also calls `POST /logout` so httpOnly cookies are cleared |
| `credential/Login.jsx` | Removed console logs (one referenced an undefined `token`; one printed the user profile) |
| `utils/authFetch.js`, `utils/api.js` | `VITE_API_BASE_URL` support; default unchanged (`http://localhost:5000/api`); `API_BASE_URL` now exported |
| `index.html`, `public/robots.txt`, `.env.example` | SEO title/description/theme-color; robots rules; env example |

**Deliberately not changed:** Distributor login/signup/reset endpoints and payloads, token format, cookie settings, database schema/data, existing routes and API paths, business logic in services, all sales/purchase/inventory/accounting controllers.

## 17. Verification Status and How to Verify

**Done:** `node --check` on all backend files (pass); bracket-balance check on edited frontend files (pass, Login.jsx excluded — original also trips the crude tokenizer on JSX apostrophes). Static review of every diff.

**Not done (sandbox had no npm access):** `npm install`, backend start, frontend start, Vite build, ESLint, Jest, browser test.

Run locally:

```bash
# backend
cd secondary_backend && npm install && npm test && npm start        # keep your own .env
# frontend
cd secondary_frontend && npm install && npm run lint && npm run build && npm run dev
# read-only API smoke test (uses an existing test account; creates no data)
EMAIL=you@example.com PASSWORD='...' bash docs/scripts/phase1_smoke_test.sh
# optional cross-tenant check (needs a second test distributor)
EMAIL=... PASSWORD=... EMAIL2=... PASSWORD2=... bash docs/scripts/phase1_smoke_test.sh
npm audit        # in both projects; review xlsx advisory
```

**Manual UI pass:** log in → each sidebar item loads → Customer and Vendor create/edit/delete → product edit → pricing create/edit → open `/dashboard` in a private window (should redirect to `/login`) → Logout from the sidebar and from `/dashboard/logout` → back button shows login.

**Expected behavioural differences from before Phase 1** (all intentional): opening `/dashboard` without a login redirects to `/login`; `/dashboard/logout` now ends the server session; `customer_code`/`vendor_code`/`material_code`/`distributor_id` in an update body are ignored; pricing rows referencing another distributor's product/group are rejected with HTTP 400; changing a product's HSN to another tenant's HSN is rejected with 400.

## Appendix A — Regression Checklist

Tick each after the local run. "Touched" marks areas near Phase 1 edits.

| # | Area | Route / API | Check | Touched |
|---|---|---|---|---|
| 1 | Distributor login | `/login` · `POST /api/login` | Valid login → `/dashboard`; wrong password → error; cookies set | Login.jsx console logs only |
| 2 | Signup | `/signup` · `POST /api/signup` | New distributor created, code assigned | — |
| 3 | Forgot password | `/forgot-password` · `POST /api/forgot-password` | OTP email received | — |
| 4 | Verify OTP / Reset | `/reset-password` · `/verify-otp`, `/reset-password` | Password changes; can log in | — |
| 5 | Logout | Sidebar; `/dashboard/logout` · `POST /api/logout` | Redirect to login; `/dashboard` no longer loads; API returns 401 | **Yes** |
| 6 | Route guard | `/dashboard` in private window | Redirects to `/login` | **Yes (new)** |
| 7 | Dashboard | `/dashboard` · `/customer/count`, `/salesorder/count`, `/sales-delivery/count`, `/stock/count` | Four counts render | — |
| 8 | Sales order | `/dashboard/salesorder-master` · `/salesorder*` | Create, confirm, cancel, by-number | — |
| 9 | Delivery | `/dashboard/sales/delivery` · `/sales-delivery*` | Create from order; stock decreases FEFO | — |
| 10 | Invoice | `/dashboard/sales/invoice` · `/sales-invoice*` | Create, post; journal entries appear | — |
| 11 | Customer | `/dashboard/customer` · `/customer*` | List, create, **edit, delete**, by-code, addresses | **Yes** |
| 12 | Vendor | `/dashboard/vendor` · `/vendor*` | List, create, **edit, delete**, addresses | **Yes** |
| 13 | Product / Material | `/dashboard/material-master` · `/product*` | List, create, **edit** (incl. HSN change) | **Yes** |
| 14 | Pricing | `/dashboard/pricing` · `/pricing*` | **Create, edit**; invalid product rejected | **Yes** |
| 15 | Stock / Batch stock | `/dashboard/stock-master`, `/dashboard/inventory/current`, `/dashboard/inventory/batch` · `/stock*`, `/stockLedger/batch` | Batch list, counts | — |
| 16 | Stock ledger | `/dashboard/inventory/ledger` · `/stockLedger/ledger` | Movements match deliveries | — |
| 17 | Purchase | `/dashboard/purchase/po` → `/purchase/delivery` → `/purchase/invoice` · `/purchase-orders`, `/po-delivery`, `/po-invoice` | Stock IN, batches created | — |
| 18 | Returns | `/dashboard/sales/return`, `/dashboard/purchase/return` · `/sales-return`, `/purchase-return` | Returnable-qty enforced | — |
| 19 | Payments | `/dashboard/accounts/Payments` · `/payment` | Customer/vendor payment journals | — |
| 20 | Accounting | `/dashboard/accounts/{GLMaster,CustomerLedger,VendorLedger,TrialBalance,BalanceSheet}` · `/gl-master`, `/ledger/*`, `/trial-balance`, `/balance-sheet` | Totals balance | — |
| 21 | Cross-tenant (new) | second distributor requests first's `/customer/:id`, `/vendor/:id` | Expect **404** | **Yes** |
| 22 | Known-broken (baseline, not regressions) | `/dashboard/delivery`, `/invoice/creation`, `/invoice/view`, product & stock bulk upload | Already failing before Phase 1 | — |

## Appendix B — Safe Refactoring Plan (not executed)

1. Add automated tests first (tenant isolation per controller; sales chain; inventory).
2. Central `errorHandler` + `validate` middleware; replace `error.message` responses gradually.
3. Extract shared `Table`, `Modal`, `StatusBadge`, `FormField`, `ConfirmDialog`, `Toast` components and replace `alert()`.
4. Move API base URL usage to `API_BASE_URL`/`authFetch` in the 13 files still hardcoding it; delete `utils/api.js`.
5. Remove dead code (legacy controllers/models/pages, unused deps and assets) in a dedicated commit.
6. Split `allRoutes.js` into per-domain routers, keeping every path identical.
7. Introduce `NumberSequence`, then switch hook-based code generation.
8. Add a baseline migration snapshot so environments can be rebuilt.
9. Split 2,000-line pages into container + presentational components.
10. Only then move `components/Distributers` under `portals/distributor`.
