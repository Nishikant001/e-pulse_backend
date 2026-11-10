# PHASE 24 — Test Report

Each engine and check is reported separately. Nothing marked COMPLETE unless it was actually run.

| Check | Result | Status |
|---|---|---|
| Source inspection (routes, auth, XSS grep, uploads, config) | done, findings in Audit/Security reports | COMPLETE |
| Backend suite — **SQLite** (in-memory, `NODE_ENV=test`) | 29 suites, **838/838 passed** (804 prior + contact, batch-master, sanitizer/CSRF additions) | COMPLETE |
| Backend suite — **MariaDB 10.11.14** (scratch copy, `sync()` schema, single clean run) | 833/838 passed; **5 failed**: 4 migration up/down tests (Phase 13→14, 14→15, 16, and the `sap_sync_records` migration test — written for SQLite, they also trip the known MariaDB migration defects) and 1 echo-prevention test (DATETIME second precision, see DB report). An earlier overlapped run was discarded as invalid. | PARTIAL |
| Backend suite — **Oracle MySQL 8** | not available in this environment | NOT VERIFIED |
| Frontend unit tests (`npm test`) | 48/48 (API config 5, Batch Master 7, escapeHtml 2, others) | COMPLETE |
| Frontend build + prerender | passes (`VITE_API_BASE_URL=/api`); production build fails on localhost/malformed API URL (verified) and warns when unset | COMPLETE |
| Frontend lint | 33 errors / 9 warnings — pre-existing, unchanged count in Phase 24 files | PARTIAL (not clean) |
| Dependency audits | frontend 0; backend 3 (xlsx unresolved, uuid/sequelize accepted) | PARTIAL |
| Security / authorization regression | in the SQLite suite (cross-tenant 404, unauth 401, ERP RBAC, CSRF, sanitizer, contact abuse) | COMPLETE for tested routes |
| API config tests | 5 unit + build-guard manual verification | COMPLETE |
| SEO dist verification (`npm run verify:dist`) | 106/106 with `VITE_SITE_URL` set | COMPLETE |
| API E2E on real server + MariaDB (`docs/scripts/phase24_e2e_api.sh`) | 15/15: signup, 401 without cookie, bad password, login, httpOnly cookie, CORS (allowed/foreign/preflight), no-store, refresh-token, logout, contact 503 | COMPLETE |
| Browser E2E (Chromium, built app, same-origin `/api` proxy to real backend) | 20/20: login/logout, silent token refresh, Batch Master create/validate/edit/delete rules, ledger balance 70, cross-Distributor isolation, no `localhost:5000` requests | COMPLETE |
| Public site browser QA + axe | 78/78 (9 routes, headings, a11y, mobile menu, JS-disabled, contact states) | COMPLETE |
| Contact against real backend (SMTP unset) | 503 → "nothing was sent", no success claim | COMPLETE; 202 delivery path only via mock transport in jest |
| Migration tests (MariaDB) | fresh fails; 32/40 up over sync schema; 30/40 down | see DB report |
| Production deployment | none performed | NOT VERIFIED |
| Real ERP connectivity | no ERP available | NOT VERIFIED |
