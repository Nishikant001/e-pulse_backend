# PHASE 23 — SEO report
## Status: **COMPLETE** (implementation) · rankings **not claimed** · Search Console / live crawl **NOT VERIFIED**

## 1. Rendering strategy [CODE][BUILD][BROWSER]
Finding: the original SPA served an empty `<div id="root">` → client-rendered metadata alone gives crawlers nothing dependable. Smallest compatible fix (no server, no new runtime dependency): **build-time prerender**.
`npm run build` = `vite build` → `vite build --ssr src/entry-server.jsx` → `scripts/prerender.mjs`, which renders each public route with `react-dom/server` + `StaticRouter` and writes `dist/<route>/index.html` (full HTML body, unique head). The browser then **hydrates** (`hydrateRoot`) these pages; private routes and unknown URLs get the empty, `noindex` shell. Verified with JavaScript **disabled**: `/modules` returns its full content and one `<h1>`.
**Deployment impact:** static hosting must serve `dist/<route>/index.html` for directory URLs and fall back to `index.html` (or `app-shell.html`) for private routes — standard `try_files $uri $uri/ /index.html;`. No Node server needed. The build needs the env vars below. A browser-only `Seo` component keeps `<title>/<meta>/canonical/JSON-LD` correct on client-side navigation.

## 2. Implemented [TEST: 13 unit tests][BROWSER]
| Item | Result |
|---|---|
| Unique `<title>` + description per page | 9/9 unique (test + browser) |
| Canonical | only when `VITE_SITE_URL` is set; absent for noindex pages |
| Open Graph / Twitter (`summary`) | title, description, type, site_name, url (when origin known). **No `og:image`** — no verified brand image exists |
| Semantic landmarks / headings | header, nav (labelled), main, footer; exactly one `<h1>` per page (browser, 9 routes × 4 widths); skip link |
| `robots.txt` | generated at build: Disallow `/dashboard /admin /login /signup /forgot-password /reset-password /api/`; `Sitemap:` line only with origin |
| `sitemap.xml` | only the 7 indexable public routes; never private paths (test + browser). **Not generated without `VITE_SITE_URL`** (build prints a warning) |
| Indexing directives | public pages `index,follow`; Privacy/Terms `noindex,follow` (unreviewed drafts); app shell `noindex,nofollow` |
| Structured data | Home only, only with an origin: `Organization`, `WebSite`, `SoftwareApplication`. No ratings/offers/address/sameAs (test asserts) |
| Favicon | new `favicon.svg` matching the brand mark (replaces Vite default) |
| Alt text | no content images used; icons are `aria-hidden`; preview is a labelled `figure` |

## 3. Required inputs / not done
* **Production domain** (`VITE_SITE_URL`) — not invented; without it canonical/sitemap/JSON-LD are off. Build with it before launch and submit the sitemap.
* Social profiles, address, legal name — not in project; not added to structured data.
* `og:image` — needs an approved brand asset.
* Reverse proxy must return **404 status** for unknown URLs if desired; today's SPA fallback returns the shell with HTTP 200 for them (soft-404 risk; the shell carries `noindex,nofollow` statically and the client then renders "Page not found").
* Google rendering, Lighthouse SEO, Search Console: **NOT VERIFIED**. No ranking is promised.
