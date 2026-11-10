# Pharma DMS — Phase 5: Inventory & Batch Management

Status: **Phase 5 complete.** Phases 1–4 are the foundation and are unchanged in behaviour. Phase 6 (near-expiry workflow, FEFO monitor, expiry actions) has **not** been started.

This phase makes the *existing* inventory architecture pharma-ready. It does **not** add a second inventory engine: every quantity shown anywhere in Phase 5 is derived from `StockLedger`, the same source of truth `inventory.service` posts to.

---

## 1. Existing inventory architecture (what was found)

| Piece | Where | Notes |
|---|---|---|
| Inventory engine | `services/inventory.service.js` | `postMovement` (row-locked, transactional, idempotent), `allocateStock` (FEFO, expired/inactive excluded), `postPurchaseIn`, `postSalesOut`, `postAdjustment`, `reverseMovementsForReference`, `getBatchAvailableQty`. |
| Stock Ledger | `models/stockledger.model.js`, table `StockLedgers` | Append-only. Balance = Σ(IN) − Σ(OUT). Unique index `(reference_type, reference_id, reference_line_id, batchId, movement_type)` gives idempotency. |
| Batch | `models/Batch.js` | `batch_no, mfg_date, exp_date, purchase_price, status, distributor_id, productId`. A hook flips expired batches to `inactive` when saved. |
| Product | `models/product.model.js` | `material_code` (= SKU), `category`, `mfg_by`, `hsn_id`, GST columns, `reorder_level` (default 10). |
| Flows | purchase delivery → `IN/PURCHASE`; sales delivery → `OUT/SALES` (FEFO or chosen batch); sales return → `IN/RETURN`; purchase return → `OUT/RETURN`; cancellations → compensating `CORRECTION` rows. | Unchanged. |
| Legacy read APIs | `/api/stockLedger/current`, `/batch`, `/ledger` | Left as-is (they return on-hand across all states). The Phase 5 screens no longer use them. |

**Gaps found** (all now closed additively): no warehouse concept, no saleable/non-saleable state (only whole-batch `inactive`), no reserved quantity, no batch MRP, no date-order validation, no duplicate-batch rule, no status derivation, no server-side paginated ledger with running balance.

## 2. Inventory model

```
Distributor ─▶ Warehouse ─▶ Product ─▶ Batch ─▶ Stock (StockLedger rows)
```

Nothing is stored as a counter. For any (distributor, warehouse, batch):

* **on hand** = saleable-state balance + non-saleable-state balance
* **saleable** = saleable-state balance of a batch that is **not expired** and **active**
* **non-saleable** = non-saleable-state balance + saleable-state balance sitting in an expired/inactive batch
* **stock value** = on hand × `Batch.purchase_price`

