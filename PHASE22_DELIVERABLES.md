# PHASE 22 — Deliverables

**Outcome:** two demonstrated defects fixed (D5 MySQL duplicate codes/numbers, D3 vendor-by-code), and the MariaDB check that Phase 21 could not run was run. Production-readiness is **not** claimed: the fresh-install path (D4), Admin RBAC (D6) and Batch Master (D2) remain open and need your decisions. All DB evidence is **MariaDB 10.11, not Oracle MySQL 8**.

Documents: `PHASE22_AUDIT.md` (register, evidence, decisions not taken) · `PHASE22_PERMISSION_MATRIX.md` (proposal + 128-route mapping) · `PHASE22_MIGRATION_GAP_REPORT.md`.

## 1. Code changes (nothing else touched; no migration, no route, no accounting/inventory calculation)
**D5 — `["id","DESC"]` tie-breaker added to "last record" lookups used to generate codes/numbers**
`models/customer.model.js`, `models/vendor.model.js`, `models/distributor.model.js`, `controllers/salesinvoice.controller.js`, `salescreditnote.controller.js`, `salesdebitnote.controller.js`, `salesreturn.controller.js`, `purchaseorder.controller.js`, `purchaseinvoice.controller.js`, `purchasedebitnote.controller.js`, `purchasereturn.controller.js`.
**D3 — frontend only:** `Po.jsx` (dead `/vendor/by-code` call removed; refresh-from-`/vendor` fallback), new `vendorLookup.js`.
**Created:** `tests/code-generation-phase22.test.js` (3), `tests/vendor-lookup-phase22.test.js` (6), `vendorLookup.test.mjs` (5), the four PHASE22 docs.
No existing test file modified or weakened; no assertion removed.

## 2. Results (exact)
| Check | Before | After |
|---|---|---|
| Backend `npx jest --runInBand`, clean single process, SQLite | 24 suites, 778 / 778 | **26 suites, 787 / 787 passed, 0 failed** (778 + 9 new) |
| Same suite on **MariaDB 10.11** (scratch copy; schema from `sync()`) | **37 failed / 747 passed** of 784 (earlier run, before D5 fix) | **5 failed / 782 passed** of 787. The 5 are SQLite-specific tests: 4 migration tests (`PRAGMA foreign_keys`, out-of-order `down()` / FK drop) + 1 timing-sensitive ERP outbound test (not diagnosed further) |
| Mutation check | — | with the old `customer.model.js` the new tie test fails; with the fix it passes |
| Frontend `npm run build` | ok | ok |
| Frontend `npm run lint` | 33 errors / 10 warnings | **identical 33 / 10** (Po.jsx's only warning is the pre-existing `useEffect` dependency one; new file clean) |
| Frontend `node --test` | 16 | **21 / 21** (16 + 5) |
| Backend lint | none configured | NOT RUN |
| Fresh DB: apply all migrations | NOT RUN | **FAILED at migration #1** (MariaDB) |
| Migrate over `sync()`-built DB / rollback | NOT RUN | 32/40 up clean, 8 duplicate-object; 10/40 `down()` failed — see gap report |
| App start + workflows on a migration-built DB | NOT RUN | NOT RUN (no migration-built DB possible) |
| Workflows on a `sync()`-built MariaDB | — | standalone-phase21, sales/purchase/returns lifecycle, accounts, claims etc. pass (782/787 above) |
| Browser / manual UI | NOT RUN | NOT RUN |
| Real ERP | none | none |
Distributor isolation: new vendor tests (own list, cross-distributor list and id → 404) pass; existing cross-tenant suites pass on SQLite and MariaDB. No endpoint was added or its permissions changed, so no new permission tests apply.

## 3. Status table
| Item | Status |
|---|---|
| D5 duplicate codes/numbers on MySQL-family DBs | **Complete** (SQLite + MariaDB evidence); width/global-sequence limit **Open** |
| D3 vendor by code | **Complete** (frontend, unit + contract tests; no browser check) |
| D2 Batch Master | **Blocked** — awaiting option A/B/C approval |
| D4 fresh-install DB | **Blocked / Not verified** — fresh migrate fails; needs baseline schema decision + MySQL 8 run |
| Migration rollback safety | **Partial / defects found** (not fixed) |
| Admin RBAC | **Partial** — design + route mapping delivered; **not implemented** (needs business matrix) |
| Admin UI decisions (sample tab, SAP column, KPIs, placeholders) | **Not changed** (business decisions) |
| ERP Invoice/Return/Document sync | **Blocked** (unchanged) |
| Oracle/Dynamics/SOAP | **Unsupported** (unchanged) |
| Real SAP/REST ERP | **Not verified** |
| MySQL 8 | **Not verified** (MariaDB only) |
| Production readiness | **Not claimed** |

## 4. Remaining business/technical decisions
1. Batch Master: option A, B or C (audit §2).
2. Baseline schema for a fresh install (provide legacy schema/dump, or declare `sync()`+snapshot the supported path); then a MySQL 8 run.
3. Admin role matrix (matrix §4) and rollout mode (`off/audit/enforce`).
4. Code numbering: width beyond 6 chars, per-distributor vs global, concurrency-safe allocation.
5. Fix or leave: PostgreSQL syntax in an old `down()`, erp-phase16 `down()` FK index, `DB_PORT` support, `GET /stock/bulk-upload` shadowing.
6. Sample-data tab, SAP-status column, payables / pending-claims / pending-returns KPIs, placeholder cleanup.
7. Real-ERP verification, Invoice/Return/Document sync policy (unchanged from Phase 19).

## 5. Package
`phase22_changed_files.zip` — only created/modified files, under `backend/` and `frontend/` with their project-relative paths.
