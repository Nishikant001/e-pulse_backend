# PHASE 23 — Deliverables
**Outcome:** public website, SEO prerender, backend hardening and route-level code splitting implemented on top of Phase 22. Existing business functionality, authentication, Distributor isolation and ERP RBAC untouched. **Production readiness is NOT claimed.**

## 1. Status
| Area | Status |
|---|---|
| Public website (9 pages + 404) | COMPLETE (code; headless-Chromium verified) |
| Technical SEO (prerender, robots, sitemap, canonical, OG, JSON-LD) | COMPLETE; **needs `VITE_SITE_URL`** to emit canonical/sitemap/JSON-LD |
| Contact form | PARTIAL — validated UI; **no backend endpoint exists**, no delivery claimed |
| Legal pages | PARTIAL — editable draft templates, noindex, not legally reviewed |
| About page company facts | PARTIAL — none supplied; editable block |
| Backend hardening (headers, no-store, CORS list, env check, upload filter, timeouts) | COMPLETE (tested); timeouts [CODE] only |
| Dependency vulnerabilities | **BLOCKED** — upgrade decision (security report S5) |
| Hard-coded `localhost:5000` in login/pages | **OPEN** — not changed by design |
| Admin RBAC / fresh-install migration path / Batch Master | **Unchanged, OPEN** (Phase 22 D6, D4, D2) |
| Performance | PARTIAL — bundle measured (entry 431 → 97 kB gzip); runtime metrics NOT VERIFIED |
| MariaDB / MySQL 8 / production / real ERP | NOT VERIFIED |

## 2. Reports
`PHASE23_AUDIT.md` · `PHASE23_PUBLIC_WEBSITE_REPORT.md` · `PHASE23_SEO_REPORT.md` · `PHASE23_SECURITY_REPORT.md` · `PHASE23_PERFORMANCE_REPORT.md` · `PHASE23_TEST_REPORT.md` (copies in both ZIPs).

## 3. Backend changes (summary)
New: `middleware/securityHeaders.js`, `config/envCheck.js`, `tests/security-phase23.test.js`. Modified: `server.js`, `routes/allRoutes.js` (upload filter). No model, migration, route, permission or calculation changed. No new dependency.

## 4. Frontend changes (summary)
See Public-website report §7. No new runtime dependency; `package.json` gains scripts only (`build` now also prerenders; `build:spa` = old behaviour; `test`).

## 5. Deploy notes (untested sample — adapt and verify)
Build: `VITE_SITE_URL=https://<your-domain> npm run build` → serve `dist/`.
```nginx
root /var/www/pharma-dms/dist;
location / { try_files $uri $uri/index.html /app-shell.html; }   # prerendered public routes; private routes get the noindex shell
location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
location = /index.html { add_header Cache-Control "no-cache"; }
location /api/ { proxy_pass http://127.0.0.1:5000; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
add_header X-Content-Type-Options nosniff always;  add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header X-Frame-Options DENY always;            add_header Strict-Transport-Security "max-age=15552000" always;  # only once HTTPS is final
# A CSP for the SPA must be designed and tested against the app (inline styles from charts/PDF libs) — not supplied.
```
Backend production env: `NODE_ENV=production`, `JWT_SECRET` (≥32), `ADMIN_JWT_SECRET` (≠ JWT_SECRET), `DB_*`, `CORS_ORIGIN`, `TRUST_PROXY=1`. Because the app currently calls `http://localhost:5000` directly (S7), serving the frontend and API on one origin via the proxy still **requires a decision on that URL**.
**Rollback:** redeploy the previous frontend `dist/` (old `/` → login behaviour returns) and the Phase 22 backend; no schema or data change was made.

## 6. Decisions needed
1. Production domain, legal entity, address, contact e-mail; approved Privacy/Terms text; brand logo/OG image.
2. Contact delivery: build a backend endpoint (design, rate-limit, mail service) or use mailto.
3. Dependency upgrade plan (xlsx replacement; `npm audit fix` regression).
4. Replace hard-coded API URLs with `VITE_API_BASE_URL` (touches login pages).
5. Phase 22 items still open: RBAC matrix, fresh-install strategy approval, Batch Master option.

## 7. Packages
`secondary_frontend_phase23.zip`, `secondary_backend_phase23.zip` — complete project trees (no `node_modules`, `dist`, `.env`, uploads or caches). Extract at a project root; run `npm ci`.
