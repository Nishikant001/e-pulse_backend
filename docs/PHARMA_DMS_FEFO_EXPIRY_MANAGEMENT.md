# Pharma DMS — Phase 6: FEFO & Expiry Management

Status: **Phase 6 complete.** Phases 1–5 are the foundation. Phase 7 has **not** been started.

Phase 6 makes the existing inventory system handle First-Expiry-First-Out allocation, near-expiry stock and expired stock correctly. It does **not** add a second allocation engine: FEFO already existed inside `inventory.service`, was found to be correct, and was extended in place.

---

## 1. Existing FEFO implementation (what was found)

| Question | Finding |
|---|---|
| Where is FEFO? | `services/inventory.service.js` — `getAvailableBatches` (eligible batches, FEFO-ordered) and `allocateStock` (greedy consumption). `services/batchAllocation.service.js` is a deprecated shim that only calls `getAvailableBatches`. |
| How are batches selected? | Active batches of the product for the distributor, **not expired** (`exp_date < now` excluded — the same comparison everywhere), with saleable quantity > 0 in the dispatch warehouse. |
| How are quantities calculated? | From the ledger: saleable-state balance per batch and warehouse (Phase 5). Non-saleable stock is never available. |
| Multiple batches? | `allocateStock` consumes each batch fully before the next, in expiry order. |
| Locking / transactions / idempotency? | `getBatchAvailableQty` reads ledger rows `FOR UPDATE` inside the caller's transaction; `postSalesOut` posts each allocation via `postMovement`; the ledger's unique index `(reference_type, reference_id, reference_line_id, batchId, movement_type)` makes reposting idempotent. **Unchanged in Phase 6.** |
| Insufficient stock? | `allocateStock` throws `InsufficientStockError` **before anything is posted** — all-or-nothing. |

**Conclusion:** the algorithm was already correct, so it was reused and extended, not rewritten. Two defects were found and fixed (see §2).

## 2. Changes made

1. **Deterministic FEFO order** (`getAvailableBatches`). Order was `exp_date ASC` only. Now: batches *with* an expiry date first → ascending expiry → ascending batch id. This fixes two things:
   * **Ties** on the same expiry date fell back to whatever order the database returned. Rule chosen (none existed): **lower batch id first** — of two batches expiring the same day, the one recorded first is consumed first.
   * **Batches with no expiry date.** Some SQL dialects sort NULL *first* in ascending order, which would let an unknown-expiry batch jump ahead of a known, sooner one. They now sort **last**. (No existing test relied on the old behaviour.)
2. **One allocation algorithm.** The greedy loop was extracted into a pure `planFefoAllocation(batches, quantity)`, used by both `allocateStock` and the new `previewFefoAllocation`, so a preview can never disagree with real allocation on the same data.
3. **Insufficient-stock message** for automatic FEFO now reads "Insufficient saleable stock to fulfill requested quantity for product …" (the wording the brief asked for). The manual single-batch message is unchanged. Two Phase 5 test assertions were updated to match.
4. **Read-only FEFO Allocation Preview** — `inventory.previewFefoAllocation`, exposed as `GET …/inventory/fefo-preview`, and attached to the Admin Sales Order preview (`fefoAllocation` per Auto line).
5. **Expiry buckets** and a shared **bucket summary** (`getExpiryBucketSummary`), used by the Admin Dashboard, Near Expiry and Expired Stock pages.
6. **FEFO Monitor / Near Expiry / Expired Stock** pages (both portals) — built by extending Batch Stock, not by new listing endpoints.
7. **Batch Detail** extended with expiry bucket and FEFO priority.
8. **`REGULATORY_HOLD`** added as a non-saleable reason (additive; `non_saleable_reason` is a plain string column).
9. **Transfer Stock** — first UI for the Phase 5 transfer foundation, as a row/drawer action.
10. **Admin Dashboard** near-expiry totals now come from the shared function (§7), and "View Batches" now navigates to Near Expiry.

## 3. FEFO allocation algorithm

```
allocateStock(product, distributor, qty, [batchId], [warehouse])
  warehouse ← given, else the distributor's default (dispatch) warehouse
  if batchId given: check it is eligible and has ≥ qty saleable there → allocate from that batch only
  else:
    batches ← getAvailableBatches(product, distributor, warehouse)   // FEFO-ordered, eligible only
    plan    ← planFefoAllocation(batches, qty)                       // greedy, earliest expiry first
    if plan does not cover qty → throw InsufficientStockError        // nothing posted
    return plan (batchId, quantity)
postSalesOut then posts one OUT ledger row per allocation, in the caller's transaction.
```
Worked example (from the brief, and asserted in tests): A=50 (exp Feb), B=100 (Jun), C=200 (Jan next year); order 180 → A 50, B 100, C 30.

