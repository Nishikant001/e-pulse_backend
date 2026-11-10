# Phase 9 — Retailer Management (design notes & assumptions)

## Business model
A **retailer is a `Customer` row**; `Customer.distributor_id` is the owner. No `Retailer` table was created.
**No retailer login / authentication / dashboard / portal / JWT / password exists** — `Customer` has no password field, and there is no retailer route or auth handler (asserted by a test).

## Reused (not rebuilt)
`Customer` (name, `taxNumber`=GSTIN, city, `region`=state, street1–4, `pincode`/`postalCode`, `alternatePhone`, `customer_code`, `distributor_id`, `customer_group_id`) ·
`Address` rows (`ship_to_party` = shipping address) · `CustomerGroup` (per distributor) · Distributor `authMiddleware` · Admin `requireAdmin` · Phase 7/8 UI kit and `useMastersList`.
The legacy `/api/customer` CRUD (used by the old "Customer Master" screen) is untouched apart from one safety guard (below).

## Migration (`20261002090000-retailer-management-phase9`)
Adds to `Customers`: `contact_person`, `phone_number`, `email`, `pan`, `territory`, `status` (`active|inactive|pending`, default `active`), `status_reason`, `status_changed_at`.
Idempotent, reversible; existing rows become `active`.

## Who can do what
| | Admin (`/api/admin/retailers/*`) | Distributor (`/api/retailers/*`) |
|---|---|---|
| List / search / filter / sort / paginate | all retailers; filter by distributor | **only own** (`distributor_id` pinned from the token) |
| View details + business summary | any | own only (403 otherwise) |
| Create | picks the distributor; may set status | auto-owned by the caller; status forced `active` |
| Edit | any (never changes ownership) | own only; never changes ownership |
| Activate / deactivate | any (incl. approving `pending`) | own only; cannot approve `pending` |
| Change distributor | **yes** (`POST /:id/assign`) | **no route exists** |

## Security rules
- Scope is built from the authenticated session (`req.admin` / `req.user`), never from body, query or params.
- A distributor sending `distributor_id`, `distributorId` or `distributor_code` of someone else gets **403** (create and edit); its own id is harmless. `distributor_id` in a distributor's *query string* is ignored.
- Wrong owner on an existing retailer → **403** with a generic message and no retailer data; non-existent id → 404.
- The distributor controller re-reads the distributor's status on every call, so a deactivated distributor is locked out of retailer data immediately (not only at login).
- `requireAdmin` ignores the Distributor cookie/bearer; all 7 admin routes are guarded (test).
- Edit can never change `id`, `customer_code`, `distributor_id` or `status`. An admin who sends a different `distributor_id` to *edit* is told to use "Change distributor".
- No delete endpoint. The **legacy** `DELETE /customer/:id` now returns 409 for a retailer that has any order / invoice / return / ledger history (deactivate instead).

## Assumptions (no prior rule existed — documented, not silent)
1. **Inactive/pending retailers cannot receive NEW orders** (`salesOrder.create` → 409). Nothing existing is changed for `active` retailers; history is untouched.
2. **Distributor may deactivate/reactivate its own retailers**, but only the Admin approves a `pending` one. Distributor-created retailers are `active`.
3. **Reassignment (Admin only)** requires choosing a customer group of the new distributor (groups are per-distributor and `customer_group_id` is mandatory). It is **refused while the retailer has open orders (draft/confirmed/partially delivered), unpaid invoices, or a non-zero Accounts Receivable balance** — payments and ledger screens look the customer up under its current distributor, so moving it mid-flight would strand that money. The refusal message lists what blocks it.
4. After reassignment, historical documents keep the distributor that issued them. The **new** owner does not see the previous distributor's paperwork; the Admin sees everything.
5. **GSTIN uniqueness is per distributor** (customers are per-distributor rows, so the same pharmacy can legitimately be a customer of two distributors). Duplicate detection across distributors is not enforced.
6. **Shipping address** = the existing `Address` row of type `ship_to_party`; billing = the customer's own address fields. "Same as billing" removes the shipping row (only that row — other address types are never touched).
7. **Credit limit** is not a Customer field and is not enforced (out of scope); the profile says so. **Schemes** are not shown.
8. An Admin cannot assign a *new* retailer to, or move one to, an **inactive** distributor.
9. `pincode` and `postalCode` both exist on the table; both are written with the same value.

## Known limits
- `customer_code` is `STRING(6)` and generated globally as `CTR###` → the platform-wide ceiling is `CTR999` (existing behaviour, not changed).
- The legacy "Customer Master" screen (`/dashboard/customer`) still exists; its create form sends `customer_group` rather than `customer_group_id`. The new **Retailer List** is the supported path.
- Legacy `POST /customer` spreads the request body into `Customer.create` (existing; `distributor_id` and code are still overwritten server-side). Use the new endpoints going forward.