New ledger columns (all optional / defaulted, so legacy rows are unchanged): `warehouse_id` (NULL = the distributor's default warehouse), `stock_state` (`SALEABLE` default | `NON_SALEABLE`), `non_saleable_reason`.

**Warehouses.** New `Warehouses` table, owned by one distributor. Every distributor has one *default* warehouse (`MAIN`, "Main Warehouse") that acts as the **dispatch warehouse**: sales allocate and post from it unless a warehouse is passed. Legacy ledger rows are attributed to it at read time — history is never rewritten.

## 3. Batch model

Added `Batch.mrp DECIMAL(10,2) NULL` (printed MRP; legacy batches show "—"). Manufacturer = `Product.mfg_by`; HSN and GST come from the product / HSN group (`Product.gst`, else `HSNGroup.gst_rate`, else CGST+SGST).

Server-side validation (`services/batchValidation.service.js`, used by `POST /api/stock` and `PUT /api/stock/:id`, plus a model validator):

* product exists **in the caller's tenant** (404 otherwise); batch number required, ≤ 50 chars
* duplicate `(distributor, product, batch_no)` rejected (application rule)
* `exp_date > mfg_date`; manufacturing date not in the future; invalid dates and negative money rejected
* **Legacy compatibility:** rules apply to what is *written*. Updating a legacy batch's status/price does not re-validate untouched dates, and the model validator only fires when `mfg_date`/`exp_date` change. A legacy row that already violates the rule keeps working; it is rejected only if someone edits its dates.

## 4. Stock states

| State | Meaning |
|---|---|
| Saleable | Usable by a sale. |
| Non-saleable | Held on the ledger, excluded from sales. Reasons: Damaged, Expired, Quality issue, Returned, Blocked, Other (Other requires a note). |
| Expired | Derived from `exp_date` — never stored. Expired stock is automatically non-saleable. |

Moving stock between states (`markNonSaleable` / `releaseNonSaleable`) posts **two** ledger rows in one transaction (`RECLASSIFY`, OUT of one state + IN to the other). On-hand is unchanged and nothing is deleted.

## 5. Saleable / non-saleable logic

`getBatchAvailableQty` — used by `allocateStock` and every OUT check — now counts **only `SALEABLE`-state rows** (optionally one warehouse). A sale therefore cannot consume non-saleable stock, and expired/inactive batches are still excluded by `allocateStock` exactly as before. Sales never deduct stock in the UI.

## 6. Expiry status

`services/inventoryRules.service.js` (pure functions, unit-tested):

* **Expired** — `exp_date < now` (the *same* comparison `allocateStock` uses).
* **Near Expiry** — expires within **90 days**. This is a documented default (the outermost bucket of the Phase 3 dashboard) and can be overridden with `INVENTORY_NEAR_EXPIRY_DAYS` (1–730). It is process-wide; a Settings module can own it later. The value is returned by the API (`thresholds.nearExpiryDays`) so the UI text never hard-codes it.
* **Healthy** — otherwise. A batch with no expiry date (legacy) is Healthy.

Batch status: `out_of_stock` (on hand ≤ 0) → `expired` → `non_saleable` (inactive, or no saleable units) → `near_expiry` → `healthy`.
Product (Current Stock) status: any expired stock → `expired`; product's saleable total (across warehouses) ≤ reorder level → `low_stock`; any near-expiry saleable stock → `near_expiry`; else `healthy`.

## 7. Stock Ledger

Screen columns: Date, Reference, Transaction Type, Product, Batch, Distributor, Warehouse, In, Out, Balance, Status. Server-side paging (`page`, `pageSize` ≤ 100), date range, product/batch/warehouse/distributor/type filters, search (product, SKU, batch, return number, note, numeric reference id).

* **Transaction type** is derived from one table (`TXN_TYPES`) that drives both the label and the SQL filter: Purchase, Sale, Sales Return, Purchase Return, Stock Transfer, Adjustment (damage, breakage, count, correction/reversal), Opening Stock, Stock Status Change.
* **Balance** = running total for that batch in that warehouse (both stock states), computed for the rows on the page only.
* **Status** column = the row's stock state (Saleable / Non-saleable + reason).
* **Reference:** deliveries have no document number in the schema, so they show as "Sales delivery #id" / "Purchase delivery #id"; returns show their return number; transfers `TRF-000001`.
* **Date** is the ledger row's `createdAt` (posting time) — the ledger has no separate business date.
* **Stock movement** (`/movement`): Opening → Stock in → Stock out → Returns → Adjustments (+ Transfers / Other when non-zero) → Closing, all derived from the ledger. Every row falls in exactly one bucket, so `opening + movements = closing` (asserted in tests and equals current on-hand).

## 8. Stock valuation

The data model has **one price per batch**, `purchase_price`. Therefore **Stock value = on-hand quantity × batch purchase price = COST value.** It is labelled "Stock value (at purchase cost)" everywhere. MRP is displayed for information and is **never** multiplied into a value; there is no dealer-price valuation. This matches the Phase 3 dashboard's inventory value. The basis is exposed as `valuation` in the API.

## 9. Low-stock logic

Uses the existing `Product.reorder_level` (NOT NULL, default 10 when a product is created). Compared with the product's **saleable** quantity summed across the distributor's warehouses. `reorder_level ≤ 0` disables the rule (same as the dashboard). No threshold is hard-coded in React. Limitation: legacy products keep whatever reorder level they were created with.

## 10. Stock transfer foundation

`StockTransfers` table + `inventory.transferStock()`; `POST/GET /api/inventory/transfers`. One batch, two warehouses of the **same** distributor, posted immediately as an OUT (source) + IN (destination) `TRANSFER` pair with reference `TRF-######` — atomically, with the same overdraw protection as a sale. **Not built:** approval, in-transit state, cross-distributor transfers (needs batch mapping between tenants), transferring non-saleable stock, any UI. Warehouse create/rename/deactivate endpoints exist; there is no warehouse-management screen.

## 11. Sales integration

Verified: Sales Order → Delivery → Invoice → stock deduction → ledger `OUT/SALES` row — through the existing controllers, with the ledger row stamped with the dispatch warehouse. Expired or non-saleable stock is rejected by the existing delivery flow with nothing half-posted. No deduction logic was duplicated. **Reserved qty** (Current Stock) = undelivered units on `CONFIRMED`/`PARTIALLY_DELIVERED` orders; it is **informational** — the existing engine does not reserve, so it does not reduce saleable stock.

## 12. Purchase integration

Verified: Purchase order → confirm → delivery → `IN/PURCHASE` on the chosen batch; batch number, dates, MRP and cost are preserved on the batch; ledger shows the movement with its batch.

## 13. Return integration

Verified: posting a sales return creates `IN/RETURN` on the returned **batch** referencing the return; the ledger shows the return number and it is searchable. Purchase returns appear as *Purchase Return* (OUT). Return logic itself is untouched.

## 14. Security

* `/api/inventory/*` (Distributor): tenant is **always** `req.user.id` from the verified token. A `distributorId` in the request is ignored. Batch/warehouse/product ids are re-checked against that tenant: foreign batch → **404**, foreign warehouse filter → **404**, foreign product movement → empty, foreign batch/warehouse in a write → 404/400 with nothing posted.
* `/api/admin/inventory/*`: read-only, `requireAdmin`; a Distributor cookie is rejected (verified).
* Every SQL join to `Batches` is constrained by `distributor_id`; values are bound replacements; sort columns are whitelisted; `LIKE` input is escaped; page size capped at 100.
* Errors: user-facing messages for 4xx; 5xx return a generic message and log server-side (no SQL/stack to the client).
* Numeric ids remain sequential integers as in the rest of the API: protection is authorization, not obscurity.

## 15. Database migrations

`migrations/20260922090000-inventory-batch-phase5.js` — **additive only**:

* creates `Warehouses` (and one default `MAIN` warehouse per existing distributor) and `StockTransfers`
* `StockLedgers`: + `warehouse_id` (NULL), + `stock_state` (default `SALEABLE`), + `non_saleable_reason`; `reference_type` ENUM widened with `TRANSFER`, `RECLASSIFY`; two composite indexes
* `Batches`: + `mrp` (NULL), + lookup index `(distributor_id, productId, batch_no)` — **not unique** (legacy duplicates may exist)
* No table dropped, no row rewritten, no historical balance touched, `DB_FORCE` not needed.
* **Rollback (`down`)** removes exactly what `up` added, and **refuses** if any `TRANSFER`/`RECLASSIFY`/`NON_SALEABLE` row exists (they would lose their meaning).
* Run: `npx sequelize-cli db:migrate`. Verified on MariaDB 10.11 against a schema built from the *Phase 4* models with legacy data (balance 70 → 70 → rollback 70). Note: Sequelize's SQLite `changeColumn` cannot run this migration; dev/test databases that use `sync()` are unaffected.

## 16. Demo data

Frontend, isolated in `src/features/inventory/sample/` (never inside JSX): deterministic (seeded PRNG), regenerated relative to "today" so near-expiry/expired stay correct. **6 distributors, 9 warehouses (3 distributors have two), 28 catalogue products (67 product rows), 167 batches, ~700 ledger entries** covering healthy, near-expiry, expired, partly and fully non-saleable, depleted and low-stock, with purchases, sales, returns, adjustments, transfers and status changes. Balances reconcile exactly (ledger = KPIs = movement = running balance). Available in the Admin portal via the **Sample data** switch (read-only, clearly bannered). The Distributor portal is always live.

## 17. Known limitations

1. **Multi-warehouse is a foundation.** Sales allocate from the dispatch (default) warehouse only. Admin *order preview* lookups (`adminSalesOrder`) still report distributor-wide saleable stock, so preview and delivery can differ **only** if stock sits in a non-default warehouse. Identical with one warehouse (today's data).
2. **Expiry instant.** "Expired" uses `exp_date < now` (start of the expiry date, UTC), identical to the existing sales allocation. Pharma businesses often treat a batch as valid through the end of the expiry day/month; changing that would alter sales behaviour, so it is a **business decision** left for you.
3. **Near-expiry threshold** is one process-wide value (env), not per-tenant/product; no Settings screen.
4. **Duplicate batch numbers** are rejected by the application, not by a DB unique index; two simultaneous creates could still race.
5. **No "as-of date"** on Current Stock/Batch Stock (date filtering exists on the Ledger and Movement only). The Ledger uses the shell's header date range (default "This month"), so older movements need the range widened.
6. **Reserved** is informational (see §11). Batch-level *reserved* counts only order lines that name a batch.
7. **Valuation** is cost only (see §8).
8. **Non-saleable changes** are made from the Distributor portal only; the Admin portal is read-only. No expiry actions/workflow (Phase 6).
9. **Transfers:** no UI, no approval, same-distributor, saleable stock only (see §10). No warehouse-management screen.
10. **Rules exist twice** (backend, and a JS mirror used only for demo data). They are checked for parity (365 input combinations identical) but not by an automated test in the repo.
11. **Legacy** `/api/stockLedger/*` read endpoints are unchanged; the old Distributor pages are replaced by thin wrappers around the new screens.
12. **Pre-existing, not touched:** the batch bulk-upload handler (`stock.bulkUploadBatches`) references an undefined variable (`material_code`); on MariaDB, `tests/returns-lifecycle` test 9 fails identically on the unmodified Phase 4 code (a 500 while creating a sales return) — not caused by Phase 5, not investigated.
13. The UI has no automated unit tests in this repo (none existed); UI verification was done with scripted Chrome runs that are not shipped.

## 18. API changes summary

**Distributor (`/api`, auth cookie)** — all `GET` accept `page, pageSize, sort, dir` where relevant.

| Method & path | Purpose |
|---|---|
| `GET /inventory/lookups` | Warehouses, categories, transaction types, reasons, thresholds, valuation |
| `GET /inventory/summary` | KPI totals (same filters as Current Stock, minus status) |
| `GET /inventory/current` | Product × warehouse stock. Filters: `q, warehouseId, productId, product, category, batch, status` |
| `GET /inventory/batches` | Batch × warehouse stock. Filters as above + `includeEmpty` |
| `GET /inventory/batches/:id` | Batch detail (info, stock split, locations, non-saleable breakdown, reserved) |
| `GET /inventory/ledger` | Paginated ledger with running balance. Filters: `from, to, productId, product, batchId, batch, warehouseId, txnType, q` |
| `GET /inventory/movement` | Opening → Closing for `productId` or `batchId` (+ `warehouseId`, `from`, `to`) |
| `GET /inventory/transfers`, `POST /inventory/transfers` | Transfer foundation |
| `POST /inventory/non-saleable` | `{batchId, quantity, action: MARK\|RELEASE, reasonCode, reason?, warehouseId?}` |
| `POST /inventory/warehouses`, `PUT /inventory/warehouses/:id` | Create / rename / (de)activate (default cannot be deactivated) |

**Admin (`/api/admin`, admin cookie)** — the same `GET` endpoints, read-only, plus optional `distributorId`.

**Changed existing:** `POST /api/stock` and `PUT /api/stock/:id` (batch create/update) now validate and accept `mrp`; `POST /api/stockLedger/adjustment` accepts optional `warehouseId`. `inventory.service` functions gained **optional** `warehouseId` / `stockState` / `nonSaleableReason` parameters; defaults reproduce the old behaviour, and `allocateStock`'s return shape is unchanged.

**Frontend:** new `src/features/inventory/`; routes `/admin/inventory/{current,batch,ledger}`; Distributor `/dashboard/inventory/*` now render the same screens; Admin sidebar items made live. One shared-component fix: `DataTable`'s scroll container is now `relative` — `sr-only` header text in wide, sortable tables escaped the container and caused page-level horizontal scroll (found during verification; it affects any wide sortable table).

## 19. Verification report

| Area | Method | Result |
|---|---|---|
| Backend regression | Jest, SQLite | **138/138** (106 pre-existing + 32 new) |
| Backend on MySQL family | Same suite on MariaDB 10.11 | 137/138 — the one failure is pre-existing (§17.12) |
| Migration | Phase 4 schema + legacy data → up → rollback → up → guard, on MariaDB | Balance unchanged, defaults correct, rollback clean, guard works |
| Rules parity | Backend vs frontend mirror, 365 combinations | Identical |
| Real-stack UI | Chrome + real backend + MariaDB, seeded with the demo dataset as real rows | **Admin 34/34, Distributor 31/31, regression 17/17** |
| Tenant isolation | Real API: spoofed `distributorId`, foreign batch/warehouse/product ids, foreign writes, Admin API with a Distributor cookie | All blocked; nothing leaked or posted |
| Concurrency (row locking) | 15 parallel status-change requests for 49 units each vs 491 available | Exactly 10 succeeded, 5 rejected, never negative, no half-posted rows |
| Lifecycle | Purchase → Sale → Return via existing controllers | Stock, ledger, running balance, movement closing all agree |
| Responsive | 1440 / 900 / 390: no page-level overflow; tables scroll in their container; mobile filters collapse | Pass (one bug found and fixed, §18) |
| Accessibility | Table captions & header scope, keyboard open/close drawer, no unlabeled icon buttons, status as text+icon | Pass (automated basics only — no screen-reader session) |
| Lint / build | ESLint, `vite build` | Build passes; 0 lint problems in Phase 5 files (43 pre-existing elsewhere, identical to Phase 4) |

**Not verified:** a production deployment, MySQL 8 itself (MariaDB used), browsers other than Chromium, real screen readers, and any dataset beyond ~1,000 batches in tests / ~170 in the browser run (queries are server-paginated and indexed, but no load test was done).

## 20. Files

Backend — new: `models/warehouse.model.js`, `models/stocktransfer.model.js`, `migrations/20260922090000-inventory-batch-phase5.js`, `services/inventoryRules.service.js`, `services/inventoryQuery.service.js`, `services/batchValidation.service.js`, `controllers/inventory.controller.js`, `controllers/admin.inventory.controller.js`, `tests/inventory-phase5.test.js`. Changed: `services/inventory.service.js`, `models/{index,stockledger.model,Batch}.js`, `controllers/{stock,stockLedger}.controller.js`, `routes/{allRoutes,adminRoutes}.js`, `.env.example`.
Frontend — new: `src/features/inventory/**`. Changed: `App.jsx`, `config/adminNavigation.js`, `components/ui/statusConfig.js`, `components/tables/DataTable.jsx`, and the three `components/Distributers/dashboard/pages/InventoryStock/*.jsx` (now wrappers).