**Partial fulfilment policy (existing, unchanged, now documented):** none. A shortfall rejects the whole request; nothing is posted. Phase 6 did not introduce a partial-order policy.

**Transaction sequence (unchanged):** validate → lock eligible ledger rows (`FOR UPDATE`) → recalculate availability → allocate → post ledger rows → commit; any failure rolls back.

## 4. Eligibility rules

A batch is drawn from by a normal sale only if it is **active**, **not expired**, and has **saleable-state quantity > 0** in the dispatch warehouse. Expired, inactive, non-saleable (reclassified, or a blocked batch) and empty batches are excluded — by `getAvailableBatches`, which is the single place these rules live. The FEFO Monitor shows exactly batches whose Phase 5 status is `healthy` or `near_expiry`, which is the same set. Neither controllers nor React re-implement them.

## 5. Expiry buckets

**The brief's example buckets (180+/90–180/30–90/<30) were not used**, because the brief says existing configuration wins and the Phase 3 Admin Dashboard already ships a near-expiry configuration: **critical < 30 days, high < 60, medium < 90, expired**. Phase 6 reuses those thresholds unchanged; the canonical definition now lives in `inventoryRules.service.js` and the dashboard imports it, so they cannot drift.

| Key | Window | Label shown |
|---|---|---|
| `expired` | past expiry | Expired |
| `critical` | 0–29 days | Critical |
| `high` | 30–59 days | Near Expiry |
| `medium` | 60–89 days | Monitor |
| `healthy` | 90+ days (or no expiry recorded) | Healthy |

Edges are half-open (a batch expiring in exactly 30 days is `high`) — the same convention the dashboard used. The labels are the brief's suggested words (Critical / Near Expiry / Monitor / Healthy / Expired) applied to the existing keys; **no third vocabulary was introduced**.

**Item 17's six statuses.** The brief lists Healthy / Monitor / Near Expiry / Critical / Expired / Non-Saleable. The codebase already had two tested vocabularies — Phase 5's batch status (`healthy / near_expiry / expired / non_saleable / out_of_stock`) and the dashboard's bucket keys. Rather than rename either (which would break Phase 5's API, tests and UI), both are kept and shown together: **Status** (Phase 5, includes Non-saleable) and the **expiry bucket** badge (finer Critical/Near Expiry/Monitor detail), the second shown only when it adds information. Every badge carries text and an icon, never colour alone.

The near-expiry *status* threshold (`INVENTORY_NEAR_EXPIRY_DAYS`, default 90) is unchanged and equals the outer bucket edge.

## 6. Days-to-expiry calculation

One function: `rules.daysToExpiry(expDate, now)` = `ceil((exp − now) / 1 day)`; negative once expired. It is computed on the server and returned in every batch row (`daysToExpiry`); the UI only formats it ("in 21 d", "expired 66 d ago"). Not recomputed in components.

## 7. Near-expiry logic

* **Buckets and KPIs count only saleable, active, not-yet-expired stock** — units a decision can still be made about. Stock already marked non-saleable is excluded, as it was in Phase 5's `near_expiry_qty`.
* **The Near Expiry list** shows every batch in the window (status `near_expiry`), and the *Status* column shows if one is also non-saleable. So KPIs and the list can differ slightly by design; the page says so.
* `getExpiryBucketSummary` returns `{critical, high, medium, healthy, expired}`, each `{batches, distinct products, units, value}`, across all warehouses (a batch in two warehouses counts once).
* **Admin Dashboard.** Its own SQL was replaced by this function. That SQL predated Phase 5 and summed a batch's whole ledger balance regardless of stock state, so stock already flagged non-saleable (e.g. damaged) was still counted as near-expiry. Response shape is unchanged; the dashboard's numbers can therefore differ slightly from before in exactly that case. Nothing on the dashboard is hard-coded.
* Value is **cost value** (Phase 5 valuation), labelled as such everywhere.

## 8. Expired stock logic

Expired = `exp_date < now`, the same test allocation uses (start of the expiry date, UTC — see limitations). Expired batches are excluded from FEFO and rejected by the delivery flow (verified), never deleted, and keep their full ledger. Their whole on-hand quantity is reported as non-saleable/expired, so Transfer and Mark-non-saleable are shown **disabled** on them (0 saleable units).

## 9. Non-saleable workflow

Reuses Phase 5's `reclassifyStock` (`POST /inventory/non-saleable`): validates batch (tenant), quantity, reason; posts the OUT/IN `RECLASSIFY` pair in one transaction; nothing deleted; recorded with `created_by`, timestamp, reason, batch, warehouse and both states (previous and new state = the two rows' `stock_state`). Reasons: Damaged, Expired (derived, not manually selectable), Quality issue, **Regulatory hold (new)**, Returned, Blocked, Other (note required).
**Audit:** the stock ledger *is* the audit trail for these changes; no parallel audit table was built. When the Audit Logs module is built it should read `RECLASSIFY` rows — that is the integration point.

