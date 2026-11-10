# PHASE 01 — HANDOVER

## 1. State of the deliverables
- Phase 1 was an **audit only**. Both delivery ZIPs are unchanged copies of the supplied source with the six audit documents added under `docs/phase01/`. No behaviour, schema, permission or data was changed. Excluded from the ZIPs: `.env` (secrets), `node_modules`, build output.
- Note on the input: the two uploaded ZIPs were byte-different but had identical contents (each contained both projects). The delivery frontend ZIP contains only the frontend project and the backend ZIP only the backend project.

## 2. What is ready for Phase 2 (Admin/Distributor navigation cleanup)
- Exact current menu state for both portals (`PHASE01_MODULE_INVENTORY.md`), generated from the real config files.
- The files to change are known: `src/config/adminNavigation.js`, `src/config/navigation.js`, `src/config/portals.js`, `src/PrivateApp.jsx`, `components/Distributers/dashboard/accounts/Payments.jsx` (vendor section), `features/adminDashboard/AdminDashboardPage.jsx` + `components/SapStatusCard.jsx`, `components/layout/Header.jsx` / `SapStatusIndicator.jsx`.
- Verified baseline: backend 846/846 tests pass; frontend 48/48 unit tests pass; production build passes with `VITE_API_BASE_URL=/api`.

## 3. Known limitations of this audit
- No database was available: migrations, MySQL 8 behaviour, live API behaviour, cookies and browser flows were **not** executed. Items from `PHASE24_DATABASE_MIGRATION_REPORT.md` are cited as *reported*.
- Frontend lint is red (33 errors) and was not touched.
- The audit read the code paths for each requirement; where a feature exists only as a sidebar placeholder it is recorded as Planned/Missing, never as implemented.
- Counts (routes, files) come from executed scripts or `ls`/`grep`; the Super Admin "admins" metric counts every `admin_users` row.

## 4. Decisions only you can make (blockers for specific phases)
| # | Decision | Blocks |
|---|---|---|
| 1 | Retailer = Customer row. Keep Customer Master but remove retailer options from Admin Accounts — what replaces retailer-keyed Outstanding/Ledger/Payments/Credit, and does "Customer Master" simply re-label the existing Retailer List? | Phase 2 (partly), Phase 4 |
| 2 | Admin Sales Returns / Credit Notes have no screens or APIs today. Build read-only views, or just keep them hidden? | Phase 3 |
| 3 | ERP: hide UI only, or also disable `/api/admin/erp-*` and the in-process scheduler? (A.9 also asks for a "SAP Sync" item in Distributor Management — conflicts with A.7.) | Phase 2/3 |
| 4 | "My Ledger": which distributor↔admin transactions exist (primary sales/purchases, payments to the company, claim settlements)? Only scheme-claim settlement exists today. | Phase 4 |
| 5 | Is a company = one Admin user, or a company with several admin users? Where do Super Admin and company admins live? | Phase 5/6 |
| 6 | How are existing distributors assigned to companies (explicit Super Admin action with audit trail; never guessed)? | Phase 6 |
| 7 | Target DB engine/version and database-count limits of the hosting; staging DB availability. | Phase 5 |
| 8 | Export scope (documents? audit tables? mandatory formats in first release). | Phase 7 |
| 9 | Hiding Distributor "Masters" removes the only screens to create products/customers/vendors/batches/pricing/HSN/groups — confirm that is intended, or where those screens move. | Phase 2 |
| 10 | Does "Sales Creation" (A.1) include invoice post/cancel and order confirm/cancel? | Phase 3 |

## 5. Exact next steps
1. **Rotate the secrets that were inside the ZIPs** (DB password, `JWT_SECRET`, `ADMIN_JWT_SECRET`, SMTP password) and keep `.env` out of archives from now on.
2. Answer decisions 1, 3, 9 (needed for Phase 2) — the rest can wait for their phase.
3. Start Phase 2 on a branch: edit the three config files, remove/guard routes in `PrivateApp.jsx`, add navigation unit tests, fix the ESLint errors in touched files, keep `npm test` + build green.
4. In parallel plan Phase 3: role/permission design for the 39 unguarded Admin writes (`scripts/route-inventory.js` lists them) before any "view-only" claim is made.

## 6. Phase 2 entry criteria
- [ ] Secrets rotated; `.env` not in the repo/ZIP.
- [ ] Decisions 1, 3, 9 answered in writing.
- [ ] Agreed meaning of "hide": remove from config (recommended) vs. toggle.
- [ ] Baseline recorded: backend 846 pass, frontend 48 pass, build green with `VITE_API_BASE_URL=/api`.
- [ ] Source control with a clean baseline commit of the Phase 1 ZIPs.
- [ ] Acceptance list per portal (the A.* and B.* items) turned into checks.
