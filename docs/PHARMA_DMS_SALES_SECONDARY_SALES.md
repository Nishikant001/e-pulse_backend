# Pharma DMS — Sales & Secondary Sales (Phase 4)

| | |
|---|---|
| **Scope** | Admin: functional Sales Orders, Sales Invoices, Secondary Sales (`/admin/sales/*`). Returns and Credit Notes stay planned — the existing Distributor-side functionality is untouched and not rebuilt |
| **Not touched** | Distributor login and every Distributor screen; Phase 1–3 security fixes; the existing sales/delivery/invoice controllers, pricing, tax, inventory and accounting services — **all reused unchanged** |
| **New dependencies** | **None** |
| **Companion docs** | `PHARMA_DMS_ARCHITECTURE_AUDIT.md`, `PHARMA_DMS_MODULE_MAPPING.md`, `PHARMA_DMS_UI_UX_FOUNDATION.md`, `PHARMA_DMS_ADMIN_DASHBOARD.md` |

## 0. Verification status — read first

**Verified in the audit sandbox**

| Layer | Method | Result |
|---|---|---|
| Read queries (orders, invoices, secondary sales, lookups) | The **real** SQL from `services/adminSales.service.js` executed on SQLite, checked field-for-field against an **independently written** sample-mode implementation, across 111 filter/search/sort/page combinations | 32 / 32 checks pass — every list, every detail, every KPI, and the two implementations agree exactly |
| Preview, validation, stock/pricing rules, status transitions, tenant boundary, delegation to the existing controllers | Real service code against SQLite, with `pricing.service`/`tax.service` used unmodified and the existing controllers replaced by call-recording stand-ins | 45 / 45 checks pass |
| Full backend HTTP stack (`requireAdmin` → routes → controller → service) against a **live SQL-backed bridge**, driving the **real, built frontend bundle** in headless Chromium | 120 browser checks: orders list/filters/sort/paging/actions/drawer, create/edit, invoices (print/download/post/cancel), secondary sales (KPIs/charts/detail), sample mode, security boundary, tablet/mobile | 120 / 120 pass, **zero console errors** across every group |
| Regression | Same harnesses as Phases 1–3, re-run after Phase 4 | Phase 2 design-system suite 76/76, Phase 3 dashboard+distributor suite 87/87, Phase 1 route-guard/logout suite 4/4, all 38 pre-existing Distributor routes still render with no new console errors, Phase 3 backend harness 67/67 |
| Static | TypeScript parser + semantic check across all 176 frontend files, CSV export (formula-injection guard, RFC 4180 escaping) unit-tested, backend `node --check` on every new/changed file | 0 problems |

**NOT verified — please do before sign-off**

1. **`npm install`, `npm run build`, `npm run lint`, `npm test`, a real dev server, a real MySQL database: not run.** No registry access in the sandbox.
2. **Visual appearance is unverified.** All UI tests ran against small viewport-behaviour and DOM-content assertions with Recharts and lucide-react stubbed out — layout, spacing and chart rendering have not been seen.
3. **The SQL was executed on SQLite, not MySQL.** It was written to be portable (see §6) and reviewed by hand, but not run against MySQL 8 / mysql2 / Sequelize.
4. **The write path used a call-recording stand-in of the existing `salesOrder`/`salesdelivery`/`salesinvoice` controllers**, not the actual controller code, for the pure-JS harness; the **browser end-to-end suite** does run against small re-implementations of their effects on a live database (create, deliver with FEFO-by-expiry, invoice, post, cancel) — the goal was to prove the Admin layer calls the correct controller with the correct, whitelisted body, and that the resulting HTTP behaviour is correct, not to re-verify the internals of those controllers (already verified in Phase 1).
5. **Real accounting entries were not inspected.** Posting an invoice still calls the existing `salesinvoice.post`, which is documented (Phase 1) to write journal entries; this phase did not re-verify that GL logic.
6. **The senior's requirements document and the standalone demo were not provided.** Business assumptions (see §8, §13) need validation.
7. Load/performance testing was not done beyond a basic timing sanity check on the demo dataset (~2,300 rows across the sales tables).

Local verification checklist:

```bash
cd secondary_backend
# 1. run the new migration (additive only)
npx sequelize-cli db:migrate --config config/config.js
npm install && npm test && npm start
cd ../secondary_frontend && npm install && npm run lint && npm run build && npm run dev
# 2. Admin sales API boundary + reads (safe, read-only by default)
ADMIN_EMAIL=... ADMIN_PASSWORD='...' bash secondary_backend/docs/scripts/phase4_sales_smoke_test.sh
# add DIST_EMAIL/DIST_PASSWORD to prove a distributor session cannot read Admin sales data
# add CREATE=1 DISTRIBUTOR_ID=.. RETAILER_ID=.. PRODUCT_ID=.. to also create one throwaway DRAFT order (not confirmed)
```
Then in the browser: sign in to `/admin/login` → Sales Orders/Invoices/Secondary Sales load with real data → create a sales order (batch, quantity, discount) and confirm prices/GST/totals match what you'd expect from the pricing and tax setup → Confirm → Create Invoice → Post → check the resulting journal entries in Accounts (existing screens) → open Secondary Sales and confirm the new invoice appears → try the same flow at 1440/900/390 px.

## 1. Existing functionality audit — reused / modified / new

| Area | Reused (unchanged) | New (Phase 4) |
|---|---|---|
| Sales order create/update/confirm/cancel | `controllers/salesOrder.controller.js` — full state machine, transaction, per-distributor numbering | Called through `services/distributorContext.js` as the *target* distributor; nothing in the controller was edited |
| Delivery (stock out) | `controllers/salesdelivery.controller.js`, `services/inventory.service.js` (FEFO allocation, ledger, locking, idempotency) | "Create Invoice" from the Admin UI calls the same delivery-create endpoint for the order's remaining quantity |
| Invoice create/post/cancel | `controllers/salesinvoice.controller.js` — GST split, `netValue`/`cgstAmount`/`sgstAmount`, and (on post) the existing accounting journal entries | Called the same way; Admin never writes an invoice row directly |
| Pricing | `services/pricing.service.js` (`getFinalPriceForCustomer` — PricingMaster lookup by product × customer group × validity) | none — used exactly as-is for every price shown in preview, order, and invoice |
| Tax | `services/tax.service.js` (`computeLineTax`, `round2`) | wrapped by the new `services/salesLineCalc.service.js`, which reproduces the exact gross→discount→taxable→GST arithmetic `salesOrder.controller.js` already uses, so preview and detail views show the numbers the order will actually store |
| Batch/stock | `services/inventory.service.js` (`getAvailableBatches`, `getBatchAvailableQty`) | used for batch listing and preview-time stock validation; FEFO logic itself is untouched |
| Accounting | `services/accounting.service.js` (invoked internally by `salesinvoice.post`) | not modified; not called directly — Phase 4 never bypasses the invoice controller |
| Returns / Credit Notes | Existing Distributor-side screens and APIs, unchanged | none — deliberately left as an integration point (see §11); the Admin nav item stays "planned" |
| SAP status | *(none existed)* | new `sap_sync_records` table + read paths (see §12) — status only, no transmission |

No existing sales/order/invoice/pricing/tax/inventory/accounting file was rewritten. `diff` against the Phase 3 deliverable confirms `routes/allRoutes.js`, `controllers/salesOrder.controller.js`, `controllers/salesdelivery.controller.js`, `controllers/salesinvoice.controller.js`, `services/pricing.service.js`, `services/tax.service.js`, `services/inventory.service.js`, `services/accounting.service.js`, `services/batchAllocation.service.js`, `controllers/auth.controller.js`, `middleware/auth.middleware.js`, `controllers/customer.controller.js` and `controllers/vendor.controller.js` are byte-identical.

## 2. Architecture

```
Admin browser
   │  GET/POST /api/admin/sales/*   (httpOnly Admin cookie only)
   ▼
routes/adminRoutes.js  →  controllers/admin.sales.controller.js  (thin: parse request, map errors, no business logic)
   │                                   │
   │ reads                            │ actions
   ▼                                   ▼
services/adminSales.service.js   services/adminSalesOrder.service.js
  (cross-distributor SQL:            (validate → services/pricing.service + tax via
   list/detail/lookups/summary)       salesLineCalc.service + inventory.service
                                       → services/distributorContext.js
                                       → EXISTING salesOrder / salesdelivery / salesinvoice
                                       controllers, invoked as the order's own distributor)
```

`services/distributorContext.js` is the seam that lets Admin reuse tenant-scoped controllers safely: it loads the **target distributor from the database** (never from the client) and invokes the existing controller with a synthetic request whose `req.user` is that distributor — so every ownership check already inside those controllers (customer/product/batch/order/delivery/invoice belongs to `req.user.id`) applies unchanged, and their response is captured and mapped to an HTTP status/message for the Admin API.

