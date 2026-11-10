# PHASE 23 — Security report
**Not a claim that all security issues are resolved.** Scope: controls verified in code/tests this phase. No penetration test, no production verification.

## 1. Changes made (backend) [CODE][TEST]
| # | Change | Files | Evidence |
|---|---|---|---|
| 1 | Response headers on every API response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; HSTS only in production **and** HTTPS (`req.secure`, honours `TRUST_PROXY`; `HSTS_DISABLED=true` opt-out) | `middleware/securityHeaders.js`, `server.js` | `tests/security-phase23.test.js` (real `server.js` app) |
| 2 | `Cache-Control: no-store` by default on all API responses (authenticated, tenant-specific JSON never cached); a handler's own policy is preserved | same | test incl. override case |
| 3 | CORS accepts a comma-separated `CORS_ORIGIN` list (single value behaves as before; default unchanged) | `server.js` | test: allowed origin echoed with credentials, foreign origin gets none |
| 4 | Production env validation at start-up: requires `JWT_SECRET` (≥32 chars), `DB_HOST/NAME/USER/DIALECT`, `CORS_ORIGIN` (not `*`); warns on localhost CORS, missing `TRUST_PROXY`/`ADMIN_JWT_SECRET`, disabled rate limits. **Names only, never values.** Exits(1) only when `NODE_ENV=production` and an error exists; never affects development/test | `config/envCheck.js`, `server.js` | 4 unit tests. ⚠ A production deployment currently missing one of these would now refuse to start — intended, but check your `.env` first |
| 5 | Upload allow-list (`.xlsx .xls .csv` by extension) in front of all `upload.single("file")` routes; a rejected file leaves `req.file` empty so each controller returns its **existing** 400 | `routes/allRoutes.js` | test: `shell.php` → 400 "Please upload an Excel file". Extension-only check: content is not sniffed |
| 6 | Connection timeouts: `headersTimeout` 60 s, `requestTimeout` 120 s, `keepAliveTimeout` 65 s (env-tunable) | `server.js` | [CODE] only — not load-tested |

## 2. Verified existing controls (no change) [CODE]/[TEST]
Admin JWT uses its own secret and fails closed · Distributor routes scoped by `req.user.id`, cross-tenant tests in existing suites · 401 for anonymous callers on `/api/product`, `/api/customer`, `/api/stockLedger/current`, `/api/admin/me` (new tests) · httpOnly cookies, `secure` in production, `sameSite=lax` · JSON body limit 100 kb → 413; malformed JSON → 400 without stack/path (new tests) · prototype-pollution key rejection on `/api/admin` · rate limiting on login/signup/OTP/reset and ERP/report routes (in-memory, per process) · multer random file names, 10 MB, 1 file · no `console.*` of passwords/tokens/OTP found in auth controllers (`grep`); ERP redaction layer exists · Sequelize used throughout; no raw string-built SQL review beyond spot checks (**not exhaustively audited**).

## 3. Open issues (not fixed) — need decisions
| ID | Sev | Issue | Why not changed |
|---|---|---|---|
| S5 | High | `npm audit --omit=dev`: **backend 8** (critical `proxy-addr`; high `xlsx` (prototype pollution + ReDoS, **no upstream fix**), `nodemailer`, `brace-expansion`; moderate `multer`, `sequelize`, `moment`, `uuid`); **frontend 16** (2 critical, 11 high, mostly `vite`/dev tooling and `jspdf`/`html2pdf` chain) | Fixes include breaking upgrades; run `npm audit fix` in a branch + full regression. Upload filter (change 5) reduces but does not remove `xlsx` exposure |
| S7 | Med | Login/Signup/Forgot/Reset (and other pages) hard-code `http://localhost:5000` | Brief: preserve login flow. Production needs a reverse proxy mapping or a controlled replacement with `VITE_API_BASE_URL` |
| S8 | High | Non-ERP Admin RBAC absent (39 write routes accept any active admin) | **Explicitly out of scope**; ENFORCE mode not enabled, authorization policy unchanged |
| S6 | Info | `middleware/upload.js` unused, unsafe if ever wired | Recommend deletion |
| S9 | Med | Rate limiter is in-memory per process | Needs shared store or proxy limits for multi-instance |
| S10 | Med | **Frontend** security headers (CSP, HSTS, frame-ancestors) must be set by the web server; the static host is outside this ZIP | Sample in `PHASE23_DELIVERABLES.md` (untested) |
| S11 | Low | `ProtectedRoute` trusts `localStorage.user` (UX gate only; real auth is server-side) | By design |
| S12 | Info | No public contact endpoint; if built it needs rate limit, size limit, spam control, no HTML injection into mail | Not built |

## 4. Status
Source-code review **PARTIAL** (targeted, not full) · Automated security tests **COMPLETE** for items above (17 tests) · Security verification on a running production stack **NOT VERIFIED** · Third-party/penetration review **NOT VERIFIED**.