Row actions (item 15): **View batch**, **View stock ledger**, **Transfer stock**, **Mark non-saleable** are real. **Push sales** and **Return** are shown **disabled with an explanation** — Push sales needs the Scheme Engine (later phase); "Return" has no batch-level endpoint (returns are made against a posted invoice/purchase line), so there is no safe workflow to call. No action fakes success.

## 10. Sales integration

Unchanged lifecycle: Sales Order → Delivery (allocation + deduction) → Invoice. Stock is allocated at **delivery**, not order time, by `postSalesOut`. Verified through the real controllers: order of 180 over A=50, B=100, C=200 → ledger rows A 50, B 100, C 30 in FEFO order, stock 0/0/170, and the invoice line lists all three batches (the Phase 4 invoice already groups by batch from the ledger). The Sales Order preview now returns `fefoAllocation` for each Auto line and the form shows a **FEFO Allocation Preview**. Limitation: if several Auto lines share a product, each line's preview is computed independently and may overlap; real allocation at delivery accounts for what is consumed.
The legacy Distributor `SalesOrderMaster` screen (manual batch choice) was not touched.

## 11. Database changes

Migration `20260925090000-fefo-expiry-phase6.js` — **one additive index only**: `idx_batches_dist_product_exp (distributor_id, productId, exp_date)` on `Batches`. No new tables or columns (buckets, priority and the extra reason are derived). Idempotent; rollback removes exactly that index. Verified up → re-run → down → up on MariaDB 10.11 against Phase 5-shaped data (balances untouched).

## 12. API changes

No duplicate endpoints: Batch Stock (`/inventory/batches`) already provided batch-level filtering, sorting and pagination, so the new pages extend it.

| Change | Detail |
|---|---|
| `GET /inventory/batches` (both portals) | new optional params: `fefoEligible=1` (eligible only, adds `priority`), `bucket`, `expFrom`/`expTo` (expiry date range), `sort=priority` (requires `fefoEligible=1`). Rows gain `expiryBucket` and `priority`. Existing behaviour unchanged when they are omitted. |
| `GET /inventory/batches/:id` | adds `expiryBucket` and `fefo {priority, warehouse, note}` |
| `GET /inventory/expiry-summary` (new) | bucket rollup; Admin may pass `distributorId`, omitted = all tenants |
| `GET /inventory/fefo-preview` (new) | `productId, quantity[, warehouseId]`; Admin must also pass `distributorId` |
| `GET /inventory/lookups` | adds `expiryBuckets` |
| `POST /admin/sales/orders/preview` | Auto lines gain `fefoAllocation`, `fefoSufficient` |
Admin equivalents live under `/api/admin/inventory/*` (read-only). Frontend routes: `/admin|dashboard/inventory/{fefo,near-expiry,expired}`.

**Priority definition.** A row's `priority` is its 1-based rank among *eligible* batches of the same **(distributor, warehouse, product)**, in exactly the order allocation would consume them — so priority 1 is what a plain sale takes next. It is computed against the full eligible set for that group (not narrowed by search/bucket filters). Many rows therefore show priority 1 — one per product/warehouse — which is correct, not a defect. Batch Detail shows priority in the **dispatch (default) warehouse**, since that is where plain sales draw from.

## 13. Security

Unchanged model, applied to every new surface: Distributor tenant is always the verified session id (a `distributorId` in the request is ignored); batch/warehouse ids are re-checked against the tenant; Admin endpoints are read-only and need an Admin session. New SQL is parameterised; sort columns whitelisted; `bucket` validated against a list. Verified on the real stack: spoofed `distributorId` ignored on batches, summary and preview; foreign product preview returns nothing; foreign batch transfer → 404 with nothing posted; foreign warehouse → rejected.

## 14. Performance / indexing

Filtering, sorting, paging and priority are all in SQL; nothing is sorted in React. Index above; Phase 5 ledger indexes still serve the balance subqueries. `priority` costs one correlated subquery per returned row, so it is **opt-in** (`fefoEligible=1`) and bounded by page size (≤100). Expiry filters are index-friendly range predicates. Not load-tested beyond ~1,000 batches in tests (see limitations).

## 15. Testing

