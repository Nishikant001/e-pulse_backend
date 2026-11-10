# PHASE 22 — Audit: defect closure, Admin security design, production readiness

Date: 2026-10-11 (IST). Source of truth: Phase 21 backend + frontend ZIPs. Evidence tags: **[CODE]** read in code · **[TEST]** automated test, in-memory SQLite · **[MARIADB]** executed on a disposable **MariaDB 10.11** (not Oracle MySQL) · **[UI]** browser (none this phase) · **[ERP-REAL]** real ERP (none).

## 0. Baseline (before any change) — pre-existing, kept separate from new results
| Check | Result |
|---|---|
| Backend `npx jest --runInBand` | 24 suites, **778 / 778 passed** (≈248 s) — identical to Phase 21 |
| Frontend `npm run build` | succeeded (pre-existing >500 kB chunk warning) |
| Frontend `npm run lint` | **33 errors / 10 warnings — pre-existing**, unchanged by this phase |
| Backend lint | none configured (no ESLint config in backend) → NOT RUN |
| Sidebar/route check [CODE, script over the real nav modules] | Admin 29 live / 37 planned; Distributor 41 live / 39 planned; **0 live links without a route** — reproduces Phase 21 |
| Admin routes [CODE, live router] | 128 routes; 39 non-ERP writes with no role check |
| MySQL | MariaDB 10.11 installed locally this phase → DB checks now possible (labelled MariaDB) |

## 1. Confirmed issue register
| ID | Sev | Issue | Evidence | Status / action |
|---|---|---|---|---|
| **D5** (new) | **High** | `customer_code`, `vendor_code`, `distributor_code` and document numbers (sales/purchase invoice, credit/debit note, return, purchase order) pick "last row ordered by createdAt". MySQL/MariaDB `DATETIME` is 1-second precision, so records created in the same second tie → **duplicate code → unique-constraint failure**. Not visible on SQLite (milliseconds). | [MARIADB] full suite: **37 failures** before, **6** after; direct repro: 2nd customer created in the same second → `customer_code must be unique`. [TEST] tie simulated deterministically; test fails on old model, passes on new. | **FIXED**: added `["id","DESC"]` tie-breaker (pattern already used by `salesOrder.controller`) in 11 files. Formats and sequences unchanged. Remaining limits below. |
| D5b | Med | Codes are `STRING(6)` and one **global** sequence across all distributors: `CTR999`→`CTR1000` (7 chars) overflows; read-then-write is not concurrency safe (a race now fails on the unique index instead of silently duplicating). | [CODE] + [MARIADB] column `varchar(6)` | **OPEN — needs numbering decision** (width, per-distributor?, DB sequence). Not guessed. |
| **D2** | Med | Distributor "Batch Master" `/dashboard/stock-master` calls non-existent `/batch`, reads `batch.quantity` | [CODE] | **OPEN — approval needed** (see §2) |
| **D3** | Low | `Po.jsx` fallback `GET /vendor/by-code/:code` → 404 | [CODE] | **FIXED, frontend only** (§3). No new endpoint. |
| **D4** | **High** | A fresh DB cannot be built from `migrations/` (first migration fails: no `Products` table); 27 model tables have no create migration (Phase 21 said 10) | [MARIADB] | **OPEN — needs baseline schema/decision** (PHASE22_MIGRATION_GAP_REPORT.md) |
| D4b | Med | `down()` of `add-material-quantity-status-to-batch` uses PostgreSQL syntax; erp-phase16 `down()` cannot drop an FK-backing index on MySQL | [MARIADB]; same failure in the existing Phase 16 migration test | OPEN — editing shipped migrations is a release decision |
| D4c | Low | `DB_PORT` unsupported by config/model init | [CODE] | OPEN (small change, not requested) |
| D6 | **High** | Non-ERP Admin RBAC missing: 39 write routes (post invoices, settle claims, record payments, change credit limits, edit pricing/tax) accept any active admin | [CODE] live router | **OPEN — design delivered** (PHASE22_PERMISSION_MATRIX.md); implementation blocked on business role matrix |
| D7 | Low | `GET /stock/bulk-upload` is declared after `GET /stock/:id`, so it is unreachable (matches `:id="bulk-upload"`); a GET bulk-upload makes no sense anyway | [CODE] `routes/allRoutes.js:112,116` | OPEN, not changed (probably meant POST; needs confirmation) |
| D8 | Info | Existing suite is SQLite-oriented: 5 tests use `PRAGMA foreign_keys` / out-of-order migration `down()` and cannot pass on MySQL (4 migration tests, 1 timing test) | [MARIADB] | Not weakened; documented. They are harness limits, not product defects. |

