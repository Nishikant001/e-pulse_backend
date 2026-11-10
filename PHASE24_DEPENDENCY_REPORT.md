# PHASE 24 — Dependency Report

## Frontend (`npm audit`)
Before: 24 advisories (2 critical, 16 high). After `npm audit fix` (non-force) in controlled groups: **0**. Build, unit tests (48/48) and browser E2E re-run after the change.
Removed unused: html2pdf.js, jspdf, pdfmake, qrcode.react, react-qr-code, framer-motion (0 imports). Build still passes.
Not upgraded (majors / out of scope, no advisory): eslint 10, @vitejs/plugin-react 6, lucide-react 1.x, eslint-plugin-react-hooks 7. Minor/patch available (react 19.3, tailwind 4.3) deliberately not bumped to avoid visual regression without a design review.

## Backend (`npm audit --omit=dev`)
Before: 8. After: **3 remain**.
Applied: brace-expansion, moment, multer 2.4.0, proxy-addr 2.0.8, nodemailer ^10.1.0 (changelog read: Node ≥ 20; error code `NoAuth`→`ENOAUTH`; TLS validation for remote fetch — none affect this app's use).
Remaining:
| Package | Advisory | Status |
|---|---|---|
| xlsx | Prototype pollution (GHSA-4r6h-8v6p-xvw6), ReDoS (GHSA-5pgg-2g8v-p4x9) | **UNRESOLVED.** No fixed version on npm; the SheetJS CDN tarball is unreachable from this environment. Used only for bulk-upload parsing behind auth, extension filter, 10 MB / 1 file limit. Next action: replace the library or vendor SheetJS ≥0.20.2 from the official source. |
| uuid <11.1.1 (via sequelize) | Missing bounds check in v3/v5/v6 when `buf` is supplied | ACCEPTED, documented: Sequelize does not call those with a buffer. `npm audit fix --force` proposes Sequelize 3.30 (a downgrade) — rejected. |
| sequelize (transitive of uuid) | same | same |

A clean audit is not claimed. Dev-only dependency audit for the backend was not separately triaged.
