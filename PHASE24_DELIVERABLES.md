# PHASE 24 — Deliverables

Archives: `secondary_frontend_phase24.zip`, `secondary_backend_phase24.zip`. Reports: PHASE24_AUDIT / SECURITY_REPORT / DEPENDENCY_REPORT / DATABASE_MIGRATION_REPORT / SEO_REPORT / PERFORMANCE_REPORT / TEST_REPORT / DELIVERABLES (copied into both archives).
Excluded from archives: `node_modules`, `dist`, `dist-ssr`, `.git`, `uploads` contents, real `.env`, logs. No credentials included.

## Status by category
| Category | Status |
|---|---|
| Source inspection | COMPLETE |
| Automated tests (SQLite) | COMPLETE (838/838) |
| Automated tests (MariaDB) | PARTIAL (833/838; 5 documented) |
| Automated tests (Oracle MySQL 8) | NOT VERIFIED |
| Build / lint | build COMPLETE; lint PARTIAL (33 pre-existing errors) |
| Dependency audits | PARTIAL (xlsx open) |
| Security tests | COMPLETE for tested scope; Admin RBAC BLOCKED |
| Browser verification | COMPLETE (Chromium, 20/20 + 78/78) |
| Production deployment | NOT VERIFIED |
| Real ERP connectivity | NOT VERIFIED |

## Changed files — frontend (vs Phase 23)
Modified: `.env.example`, `package.json`, `package-lock.json`, `vite.config.js`, `docs/scripts/phase23_browser_qa.mjs`, `src/utils/api.js`, `src/utils/authFetch.js`, `src/public/siteConfig.js`, `src/public/pages/Contact.jsx`, `credential/{Login,Signup,ForgotPassword,ResetPassword}.jsx`, `dashboard/pages/{Customer,Delivery,Invoice,StockMaster,Viewinvoice}.jsx`, `delivery/podelivery/Podel.jsx`, `delivery/sodelivery/DeliveryPage.jsx`.
Added: `src/config/api.js`, `src/config/api.test.mjs`, `src/utils/escapeHtml.js`, `src/utils/escapeHtml.test.mjs`, `dashboard/pages/batchMaster.js`, `dashboard/pages/batchMaster.test.mjs`, `scripts/verify-dist.mjs`, `docs/scripts/phase24_{browser_e2e,contact_real,serve}.mjs`, 8 reports.

## Changed files — backend
Modified: `config/config.js`, `config/db.config.js`, `models/index.js`, `server.js`, `package.json`, `package-lock.json`, `tests/security-phase23.test.js`.
Added: `controllers/public.contact.controller.js`, `services/contact.service.js`, `routes/publicRoutes.js`, `middleware/errorSanitizer.js`, `scripts/route-inventory.js`, `scripts/migration-audit.py`, `tests/contact-phase24.test.js`, `tests/batch-master-phase24.test.js`, `docs/phase24_admin_unguarded_writes.txt`, `docs/scripts/phase24_e2e_api.sh`, 8 reports.

## Exact deployment environment
Frontend (build-time, public values only — never secrets): `VITE_API_BASE_URL` (e.g. `https://api.example.com/api`, or unset for same-origin `/api` behind a reverse proxy; localhost rejected in production builds), `VITE_SITE_URL`, `VITE_COMPANY_LEGAL_NAME`, `VITE_COMPANY_ADDRESS`, `VITE_CONTACT_EMAIL`, `VITE_CONTACT_ENDPOINT` (`off` to disable).
Backend: `DB_HOST DB_PORT(optional) DB_USER DB_PASSWORD DB_NAME DB_DIALECT`, `JWT_SECRET`, `ADMIN_JWT_SECRET`, `CORS_ORIGIN` (comma list of the frontend origin(s)), `PORT`; contact: `CONTACT_TO_EMAIL CONTACT_SMTP_HOST CONTACT_SMTP_PORT CONTACT_SMTP_SECURE CONTACT_SMTP_USER CONTACT_SMTP_PASS CONTACT_FROM_EMAIL` (unset ⇒ API answers 503, UI says nothing was sent); optional `RATE_LIMIT_CONTACT_PER_15MIN`, `UPLOAD_MAX_BYTES`, `EXPOSE_ERROR_DETAILS` (never in production).

## Remaining blockers — NOT production-ready
1. Admin RBAC for 39 unguarded write routes — needs approved permission policy.
2. Fresh-install path (migrations cannot build a new DB) — needs approval of sync+snapshot or a baseline migration.
3. 10 failing `down()` migrations — release decision.
4. `xlsx` advisories unresolved.
5. SMTP/contact infrastructure, production domain, company details, og:image not supplied.
6. In-memory rate limiter (single instance only); frontend host headers/CSP/caching not configured.
7. Oracle MySQL 8, production deployment and real ERP: NOT VERIFIED. MariaDB echo-prevention test failure open.
8. Lint errors (33) pre-existing.