`services/salesStatus.service.js` is the single source of truth for: the six presentation statuses (`draft/confirmed/processing/invoiced/cancelled/synced`), which document actions are allowed from which state, and the SAP-applicability rule. Both the SQL list queries and the JS detail/action code use it (or its SQL twin `ORDER_DISPLAY_SQL`), and the two were checked to agree on all 78 orders in the demo dataset.

## 3. Sales Order lifecycle

```
DRAFT ──confirm──► CONFIRMED ──(delivery, partial or full)──► PARTIALLY_DELIVERED / FULLY_DELIVERED ──(all invoiced)──► CLOSED*
  │                    │
  └──cancel──► CANCELLED ◄──cancel──┘
```
\* `CLOSED` is set by existing logic on some fully-delivered-and-invoiced orders; both `CLOSED` and a fully-delivered order with no un-invoiced delivery display as **Invoiced**.

Presentation status (what the UI shows) vs. actions allowed, decided once in `salesStatus.service.js` and returned by the API as `status` + `actions` — the frontend never re-derives them:

| Raw status | Display | Allowed actions |
|---|---|---|
| `DRAFT` | Draft | View, **Edit**, **Confirm**, **Cancel** |
| `CONFIRMED` | Confirmed | View, **Cancel**, **Create Invoice** (once there is undelivered/uninvoiced quantity) |
| `PARTIALLY_DELIVERED` / `FULLY_DELIVERED` | Processing / Invoiced | View, **Create Invoice** while something remains to invoice |
| `CLOSED` | Invoiced | View only |
| `CANCELLED` | Cancelled | View only |
| *(any non-draft/cancelled)* + SAP `SYNCED` | **Synced** (overrides the row above) | same actions as the underlying status |

**Create Invoice** (order action) = existing delivery-create for the remaining quantity (FEFO unless a line named a batch) → existing invoice-create (`DRAFT`). If the order is already fully delivered but missing an invoice, only the invoice step runs — no extra stock movement. If the invoice step fails after delivery succeeded, the error names the delivery id and says stock was already moved; retrying "Create Invoice" reuses that delivery rather than delivering again (verified: I5 in `backtest/sales_actions.js`).

## 4. Invoice lifecycle

`DRAFT → (post) → POSTED → (payments, existing) → PARTIALLY_PAID → PAID`, or `DRAFT → CANCELLED`. Posting calls the existing `salesinvoice.post`, which is documented to create the accounting journal entries (Dr Receivable / Cr Sales / Cr Output GST) — **not re-verified in this phase**, only re-used. Admin actions: `post` and `cancel` are offered only while `status = DRAFT`; every other status is view/print/download only.

## 5. Secondary Sales flow

Secondary sales = **distributor → retailer** sales, read at **invoice line × batch allocation** grain from the same invoice/delivery/ledger data (no separate table). Only invoices with status `POSTED`, `PARTIALLY_PAID` or `PAID` count (drafts and cancelled excluded). If an invoice line was fulfilled from more than one batch (the delivery split it, e.g. FEFO exhausted one batch mid-line), the line's quantity and value are split pro-rata across the batches by allocated quantity, so the sum of the split rows always equals the line — verified in `backtest/sales.js` (I4) and the browser suite (I12).

## 6. API endpoints (all under `/api/admin`, all behind `requireAdmin`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/sales/lookups/filters` | Distributors, territories, categories for filter dropdowns |
| GET | `/sales/lookups/retailers?distributorId=&q=` | Retailers of one distributor (for the order form) |
| GET | `/sales/lookups/products?distributorId=&q=` | Products of one distributor |
| GET | `/sales/lookups/batches?distributorId=&productId=` | Batches of one product, with saleable stock and a reason when not saleable |
| GET | `/sales/orders?from&to&distributorId&retailer&territory&status&sap&q&sort&dir&page&pageSize` | Sales Orders list (server paginated) |
| POST | `/sales/orders/preview` | Price/GST/stock preview — no write |
| POST | `/sales/orders` | Create a DRAFT order |
| GET / PUT | `/sales/orders/:id` | Order detail / update (draft only) |
| POST | `/sales/orders/:id/confirm` \| `/cancel` \| `/create-invoice` | Status actions |
| GET | `/sales/invoices?…` | Sales Invoices list |
| GET | `/sales/invoices/:id` | Invoice detail |
| POST | `/sales/invoices/:id/post` \| `/cancel` | Invoice actions |
| GET | `/sales/secondary/summary?…` | KPI strip + trend + top distributors/products |
| GET | `/sales/secondary?…` | Secondary sales list |
| GET | `/sales/secondary/:key` | One record (`key` = `lineId-batchId`, `0` for no batch) |