| Area | Method | Result |
|---|---|---|
| Backend | Jest, SQLite | **171/171** (138 prior + 33 new) |
| Backend on MySQL family | same suite, MariaDB 10.11 | **171/171** (the one Phase 5 MariaDB failure, `returns-lifecycle` test 9, passed on every rerun in this phase — evidently timing-sensitive; no return code was touched in Phase 5 or 6) |
| Migration | up / re-run / down / up on MariaDB | Clean, balances unchanged |
| Rules parity | backend vs frontend sample mirror | 365/365 (Phase 5) + 18/18 (buckets) identical |
| FEFO | earliest first; 50/100/200→180; expired & non-saleable skipped; insufficient → error, nothing posted; same-expiry tie-break repeated; NULL expiry last; preview = actual, read-only | pass |
| Near expiry / expired | boundaries 0/29/30/59/60/89/90; bucket, expiry-range, status filters; sort; summary excludes non-saleable, expired counts on-hand | pass |
| Sales integration | real controllers: 180 across 3 batches → stock, ledger, invoice batches | pass |
| Concurrency (MariaDB) | 12 parallel FEFO sales × 40 vs 350 in stock | exactly 8 succeeded (320 units), 4 rejected, no negatives, A and B drained before C touched |
| Browser E2E (Chrome, real backend + MariaDB) | Admin 27/27, Distributor 19/19, regression 22/22, order-preview 3/3 | pass |
| Responsive | 1440 / 900 / 390 | no page-level overflow on any new or existing inventory/dashboard/sales page checked |
| Lint / build | ESLint, `vite build` | build passes; **43 problems, identical to the pre-Phase-6 baseline** (none in Phase 6 code) |

Bugs found by testing and fixed: (a) `KpiCard` lacked `min-w-0`, so a currency value below the compact threshold (e.g. `₹32,807.64`) forced horizontal page scroll on phones — fixed in the shared component (one class + `break-words`); (b) my first `priority` sort referenced the wrong alias; (c) a missing clock parameter in the batch-detail priority query. All caught by tests before delivery.

## 16. Known limitations

1. **Expiry instant.** Expired = past the *start* of the expiry date (UTC), matching existing sales allocation. Many pharma businesses treat a batch as valid through the end of the expiry day/month; changing that would change sales behaviour — a business decision left open.
2. **Bucket thresholds** are the fixed Phase 3 values (30/60/90), not configurable per tenant; there is no Settings screen. `INVENTORY_NEAR_EXPIRY_DAYS` (status threshold) is process-wide.
3. **Multi-warehouse allocation** is still from the dispatch (default) warehouse only. The FEFO preview and priority are therefore for that warehouse; the Monitor lists other warehouses' rows with their own per-warehouse priority.
4. **Sales Order preview overlap** when several Auto lines share a product (see §10). Legacy Distributor `SalesOrderMaster` has no FEFO preview.
5. **Dashboard numbers may change slightly** versus before Phase 6 for stock already marked non-saleable (see §7) — a correction, but a visible one.
6. **Batches with no expiry date** are treated as healthy and ordered last; they never appear as near-expiry.
7. **Transfer stock** is the Phase 5 foundation: immediate, same distributor, saleable stock only, no approval/in-transit. The "Stock Transfer" menu item remains planned; no warehouse-management screen.
8. **Push sales** and **Return** actions are disabled placeholders (§9).
9. **Priority cost** grows with page size and batch count (opt-in); not load-tested at scale.
10. **Preview is informational**, not a reservation; real allocation is re-validated at delivery.
11. **Pre-existing, untouched:** lint reports `Icon` unused in `NearExpiryCard.jsx` (Phase 3) though it is used in JSX — one of the 43 baseline problems; the batch bulk-upload handler bug noted in Phase 5.
12. **Not verified:** MySQL 8 itself (MariaDB used), production hosting, browsers other than Chromium, screen readers, large-scale load.
13. Rules exist twice (backend and the demo-data mirror); parity was checked by script, not by an automated test in the repo.

## 17. Files

Backend — new: `migrations/20260925090000-fefo-expiry-phase6.js`, `tests/fefo-expiry-phase6.test.js`. Changed: `services/inventory.service.js`, `services/inventoryRules.service.js`, `services/inventoryQuery.service.js`, `services/adminDashboard.service.js`, `services/adminSalesOrder.service.js`, `controllers/inventory.controller.js`, `routes/{allRoutes,adminRoutes}.js`, `tests/inventory-phase5.test.js` (two message assertions).
Frontend — new: `features/inventory/pages/{FefoMonitor,NearExpiry,ExpiredStock}Page.jsx`, `components/{FefoPreviewModal,TransferStockModal,ExpiryBucketKpis}.jsx`, `components/batchRowActions.js`, `hooks/useBatchQuickActions.js`, Distributor wrappers `FefoMonitor/NearExpiry/ExpiredStock.jsx`. Changed: `App.jsx`, both navigation configs, `statusConfig.js`, `KpiCard.jsx`, `BatchDrawer.jsx`, `InventoryFilterBar.jsx`, `inventoryOptions.js`, the inventory API layer and sample data (`sample/rules.js`, `sample/sampleInventoryApi.js`), `AdminDashboardPage.jsx`, `CreateSalesOrderPage.jsx`.
