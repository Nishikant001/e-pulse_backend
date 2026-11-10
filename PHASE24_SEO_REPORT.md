# PHASE 24 — SEO Report

Verified by `npm run verify:dist` against the **rendered, prerendered `dist/`** (not just source): **106/106 checks pass with `VITE_SITE_URL` set; with it unset the checks assert the unset state** (no canonical/JSON-LD/sitemap emitted rather than a wrong domain). Browser QA on the same build: 78/78.

| Item | Result |
|---|---|
| Titles | unique per public page (9), checked in browser and in dist |
| Meta descriptions | present on all indexable pages |
| Canonical | emitted only when `VITE_SITE_URL` is set; absolute, matches route |
| Open Graph / Twitter | title, description, url, type; **no `og:image`** (no approved asset) |
| sitemap.xml | generated only when `VITE_SITE_URL` set; indexable public routes only; legal pages and all private prefixes excluded |
| robots.txt | always; disallows `/dashboard`, `/admin` and other private prefixes; references sitemap when origin set |
| Private routes | app shell is `noindex,nofollow` with empty root; unauthenticated deep links redirect to login |
| Structured data | `Organization`/`WebSite` JSON-LD on Home only, only when origin set; legal name/address only when env provided; nothing invented |
| Semantics | exactly one `<h1>` per page, no skipped heading levels, landmarks, skip link, image alt, inert closed mobile menu |
| Internal links | every internal link in dist resolves to a prerendered page |
| 404 | public "Page not found" page |
| Hydration | no console errors/hydration warnings on any public route at 1536 px and mobile |

## Required inputs (not invented)
`VITE_SITE_URL` (production origin), `VITE_COMPANY_LEGAL_NAME`, `VITE_COMPANY_ADDRESS`, `VITE_CONTACT_EMAIL`; an approved `og:image` asset. The static host must serve `dist/<route>/index.html` with `app-shell.html` as the fallback for private/unknown routes, and send correct status codes (not verifiable here).

No ranking or traffic outcome is claimed. Search-console submission and live crawl: NOT VERIFIED.