19 routes in total (confirmed by `router.routes.length` in the backend test suite). Static paths are registered before parameterised ones (`/orders/preview` before `/orders/:id`, `/secondary/summary` before `/secondary/:key`) so they are never shadowed.

## 7. Data models

**New — additive only, nothing existing touched:**

- `sap_sync_records` (migration `20260921090000-create-sap-sync-records.js`): `distributor_id`, `entity_type` (`SALES_ORDER`/`SALES_INVOICE`), `entity_id`, `status` (`PENDING`/`SYNCED`/`FAILED`/`PARTIAL`), `sap_document_no`, `last_attempt_at`, `last_error`. Unique on `(entity_type, entity_id)`. `down` drops only this table.

**Read, not modified:** `SalesOrderHeader/Line`, `SalesDeliveryHeader/Line`, `SalesInvoiceHeader/Line`, `Distributor`, `Customer`, `Product`, `Batch`, `HSNGroup`, `StockLedger`, `PricingMaster`.

## 8. Pricing integration

Every price shown anywhere (preview, order lines, invoice lines) comes from `pricing.service.getFinalPriceForCustomer({ productId, customerId, distributorId })`, unmodified. If no `PricingMaster` row matches, the line reports `PRICING_NOT_CONFIGURED` and the order cannot be saved with that line — no price is invented (verified: V11). Nothing in a request body can set a price; `distributorContext` strips the browser's input to an explicit whitelist before calling the existing controller (verified: C2 in `backtest/sales_actions.js`).

## 9. Tax integration

GST is computed by `tax.service.computeLineTax` via the new `salesLineCalc.service.js`, using the arithmetic already used by `salesOrder.controller.js`: `gross = price × qty` → `discountAmount = gross × discount%` (rounded) → `taxable = gross − discountAmount` → CGST/SGST (intra-state, as used everywhere in the existing app) → `net = taxable + tax`. Document totals sum the lines. The frontend never computes any of this — it only formats and displays backend numbers (verified: no calculation logic in the React order/invoice files; V2, C7).

## 10. Inventory integration

Batch listing and stock checks use `inventory.service.getAvailableBatches` / `getBatchAvailableQty` — the same ledger-derived balance the delivery controller already uses. Expired or inactive batches cannot be selected; selecting one, or requesting more than the available balance (summed across every line of the order that targets the same batch or the same unbatched product), is rejected server-side with the exact message **"Insufficient saleable stock for selected batch."** (or "…for the selected product.") — verified in V6–V8 and end-to-end (C9). The frontend shows the same message but never decides it. Actual stock movement only happens through the existing delivery controller (Create Invoice); nothing in Phase 4 writes to `StockLedger` directly.

## 11. Accounting integration

Untouched. Posting an invoice calls the existing `salesinvoice.post`, documented (Phase 1) to create journal entries. **Integration point, not built in Phase 4:** a credit-limit check. `services/adminSalesOrder.service.js` exports `checkCreditLimit(orderFacts)`, called before every `confirm`; today it always returns `{ ok: true }` (no credit-limit data exists in the model), but when it returns `{ ok: false }` the API answers `409 CREDIT_LIMIT_EXCEEDED` with exactly **"Order cannot be confirmed because the applicable credit limit has been exceeded."**, and confirmation does not proceed — verified end-to-end (A11). A later phase only needs to implement the check's body.

## 12. SAP status integration

`sap_sync_records` is read-only from the Admin API's point of view in this phase — nothing writes to it except the demo dataset generator. A document with no row is reported as **Pending** (not "unknown", not "synced by guesswork"); `SAP status` only applies once an order is out of `DRAFT`/`CANCELLED`, or an invoice is `POSTED`/`PARTIALLY_PAID`/`PAID` — everything else shows "—". No SAP credentials exist anywhere in the code, and nothing is transmitted; every SAP panel in the UI says so explicitly.

## 13. Security considerations

