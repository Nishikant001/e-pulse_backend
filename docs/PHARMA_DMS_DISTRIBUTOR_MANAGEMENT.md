# Phase 8 — Distributor Management (design notes & assumptions)

## What the existing architecture already had (reused, not rebuilt)
- **`Distributors` table / `Distributor` model** is both the tenant and the login identity. Reused as the single distributor entity — no new table.
  Already present and used as-is: `distributor_code` (auto-generated, unique), `name` (= business name), `email`, `phone_number`, `tax_no` (= GSTIN), `pan`,
  `street1–4`, `address`, `city`, `region` (= state), `postal_code`, `country`.
- **Customer** (= retailer) already belongs to a distributor through `Customer.distributor_id`. That *is* the distributor-to-retailer mapping.
- Sales Orders, Invoices, Returns, Credit Notes, Journal (Accounts Receivable) and PricingMaster all carry `distributor_id` / `distributor_code`; the profile only **reads** them.
- Admin auth (`requireAdmin`), the Phase 7 `AdminApiError` client, `useMastersList`, `DataTable`, `FilterBar`, `Modal/ConfirmationModal`, `Tabs`, `KpiCard`.

## What was genuinely missing (one additive migration)
`20261001090000-distributor-management-phase8.js` adds to `Distributors`: `contact_person`, `territory`, `credit_limit`, `payment_terms`,
`status` (`active|inactive|pending`, default `active`), `status_reason`, `status_changed_at`.
Idempotent, reversible, no data rewritten — every existing distributor becomes `active`.

## Assumptions (no prior rule existed — documented, not silent)
1. **Status.** Only `active` distributors may sign in and create orders. This is the first status rule in the system; it is enforced in exactly two places:
   `auth.controller.login` (403 `DISTRIBUTOR_INACTIVE`, checked *after* the password so status never leaks) and `salesOrder.controller.create`
   (403). Existing orders/invoices/payments are never touched. Allowed moves: `pending→active|inactive`, `active↔inactive`; `pending` is initial-only.
2. **Distributor code** is system-generated (model hook) and cannot be supplied or edited, so it cannot be duplicated. Uniqueness is additionally enforced for **email** (case-insensitive) and **GSTIN**.
3. **No login is created.** Admin-created distributors have `password = NULL` and cannot sign in until a login is set up through a separate flow. `login` now returns a clean 401 for a NULL password (previously an exception).
4. **Address.** The schema stores one address, treated as the registered/billing address. A separate shipping address is **not** stored (not added — it would duplicate concepts and nothing downstream uses it).
5. **Credit limit / payment terms** are master data only. Nothing enforces the credit limit on orders yet; the UI says so. Available credit = limit − Accounts Receivable balance, shown only when both exist.
6. **Territory.** Effective territory = `territory`, else `city`, else `region`. The Admin Sales filters and dashboard were updated to use the same expression so a newly assigned territory is reflected in reports.
7. **Retailer mapping is read-only here.** Re-pointing a retailer to another distributor would orphan its price group, ledger and history; retailer creation/transfer belongs to Retailer Management (a later phase).
8. **Schemes** have no data model yet, so the profile shows an explicit "not available" note. **Business activity** is derived from existing documents (no audit-log table exists).
9. **Email is the login identity**; editing it asks for extra confirmation.
10. **Outstanding** uses the Accounts Receivable ledger (same definition as the Admin dashboard). It is `null` — displayed "—" — when no ledger rows exist. Nothing is invented.

## Security
Admin-only (`requireAdmin` on all 7 routes); password hash, reset OTP and expiry are never selected; `no-store` cache header; all SQL parameterised with whitelisted sort columns;
edit path can never change `id`, code, password or status; creates/updates/status changes run in transactions (row lock on update); no delete endpoint exists.
