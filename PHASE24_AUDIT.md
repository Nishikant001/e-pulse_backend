# PHASE 24 — Audit (security, SEO, performance, production hardening)

Start: `secondary_frontend_phase23.zip`, `secondary_backend_phase23.zip`. Status words: COMPLETE, PARTIAL, BLOCKED, NOT VERIFIED, NOT APPLICABLE.

## Findings at the start of Phase 24 (source inspection + reproduction)

| # | Area | Finding | Evidence | Disposition |
|---|------|---------|----------|-------------|
| A1 | API config | 11 files hard-coded `http://localhost:5000/api` (Viewinvoice 3, Invoice 3, Login, Signup, ForgotPassword, ResetPassword, Delivery, DeliveryPage, Customer 1 each) + 2 commented lines. `authFetch.js`/`api.js` already used `VITE_API_BASE_URL` with a localhost fallback. | grep | FIXED (central `src/config/api.js`, build guard) |
| A2 | Phase 23 report correction | Phase 23 said "15 occurrences" and implied login could not work in production. Accurate picture: 11 files, and the shared helpers already honoured the env var. | grep | Corrected here |
| A3 | Security | 65 catch blocks in 15 controllers return `error: error.message` (SQL text / internals can leak on 5xx). | grep | FIXED centrally (`errorSanitizer`) |
| A4 | Security | Express 5 leaves `req.body` undefined for non-JSON bodies; controllers destructure it → 500 on forged text/plain / urlencoded cookie-auth POSTs. | reproduced | FIXED (default `{}`), tests added |
| A5 | Security | Print windows (Viewinvoice, DeliveryPage, Podel) interpolated user-entered text into HTML unescaped (stored XSS in the print window). | source | FIXED (`escapeHtml`) |
| A6 | Security | 39 authenticated Admin write routes have no role guard (exact inventory, see Security report). | `scripts/route-inventory.js` | BLOCKED (needs approved policy) |
| A7 | Dependencies | Frontend 24 advisories (2 critical, 16 high); backend 8. | `npm audit` | Frontend 0; backend 3 remain (see Dependency report) |
| A8 | Migrations | Fresh `db:migrate` fails at migration #1; 8/40 fail over a sync-built schema; 10 `down()` fail. | reproduced on MariaDB 10.11 | DOCUMENTED, no shipped migration edited |
| A9 | DB config | No `DB_PORT` support (non-3306 MySQL/MariaDB impossible). | source | FIXED (optional `DB_PORT`) |
| A10 | Batch Master | `StockMaster.jsx` called `/batch` (no such route) and used `batch.quantity` (no such column). | source | FIXED using `/stock` + ledger balances |
| A11 | Contact form | No endpoint (Phase 23 honest fallback only). | source | FIXED: `POST /api/public/contact`; needs SMTP env to deliver |
| A12 | Dependencies (unused) | 6 frontend deps with zero imports (html2pdf.js, jspdf, pdfmake, qrcode.react, react-qr-code, framer-motion). | grep | REMOVED |
| A13 | Contact UX | A 2xx that is not JSON (e.g. HTML fallback page) would be shown as "sent". | browser QA | FIXED (success requires 2xx + JSON) |
| A14 | Upload | `middleware/upload.js` (no filter, client file name) is unused dead code; live uploads use `routes/allRoutes.js` (extension filter, 10 MB, 1 file, random names). | grep | NOTED; recommend deleting the dead file (not changed) |

## Not changed on purpose
Shipped migrations; Admin RBAC; `sequelize.sync()` as install path; business rules for opening stock / batch deletion.
