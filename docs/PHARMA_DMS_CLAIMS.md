# Phase 11 — Claims Management

## Findings from inspection
- No claim model, no notification backend (only a frontend bell with sample data), no audit-log table, and no secure upload infrastructure existed. The only upload code is `middleware/upload.js` (accepts any file type, stores under the original name) and CSV bulk-upload endpoints — unsuitable for claim evidence.
- Invoices do not record which scheme was applied, so a claim's eligibility is **re-derived from the Phase 10 Scheme Engine at the invoice date**; nothing is duplicated.
- Existing returns/credit notes/accounting were not touched.

## Claim types
**Scheme claims only.** A Distributor claims the scheme benefit (free goods value or discount) it already gave on a **posted** invoice (POSTED / PARTIALLY_PAID / PAID). Free-goods and discount claims are the two benefit kinds inside a scheme claim. Sales-promotion and return-related claims are not supported (no business definition exists).

## Data model (migration `20261004090000-claims-phase11.js`; additive, idempotent, reversible)
`Claims`, `ClaimItems` (one per invoice line), `ClaimStatusHistories` (append-only). IDs only — Distributor, Customer (retailer), Scheme, Invoice and Product are referenced, not copied. `scheme_snapshot` stores the scheme rule as it was at submission.

## Workflow (backend-enforced, optimistic-locked)
DRAFT →(distributor) SUBMITTED →(admin) UNDER_REVIEW →(admin) APPROVED | REJECTED | NEEDS_CORRECTION →(distributor) RESUBMITTED →(admin) UNDER_REVIEW.
APPROVED and REJECTED are terminal. There is no generic "set status" endpoint. A wrong-state action returns 409; the wrong actor 403. Draft / needs-correction claims are the only editable ones. Reject and needs-correction require a reason (≥ 5 chars).

## Eligibility, amount and duplicates
- The Distributor chooses invoice, scheme, period, description and per-line purchased quantity. **distributor_id, customer_id, claim_amount and status in a request body are ignored.** Distributor comes from the session, retailer from the invoice, amount from the engine (free quantity × invoice unit price, or the discount amount).
- Checked on save (as issues), required clean on **submit/resubmit** and re-checked on **approve** against current data: invoice belongs to distributor and is posted; lines belong to the invoice; quantity ≤ invoiced; invoice date within the claim period; the claimed scheme is the one the engine applies (not inactive/expired/ineligible, not outranked by a higher-priority scheme, no priority conflict); duplicate; non-empty description (approval); amount unchanged since submission.
- **Duplicate key (assumption, documented):** (invoice line, scheme) may appear in only one claim that is not REJECTED (drafts count).

## API
Admin (`requireAdmin`): `GET /api/admin/claims`, `/lookups`, `/:id`; `POST /:id/review`, `/approve`, `/reject`, `/needs-correction`.
Distributor (existing auth; own claims only, other distributors' claims answer **404**): `GET /api/claims`, `/lookups`, `/invoices/:invoiceId/lines`, `/:id`; `POST /api/claims`; `PUT /:id`; `POST /:id/submit`, `/:id/resubmit`.

## UI
Admin `/admin/claims`, `/admin/claims/:id` (tabs: Details / Items / History; decision dialogs). Distributor `/dashboard/claims`, `/new`, `/:id`, `/:id/edit`. Claims is live in both navigations.

## Known limitations
- **Documents / uploads: not implemented** (see findings) — secure, typed, size-limited, tenant-isolated storage needs its own design; there is no attachment field.
- **Notifications: not implemented** — no backend notification system exists.
- **Audit:** the claim status history table is the audit trail (actor, from/to, comment, time). There is no global audit log; admin actions are also written to the server log.
- Eligibility uses the scheme's **current** definition evaluated at the invoice date; a scheme edited or deactivated after the invoice can make an old claim ineligible (approval then fails with reasons). Invoices do not store the applied scheme yet.
- Approval does not create any payment, credit note or accounting entry (Phase 12). Claim amount is informational.
- Rejected claims are final; the distributor creates a new claim to retry.
- A partially-claimed line is not supported (one claim per line+scheme).