- Every one of the 19 routes is behind `requireAdmin` (Phase 3's Admin-only, separately-signed session) — verified for all 19 (W1) and with live HTTP calls (X3: a Distributor session, its access token as a Bearer header, and that same token forged into the admin cookie are all refused with 401, and nothing in the database changes as a result).
- **Tenant boundary re-checked on every write**, not assumed from the request: the target distributor is loaded from the database; a retailer, product or batch belonging to a different distributor is rejected (`RETAILER_NOT_FOUND` / `PRODUCT_NOT_FOUND` / `BATCH_NOT_FOUND`) even though the ids were syntactically valid (T1–T3, X6).
- **No mass assignment**: `parseOrderInput` is an explicit whitelist; status, totals, prices, `distributor_id` and internal ids sent by a client are ignored — the created row always has `status: "DRAFT"` and server-computed totals (C2).
- **SQL injection**: every query uses named replacements; search text is escaped for `LIKE` (`!` as the escape character, portable across MySQL/SQLite) so a literal `%`/`_` cannot act as a wildcard; hostile strings (`'; DROP TABLE …`, `' OR '1'='1`) were sent through the real pipeline and produced zero matching rows with the schema intact (H1–H4, X5).
- **Status transitions** are centrally validated (`assertOrderActionAllowed`/`assertInvoiceActionAllowed`) before any existing controller is invoked, so an invalid transition never reaches the state machine (S2, S3, I2, P2).
- **Errors never leak internals**: unexpected failures answer a generic `Unable to complete the request` (or dashboard-equivalent) with `Cache-Control: no-store`; only `QueryError`/`SalesError` (with safe, pre-written messages) reach the client as 4xx (E4).
- No secrets, SAP credentials, or the distributor password hash are ever loaded or exposed by the new code (P4).
- CSV export: cells are RFC-4180 escaped and formula-injection-guarded (leading `=`, `+`, `-`, `@` prefixed with `'`) — unit-tested.

## 14. Demo data

`features/adminSales/sample/dataset.js` — deterministic (seeded PRNG, no `Math.random`), fictitious, isolated: **16 distributors, 40 retailers, 28 catalogue products (160 per-distributor instances), 480 batches, 78 sales orders, 62 deliveries, 54 invoices, ~640 stock-ledger rows, 42 SAP status rows** — all above the Phase 4 minimums. All six order statuses and all five invoice statuses are represented; a handful of batches are pre-expired or near-expiry; several orders are deliberately split across two batches to exercise multi-batch allocation. `features/adminSales/sample/sampleSalesApi.js` answers the exact same list/detail/summary shapes as the live API (client-side filtering/search/sort/paging over the dataset) — it is what makes the "backend SQL ≡ independent implementation" parity tests possible, and it is also what the UI actually uses in Sample mode. Sample mode is **read-only**: every write call (`createOrder`, `confirmOrder`, `postInvoice`, …) rejects with "Sample data is read-only. Switch to Live data to make changes." and never touches anything.

## 15. Known limitations

1. **Not run against MySQL, `npm run build`, or a real browser render** — see §0.
2. **MRP is not in the current data model** (`Batch`/`Product` have no MRP column) — every "MRP" field honestly shows "—", never a fabricated figure. Adding it is a Product/Batch Master change, out of scope for Phase 4.
3. **Scheme is display/reference only** — `scheme: null` everywhere; there is no scheme table yet. The field exists in every order/invoice/secondary-sales payload so the Scheme Engine (Phase 10) can populate it without a shape change.
4. **Credit limit is an integration point, not a mechanism** (§11) — always passes today.
5. **SAP is status-only**, sourced from a table nothing else writes to except the demo generator; a later phase supplies real sync jobs.
6. **GST is intra-state only** (CGST+SGST) — the same limitation as the existing `salesOrder.controller.js`/`tax.service.js`; IGST fields exist in every response and are always 0, ready for inter-state logic later.
7. **Day boundaries for date-range filters are UTC** (consistent with the Phase 3 dashboard).
8. **"Territory"** is `Distributor.city` or `.region` (same definition as the dashboard) — there is no dedicated territory/route master yet.
9. **Batch selection has no FEFO ranking in the picker** — batches are listed with their expiry and availability so the admin can choose, but the list is not sorted by "soonest to expire first"; delivery itself still allocates FEFO when no batch is named. A dedicated Batch/FEFO phase can improve the picker.
10. **Address fields on the order/invoice detail** fall back to whatever the existing `Distributor`/`Customer` records hold (street/city/pincode) — no separate billing/shipping address capture was added.
11. **No entity-level audit log** — the controller logs admin actions to the server console only (`[admin-sales] admin=<id> …`); a real Audit Logs module is a later phase.
12. **Multi-currency, price lists per territory, and MRP-based pricing** are not implemented — pricing is exactly what `PricingMaster` already supports.
13. **Performance**: the demo volume (~2,300 rows across the sales tables) responds quickly; no new indexes were added beyond what Phase 1/3 already noted as recommended for production (`(status, orderDate)`, `(status, invoiceDate)`, batch/ledger indexes).
14. Business assumptions throughout (secondary sales = posted/paid/partial invoices; "active" = had a document in range; stock-movement bucket mapping) mirror the Phase 3 dashboard's documented assumptions and still need validation against the requirements document.