## 2. D2 — Distributor Batch Master (left OPEN deliberately)
Findings [CODE]:
* Phase 5 **Batch Stock** page (`features/inventory/pages/BatchStockPage`, route `/dashboard/inventory/batch`) is **read-only** (ledger-derived balance, drill-down); it has no create/edit/delete.
* The backend **does** still provide batch-identity CRUD: `POST/PUT/DELETE /stock` (`stock.controller`, validated by `batchValidation.service`: batch_no, mfg/exp dates, purchase price, MRP, status; delete refused when ledger rows exist; **no quantity** — stock is ledger-only).
* Other screens create batches only inline (`Podel.jsx` from a PO delivery).
So the Batch Master is a **different function** from Batch Stock (master data vs balances) and the only dedicated UI for batch master data.
Options (need approval):
| Option | Effect | Cost / risk |
|---|---|---|
| A. Redirect the menu entry to Batch Stock | Removes a broken page | Distributors lose any screen to create/edit/deactivate a batch (only inline PO-delivery creation remains); loses the "Manage Stock" dashboard shortcut meaning |
| B. Rebuild `StockMaster.jsx` against `/stock` (identity only: product, batch no, mfg, exp, purchase price, MRP, status; no quantity; show balance from the ledger/Batch Stock read-only) | Restores the master function with correct semantics | Needs decisions: editable fields, whether product can change (backend forbids), opening-stock entry path, delete rules (backend refuses with history), role access |
| C. B + link each row to Batch Stock detail | Best UX | Same decisions as B |
Not done: replacing the path or computing a quantity would show wrong/NaN totals (Phase 21 finding confirmed).

## 3. D3 — vendor by code (fixed, no new endpoint)
* `GET /vendor` exists, is authenticated and returns only the caller's vendors with `vendor_code`. The list is complete (no pagination), so the fallback endpoint could never return anything the list lacks except a vendor created after the page loaded.
* Fix: `Po.jsx` looks in the loaded list, then **refreshes it once from `/vendor`** and looks again (`vendorLookup.js`: trim, case-insensitive, exact match, never throws). The non-existent call was removed.
* Because no endpoint was added, "new endpoint" tests do not apply; instead the contract the screen relies on is pinned: own vendor present with `vendor_code`; vendor created later appears; **another distributor's vendor/code never appears; reading it by id → 404**; unknown/invalid codes (`VDR999`, empty, SQL-ish, path-ish) are simply absent; `/vendor/by-code/:code` stays unregistered. [TEST] 6 backend + 5 frontend unit tests.

## 4. Review notes (auth, permissions, financial, inventory, ERP)
* Authentication: Admin uses its own secret (fails closed if missing/short/equal to JWT_SECRET) [CODE]; Distributor routes scope by `req.user.id` [CODE+TEST]. Not changed.
* Permissions: see D6. ERP RBAC unchanged and its suites pass.
* Financial/inventory calculations: **not modified**. The only code touched in those areas is the *number/code tie-breaker* (ordering of a lookup, not an amount, tax, stock or journal calculation).
* ERP: nothing changed. Invoice/Return/Document sync remain blocked; no real SAP/REST verification is claimed; SSRF, redaction, rate limits and audit immutability untouched (their suites pass).
* Standalone: no core flow gained an ERP dependency.

## 5. Decisions NOT taken (per brief) and consequences
| Item | Left as is | Consequence |
|---|---|---|
| Sample Data tab in production | visible to every admin, choice kept in localStorage | A viewer could mistake illustrative figures for live; it is labelled "Sample data" |
| "SAP status" column on Admin Sales | shown, `PENDING` for every posted document in a standalone install | Can mislead; display-only, never gates an action |
| Payables / pending-claims / pending-returns KPIs | absent | Dashboard under-reports those areas; needs business definitions |
| Duplicate-looking sidebar placeholders | kept (non-clickable) | Cosmetic only |
| Batch Master | see D2 | Page remains broken |

## 6. Production-readiness verdict
**NOT production-ready.** Blockers with evidence: D4 (no way to build a production schema from migrations; MySQL 8 not tested), D6 (any admin can post/settle/pay), D2 (broken master page), D5b (code width/sequence), rollback defects (D4b), no real-ERP verification, no browser pass.
