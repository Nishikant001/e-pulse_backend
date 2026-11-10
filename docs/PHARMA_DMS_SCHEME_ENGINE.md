# Phase 10 — Scheme Engine

## Findings from inspection
- No scheme/promotion model existed. Existing discounts: `PricingMaster.discount_percent` (price-level, untouched) and `SalesOrderLine` discount fields (untouched).
- Products, retailers (`Customers`) and batches are **per distributor**; there is no separate territory/region master on products, so **territory applicability is not implemented** (retailers carry a free-text territory only).
- There is no Product Group master other than `Product.category`; "product group" is supported as **category**.

## Data model (additive migration `20261003090000-scheme-engine-phase10.js`, reversible, idempotent)
`Schemes` + link tables `SchemeProducts`, `SchemeDistributors`, `SchemeRetailers` (IDs only; no names copied). No existing table altered.

## Scheme types
| Type | Rule |
|---|---|
| QUANTITY_FREE | Buy X → Y free, repeating (20 bought on Buy10Get1 = 2 free). Optional `max_quantity` caps the quantity that earns free goods. |
| PERCENT_DISCOUNT | % of line value, optional min qty, max qty, max discount cap. |
| FIXED_DISCOUNT | ₹ off the line, never more than the line value, optional min/max qty and cap. |

**Not implemented (documented):** Buy Product A → get Product B (cross-product free goods) — needs stock deduction of a different SKU and batch allocation; deferred. Order-value schemes, slab/tiered schemes, stacking.

## Validity
Applied only if stored status = `active` AND `valid_from <= date <= valid_to` (open-ended allowed). Evaluated by the backend clock (`asOf` optional, for what-if). `effectiveStatus` shown in UI: active / inactive / scheduled / expired.

## Priority & conflicts (no stacking)
Per product line, the eligible scheme with the **lowest priority number** wins. If two or more eligible schemes tie on the lowest priority, the requirements define no winner, so **none is applied**, the line gets `conflict: true` with the tied scheme codes, and Admin must separate their priorities. Schemes never stack.

## API
Admin (`requireAdmin`): `GET /api/admin/schemes/lookups`, `GET/POST /api/admin/schemes`, `GET/PUT /api/admin/schemes/:id`, `POST /api/admin/schemes/:id/status`, `POST /api/admin/schemes/evaluate` (read-only, explicit distributorId).
Distributor (`authMiddleware`, read-only): `GET /api/schemes/applicable`, `POST /api/schemes/evaluate`. Distributor identity = `req.user.id`; any distributorId in query/body is ignored. No distributor write routes exist.

## Evaluation result (per line)
`applied: { eligible, schemeId, schemeCode, benefitType (FREE_QUANTITY|PERCENT_DISCOUNT|FIXED_DISCOUNT), ... }`. Free goods: `purchasedQuantity`, `freeQuantity`, `totalQuantity` kept separate. Also `eligibleSchemes`, `conflict`, `conflictSchemes`, `considered`, `errors`.

## Sales integration
`previewOrder` (Admin sales order preview) now also returns an informational `scheme` object per line. **Prices, discounts, tax, totals, order persistence, batch allocation/FEFO and inventory are unchanged.** Saved orders/invoices do not store scheme data yet.

## Known limitations
- No inventory/batch deduction for free goods; the scheme result is advisory until a later phase wires it into order/invoice persistence (which must snapshot scheme id/code/benefit so later edits never change history).
- No audit-log table exists in this codebase; create/update/status changes are logged to the server log with admin id and changed fields, and `created_by_admin_id`, `updated_by_admin_id`, `status_changed_at` are stored.
- Schemes are not hard-deletable via API (deactivate only). Type and code are immutable after creation.
- Territory applicability and cross-product free goods not implemented. Claims (Phase 11) not started.
- Product/retailer pickers in the form load up to 300 records per lookup.
