# PHASE 24 — Database & Migration Reliability Report

Engines: **SQLite** (tests only) — verified. **MariaDB 10.11.14** — verified (local, port 3307). **Oracle MySQL 8** — **NOT VERIFIED** (not installable here: no Docker daemon, package CDNs blocked). Only disposable local databases were used; nothing touched a production database.

## Reproduced Phase 22 findings (MariaDB 10.11, `scripts/migration-audit.py`)
1. **Fresh `db:migrate` fails** at migration #1 `20250814113459-add-tax-fields-to-products`: `Table 'Products' doesn't exist`. The migration set only *alters* tables; the base tables come from `sequelize.sync()`.
2. **Over a sync-built schema:** 32/40 migrations apply; 8 fail with duplicate column/index (add-tax-fields-to-products, add-material-quantity-status-to-batch, extend-stockledger, extend-salesinvoiceheader, extend-purchaseinvoiceheader, extend-salescreditnote, extend-salesdebitnote, harden-glmaster) because `sync()` already created the columns.
3. **Rollback:** 30 `down()` succeed, 10 fail: erp-phase16 (index needed by an FK), harden-glmaster / extend-salesdebitnote / extend-salescreditnote / extend-purchaseinvoiceheader / extend-salesinvoiceheader (drop a missing index), create-purchasedebitnote (FK), add-indexes-to-batches and extend-stockledger (index in an FK), add-material-quantity-status-to-batch (PostgreSQL `DROP TYPE` syntax, invalid on MySQL/MariaDB).
4. `sequelize.sync()` creates 56 tables.

## Which tables come from where
- Creatable from migrations alone: only the later ERP/Phase-13+ tables that have `createTable` migrations.
- Depend on legacy schema / `sync()`: the original core tables (Products, Batches, StockLedger, sales/purchase headers, GL master, …) — migrations only alter them.
So the migration folder is an *upgrade* path for databases already created by `sync()`, not an install path.

## Changes in Phase 24
- Optional `DB_PORT` in `config/db.config.js`, `models/index.js`, `config/config.js` (default driver port when unset). Verified: server and sequelize-cli against port 3307.
- Shipped migrations were **not edited** (editing changes checksums/behaviour for databases that already ran them — a release decision).
- `sequelize.sync()` + schema snapshot was **not** adopted as the install path.

## BLOCKED — needs explicit approval
- **Fresh-install strategy.** Decision required: (a) approve "controlled `sync()` + versioned schema snapshot, then mark all existing migrations as applied (`SequelizeMeta`)", or (b) author a baseline migration generated from the production schema. Until then, a new environment must be built by `sync()` (`DB_SYNC=true`, non-production) and treated as unsupported for production.
- **Down-migration defects (10).** Fix = new guarded `down()` logic (check index/FK existence, remove `DROP TYPE`). Needs approval because it edits shipped files; recommended with a compatibility note: forward behaviour unchanged.
- Oracle MySQL 8 behaviour of all of the above: NOT VERIFIED.

## Other MariaDB finding
`erp-business-phase18` › "ERP-created customer is not pushed back…" fails every time on MariaDB: the echo-prevention check compares `row.updatedAt` with `link.last_synced_at + 1000 ms`, and DATETIME second precision (no fractional seconds) pushes the update inside that window. Not changed (business logic); needs a decision on DATETIME(3) or a different guard.
