# PHASE 23 — Test report
Evidence classes are kept separate. Commands run from each project root.

## 1. Automated tests
| Suite | Command | Result |
|---|---|---|
| Backend (SQLite in-memory) | `npx jest --runInBand` | **27 suites, 804 / 804 passed** (787 baseline + 17 new in `tests/security-phase23.test.js`); 344 s |
| Frontend unit | `npm test` (`node --test`) | **34 / 34 passed** (21 baseline + 13 new in `src/public/public.test.mjs`) |
| Frontend build | `npm run build` | OK (client + SSR + 9 routes prerendered); with `VITE_SITE_URL=https://example.test` sitemap written; without it warning printed |
| Frontend lint | `npx eslint .` | **33 errors / 10 warnings — identical to baseline**; new/changed files add none |
New backend tests cover: security headers, no-store (and override), HSTS gating, JSON 404/400/413 shapes, anonymous 401s on private routes, no public contact endpoint, CORS allow/deny, upload filter, `validateEnv`. New frontend tests cover: route/title/description uniqueness, private-path exclusion, sitemap exclusion of private routes, robots, canonical/noindex rules, JSON-LD limits, head injection (incl. escaping), shell noindex, contact validation, mailto encoding, content-honesty guards.

## 2. Browser verification (headless Chromium via Playwright-core; script `docs/scripts/phase23_browser_qa.mjs`, serves `dist/` with an nginx-style fallback) — **78 / 78 checks passed** on the final build
* 9 public routes × widths 375/768/1280/1536: renders, exactly one `<h1>`, no redirect, no horizontal scroll, **no console errors or hydration errors**.
* axe-core (WCAG 2 A/AA, 2.1 AA) at 375 and 1280 on all 9 routes: **0 violations**. (Automated checks cover only part of WCAG; manual screen-reader testing **NOT VERIFIED**.)
* Boundaries: `/dashboard`, deep link `/dashboard/inventory/current` → `/login`; `/admin/dashboard` → `/admin/login` (session endpoint stubbed as unauthenticated); login page renders; home "Sign in" → `/login`; unknown URL → public 404; robots/sitemap content.
* Contact: empty submit → error summary + 4 field errors + focus; valid submit with no delivery configured does **not** show success.
* Mobile menu: inert when closed, `aria-expanded`, Escape closes and restores focus, header touch targets ≥ 40 px; first Tab = skip link; reduced-motion hides nothing; JS-disabled prerendered content present; scroll reveal completes.
* Not covered: real devices, Safari/Firefox, authenticated flows against a live backend, visual regression, cross-browser animation, print.

## 3. Status table
| Item | Status |
|---|---|
| Source-code inspection | COMPLETE (targeted) |
| Automated tests | COMPLETE — all pass |
| Frontend production build | COMPLETE |
| Lint | PARTIAL — pre-existing 33/10 not fixed (unchanged) |
| SEO implementation checks | COMPLETE (unit + file inspection); live crawl NOT VERIFIED |
| Browser & responsive | COMPLETE for headless Chromium only |
| Accessibility checks | PARTIAL — automated axe + keyboard checks; manual AT NOT VERIFIED |
| Security verification | PARTIAL (see security report) |
| SQLite tests | COMPLETE |
| MariaDB tests | NOT VERIFIED (not run this phase; no DB-affecting change) |
| Oracle MySQL 8 tests | NOT VERIFIED |
| Production deployment verification | NOT VERIFIED |
| Real ERP verification | NOT VERIFIED |
