# PHASE 23 — Public website report
## Status: **COMPLETE** (code) · browser verified on headless Chromium only · content inputs **required** (see §5)

## 1. What was built [CODE][BROWSER]
Nine public routes, all reachable without authentication, prerendered at build time, hydrated in the browser:
`/` Home · `/features` · `/modules` · `/solutions` · `/about` · `/faq` · `/contact` · `/privacy` · `/terms` (+ public 404 for unknown URLs).
Home contains: sticky nav with brand mark, hero (two CTAs → Contact / existing login), illustrative product preview, 8 benefits, 5-step workflow, module highlights with status badges, ERP/SAP section (implemented vs not verified vs not available), security & operations, FAQ (4 + link), final CTA, footer (product, company, Distributor/Admin sign-in, Privacy, Terms).
Login: **unchanged** (`/login`, `/admin/login`); the website links to them. No new auth, no retailer portal.

## 2. Design [CODE]
Existing tokens only (brand-50…900, canvas/surface/line/ink, radius-card, shadow-card/hover). Hero uses two soft brand radial gradients; one deep-blue CTA band. Same brand mark as the sidebar. No new fonts/colours/libraries. Product preview is an **HTML/CSS illustration labelled "placeholder shapes, not real data"** — no fake metrics. Screenshots reviewed at 375/768/1280/1536 px.

## 3. Motion & interaction [CODE][BROWSER]
CSS only (no animation bundle): hero rise-in (560 ms, once), reveal-on-scroll (content visible by default; armed only for below-fold blocks; 3 s safety reveal; above-viewport blocks reveal immediately), card hover lift, button press, animated underline links, animated mobile-menu height, preview bars grow once, very slow float on hover-capable ≥1024 px. `prefers-reduced-motion` disables all (verified: 0 hidden blocks). No parallax/scroll-jacking/looping flashes.

## 4. Routing & access boundaries [CODE][BROWSER]
* `App.jsx` = public routes (eager) + one lazy `PrivateApp` (the original route table moved **verbatim**, minus the `/` redirect and the Router wrapper). Existing URLs: `/login /signup /forgot-password /reset-password /admin/* /dashboard/*` unchanged.
* Verified in browser: `/dashboard` and `/dashboard/inventory/current` without session → `/login`; `/admin/dashboard` with unauthenticated session response → `/admin/login`; `/admin/dashboard` with backend unreachable → existing "Unable to verify your session" screen (fail-closed, unchanged).
* No tenant data, internal API or ERP config is referenced by public pages (they import only static content).
* Behaviour change to note: **`/` used to redirect to `/login`; it now shows the Home page.**

## 5. Claims register & required inputs
Every claim in `src/public/content.js` was taken from code/docs (inventory ledger, FEFO, sales/purchase chains, returns with over-return protection, GST via HSN, two portals, cross-tenant tests, rate limits, correlation IDs, ERP module). Guard test `content honesty` rejects percentages, customer counts, certifications, "guarantee". Explicitly **not** claimed: any certification, customer, statistic, live-ERP verification, invoice/return/document sync, Oracle/Dynamics/SOAP, reporting packs (shown "Planned"), RBAC for non-ERP Admin functions.
**Required inputs (not invented):** `VITE_SITE_URL`, `VITE_COMPANY_LEGAL_NAME`, `VITE_COMPANY_ADDRESS`, `VITE_CONTACT_EMAIL`, optional `VITE_CONTACT_ENDPOINT`; About page company history/leadership (marked editable block); approved Privacy/Terms text (drafts, marked "not legal advice", **noindex**, excluded from sitemap).

## 6. Contact form [CODE][BROWSER][TEST]
Client validation (name, email format, message 20–2000, optional phone, consent), error summary with focus, `aria-invalid/describedby`, honeypot. **No backend contact endpoint exists** ([TEST] `/api/contact` etc. → 404). Therefore: with `VITE_CONTACT_ENDPOINT` → POST, success only on 2xx, failure state otherwise; with only `VITE_CONTACT_EMAIL` → "ready but NOT sent — open in your email app" (mailto); with neither → plain notice and "nothing was sent". Verified in browser that a valid submit never shows a success message when unconfigured. **Missing integration: a server endpoint (with rate limit, spam control, mail delivery) must be built and approved.**

## 7. Changed / new files
New: `src/public/**` (siteConfig, seo, content, contactValidation, public.css, PublicRoutes, 9 pages, 7 components, `public.test.mjs`), `src/PrivateApp.jsx`, `src/entry-server.jsx`, `scripts/prerender.mjs`, `public/favicon.svg`, `.env.example`, `docs/scripts/phase23_browser_qa.mjs`.
Modified: `src/App.jsx` (public routes + lazy private), `src/main.jsx` (hydrate when prerendered), `src/components/feedback/ToastProvider.jsx` (portal after mount — fixes hydration mismatch), `index.html` (favicon, noindex shell), `public/robots.txt`, `package.json` (scripts), `public/vite.svg` removed.
