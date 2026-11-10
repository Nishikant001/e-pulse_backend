# Phase 12 — Accounts & Financial Management

## What was inspected first (and reused)
- `services/accounting.service.js` (GL lookup, `assertBalanced`) — **extended**, not duplicated.
- `JournalEntry` + `GLMaster` — the only ledger. "Accounts Receivable" balance = the existing definition of outstanding (also used by the Admin dashboard / Distributor detail).
- `SalesInvoiceHeader` (`dueDate`, `outstandingAmount`, `paymentTerms`), `SalesCreditNote` (+ return-generated notes), `Distributor.credit_limit` / `payment_terms`.
- `POST /api/payment/receive` (legacy receipt → `CUSTOMER_PAYMENT` journal rows). Kept working; its receipts are included in outstanding and the ledger.
- Phase 11 claims, Phase 10 scheme engine — untouched except for the approval hook below.

## Facts found that shaped the design
- There was **no payment table**; payments existed only as journal rows. → `Payments` + `PaymentAllocations` added (minimal).
- `Invoice.outstandingAmount` was set at posting but **never reduced** by anything. → now refreshed on allocation and on credit-note posting.
- Retailers (`Customers`) had **no credit-limit field**. → `Customers.credit_limit` added. Distributors reuse the existing column.
- Tenant = distributor (`distributor_code` on GL/journal). Admin sees all distributors; every write derives the tenant from the retailer/claim row.
- Return / credit-note / debit-note flows only accept an invoice with status `POSTED`, so the invoice **status is not changed** to PARTIALLY_PAID/PAID (that would block returns). Payment state is derived (`UNPAID / PARTIALLY_PAID / PAID`).

## Outstanding
Per retailer: `invoice open = total − POSTED credit notes − payments allocated to it`.
Credits that are not tied to an invoice (legacy receipts, the unallocated part of a payment) are applied to the **oldest-due invoices first** so ageing/overdue agree with the ledger; any excess is shown as **advance**. Debits not tied to an invoice (debit notes) are shown as other charges. Result: `Σ outstanding − advance = Accounts Receivable ledger balance`, asserted in tests.

## Payments & allocation
`POST /api/admin/accounts/payments` — one transaction: Payment → Allocations → journal (Dr Cash/Bank, Cr Accounts Receivable, `CUSTOMER_PAYMENT`) → invoice balance refresh. Validates retailer/tenant, amount (>0, ≤2 dp, bounded), date (not future), mode (Cash, Bank transfer, UPI, Cheque, Other), reference (required for bank/UPI/cheque; unique per distributor — DB unique index), allocations (≤ each invoice's open amount, ≤ payment, no duplicates, only that retailer's live invoices). `autoAllocate:true` fills oldest-due first. **Overpayment/advance is supported**: the unallocated remainder stays on the account as unapplied credit.

## Claim → accounting (decision)
No existing rule defined the treatment, so: an approved scheme claim means the **company owes the distributor** the benefit it funded.
```
Dr Scheme Claims Receivable   (asset)   amount
    Cr Scheme Claim Income    (income)  amount      reference_type CLAIM_SETTLEMENT, reference_no SET-<claim number>
```
Booked in the claim's own distributor. It is **not** a credit note and **not** netted against retailer outstanding (the retailer neither owed nor paid it); it is shown on its own ledger account and as "claim settled" beside outstanding. The two GL accounts are auto-provisioned per distributor on first use.
- Happens inside `POST /api/admin/claims/:id/approve` — same transaction as the status change. If posting fails the approval rolls back. No second approval endpoint.
- Link: `Claims.settlement_reference` (UNIQUE) = journal `reference_no`; plus `settled_at`, `settled_by_admin_id`.
- **Idempotent**: settlement claims the row with `UPDATE … WHERE status='APPROVED' AND settled_at IS NULL`; zero rows → 409. Unique reference as a second DB-level guard. A race test shows exactly one settlement.
- Reject / needs-correction / review / resubmit / draft never post anything.
- `POST /api/admin/claims/:id/settle` exists only for claims approved before Phase 12 (shows "pending settlement"); not an approval; 409 if already settled.

## Ageing
Buckets: Current/Not due · 1–30 · 31–60 · 61–90 · 91–180 · 180+, from `dueDate` (falls back to invoice date + payment terms, default 30 days, only if the due date is missing). Per retailer or per distributor; `asOf` supported.

## Credit
`available = limit − current outstanding (AR ledger balance)`. Admin sets/clears limits (`PUT /api/admin/accounts/credit/:entityId`). **Not enforced on orders** — Phase 8 recorded it as informational and no business rule requires blocking; enforcement is a business decision (hard block vs. approval) and is left as future work. A test asserts order creation is unaffected.

## API
Admin (`requireAdmin`): `GET /api/admin/accounts/{lookups,summary,outstanding,ageing,ledger,credit,open-invoices,payments,payments/:id}`, `POST …/payments`, `PUT …/credit/:entityId`, `POST /api/admin/claims/:id/settle`.
Distributor (existing auth, **GET only**, own data): `GET /api/accounts/{lookups,summary,outstanding,ageing,ledger,credit,payments,payments/:id}`.

## Authorization
Distributor scope comes only from the token; `distributorId`/`retailerId`/`entityId` in a query is cross-checked or ignored; another distributor's retailer/ledger/payment answers 404/empty. No distributor handler can write. Admin routes are asserted to sit behind `requireAdmin`. A body `distributorId` on a payment is only cross-checked against the retailer's real distributor.

## Frontend
Admin: `/admin/accounts` (+ `/outstanding /ageing /ledger /payments /credit`). Distributor (read-only): `/dashboard/finance/*`. No retailer screens. Money is ₹ INR via `formatINR`; KPIs come from `/summary`, empty state shows ₹0.

## Known limitations / future work
- Payments cannot be cancelled/reversed yet (status is POSTED only); reversal is future work.
- Credit limit not enforced (above). Retailer limit is informational.
- Legacy Distributor-portal "Payments" (`/payment/receive`) does not write `Payments` rows (it still affects outstanding via the journal, applied FIFO). Unifying it is future work.
- Retailer-level outstanding with an invoice-date window excludes unapplied credits/advances.
- Remaining claim-settlement cash movement (company actually paying the distributor) is not modelled — only the receivable is booked.
- **Deferred from Phase 11 (not implemented here):** claim document upload, backend notifications, global audit log. Audit relies on `created_by_admin_id`, claim status history, and journal references.
- Frontend verified by lint + `vite build`, not exercised in a browser.
