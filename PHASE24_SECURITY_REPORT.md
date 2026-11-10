# PHASE 24 — Security Report

## Scope reviewed (source inspection + automated tests)
Authentication, authorization, tenant isolation, ERP RBAC, input validation, SQL injection, XSS, CSRF, CORS, headers, rate limits, uploads, error messages, log/secret leakage.

## Route inventory (exact; `scripts/route-inventory.js`, run against the real routers)
- Distributor API: 186 routes; only the 7 auth routes (signup, login, logout, refresh-token, forgot/reset password, …) are unauthenticated — every other route runs `authMiddleware`.
- Admin API: 128 routes; 55 write verbs. 3 public (`POST /login`, `POST /logout`, `GET /session`). 14 writes carry the ERP role guard. **39 authenticated writes have NO role guard** — Phase 22's "~39" is confirmed exactly. Of those, 2 are compute-only (`POST /sales/orders/preview`, `POST /schemes/evaluate`); 37 change state. Breakdown: masters 13, sales 8, claims 5, retailers 4, schemes 4, distributors 3, accounts 2. Full list: `docs/phase24_admin_unguarded_writes.txt`.
- **BLOCKED — Admin RBAC for those 39 routes.** Impact: any signed-in Admin can perform them. Required decision: an approved permission matrix (which Admin roles may do which writes). No roles were invented and no enforcement was enabled (14+39+2 = 55).

## Changes made
| Item | Change | Tests |
|---|---|---|
| Error leakage | `middleware/errorSanitizer.js`: 5xx JSON bodies lose `details/stack/sql/original/parent/errors`; message becomes "Internal error" + correlationId. `EXPOSE_ERROR_DETAILS=true` opts out (dev). | 5 tests incl. forced DB failure through the real app |
| Non-JSON body 500 | `req.body` defaults to `{}` | CSRF tests |
| CSRF posture | cookie `httpOnly`, `sameSite=lax`; JSON-only body parsing; CORS allow-list. text/plain & urlencoded cookie POSTs → 400; foreign-origin preflight not approved. No CSRF token was added (not needed with these controls; a design decision to revisit if cookies move to `sameSite=none`). | tests |
| XSS | grep: no `dangerouslySetInnerHTML`/`innerHTML`; 3 `document.write` print windows now escape user text (`src/utils/escapeHtml.js`). | 2 unit tests |
| Contact endpoint | `POST /api/public/contact`: type checks, CR/LF flattening (header injection), length limits, honeypot, per-IP rate limit (5/15 min, `RATE_LIMIT_CONTACT_PER_15MIN`), 503 when SMTP unset, 502 generic on failure, no PII in logs. | `contact-phase24.test.js` |
| DB port | optional `DB_PORT` | verified on port 3307 |

## Authorization / isolation tests
- Batch Master: cross-Distributor read/update/delete → 404; unauthenticated → 401 (`batch-master-phase24.test.js`); browser E2E: second Distributor sees an empty list and gets 404 by id.
- Existing Phase 17/23 ERP RBAC and tenant tests still pass (838/838 on SQLite). No middleware was weakened.

## Remaining / not verified
- Rate limiter is in-memory per process (multi-instance needs a shared store) — PARTIAL.
- Frontend web-server headers (CSP, HSTS, etc.) must be set at the host/reverse proxy; the repo ships none — PARTIAL (the API has its own header middleware from Phase 23).
- Uploads: live path filtered/limited; `middleware/upload.js` is dead and unsafe if ever wired — recommend deletion.
- `xlsx` advisories (prototype pollution, ReDoS) remain — see Dependency report.
- No penetration test, no production environment — NOT VERIFIED.
