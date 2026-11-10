# PHASE 22 — Model-versus-migration gap report (D4)

**Database used:** disposable **MariaDB 10.11.14** (Ubuntu package) started in a scratch directory. **This is MariaDB, not Oracle MySQL** — it is close but is not proof for MySQL 8. No production data was touched. Migration SQL was never generated from model names; no migration was written or changed.

## 1. Fresh-install test (the D4 acceptance test)
| Step | Result |
|---|---|
| Empty database → `sequelize-cli db:migrate` | **FAILED at the first migration** `20250814113459-add-tax-fields-to-products`: `Table 'Products' doesn't exist`. **A fresh database cannot be built from `migrations/`.** |
| Start application / core workflows on a migration-built DB | **NOT RUN** (no schema to run on) |
| Rollback/reapply on a fresh DB | **NOT RUN** (nothing applied) |
Confirmed: not a test artefact — the repository simply has no migration that creates `Products`.

## 2. Model vs migration coverage (static recorder over all 40 migrations; 56 models)
* **29 tables** have a `createTable` migration: admin_users, sap_sync_records, erp_connections, erp_connection_capabilities, erp_entity_mappings, erp_sync_jobs, erp_sync_errors, erp_external_links, erp_sync_schedules, erp_audit_events, erp_outbound_events, SalesCreditNoteLines, SalesReturns, SalesReturnLines, PurchaseReturns, PurchaseReturnLines, PurchaseDebitNotes, PurchaseInvoiceLines, Warehouses, StockTransfers, Schemes, SchemeProducts, SchemeDistributors, SchemeRetailers, Claims, ClaimItems, ClaimStatusHistories, Payments, PaymentAllocations.
* **27 tables have NO create-table migration** (Phase 21 reported 10; the correct number is 27):
  Distributors, Products\*, Customers\*, Addresses, Batches\*, SalesOrderHeaders, SalesOrderLines, SalesDeliveryHeaders, SalesDeliveryLines, SalesInvoiceHeaders\*\*, SalesInvoiceLines\*\*, SalesCreditNotes\*\*, SalesDebitNotes\*\*, Vendors, PurchaseOrderHeaders, PurchaseOrderLines, PurchaseDeliveryHeaders, PurchaseDeliveryLines, PurchaseInvoiceHeaders\*\*, JournalEntries\*\*, glmasters\*\*, StockLedgers\*\*, PricingMasters, CustomerGroups, VendorGroups, ItemGroups, HSNGroups.
  \* extended by `addColumn` migrations only · \*\* extended by migrations that *assume* the table already exists (they throw if it does not) · rest are not touched by any migration.
* The migrations are therefore **upgrade scripts for a legacy schema that was originally built by `sequelize.sync()`**. The baseline schema (as it was before the first migration) is not in the repository, so a correct baseline migration cannot be derived responsibly from the current models (Phase 5–12 changed several of those tables since).
* Column check on the 29 migration-created tables: every model column exists (the one apparent miss, `erp_entity_mappings.source_entity/source_field`, is a rename done in migration `…erp-sync-phase14` — a recorder limitation, verified by reading the migration).
* Indexes: model-declared indexes were not compared one by one (many are added via raw SQL in migrations); **NOT VERIFIED**.

## 3. Migrating over a model-synced MariaDB schema (simulates "dev DB → migrate")
Built a schema with `sequelize.sync()` (56 tables) then ran the migrations one by one, marking a failing one as applied to continue:
* 32 of 40 ran cleanly; **8 failed with duplicate column/index** because `sync()` had already created them: add-tax-fields-to-products (`gst`), add-material-quantity-status-to-batch (`status`), extend-stockledger (`uniq_stockledger_movement`), extend-salesinvoiceheader, extend-purchaseinvoiceheader, extend-salescreditnote, extend-salesdebitnote, harden-glmaster. Meaning: **`DB_SYNC` and migrations are mutually exclusive on the same database** — choose one path per environment.
* This is a simulation, **not** a legacy-data upgrade test; it does not prove a real production database upgrades correctly.

## 4. Rollback (`down`) findings on MariaDB (same simulated DB)
10 of 40 `down()` calls failed when rolled back one at a time (all remaining ran):
| Migration | Error | Risk |
|---|---|---|
| 20250819…add-material-quantity-status-to-batch | `DROP TYPE IF EXISTS "enum_Batches_status"` — **PostgreSQL syntax, invalid on MySQL/MariaDB** | Genuine: `down()` cannot work on MySQL |
| 20261009…erp-phase16 | cannot drop index `uq_sales_order_external_source` (needed by a foreign key) — also reproduced by the existing Phase 16 migration test | Genuine MySQL rollback risk: index is used by an FK; needs the FK handled first |
| 20260904090000 extend-stockledger, 20260904090100 add-indexes-to-batches | cannot drop index needed in a foreign key | Same class |
| 20260908090500 create-purchasedebitnote | FK constraint on delete | Rollback order/FK |
| harden-glmaster, extend-sales/purchase invoice/debit/credit | `DROP INDEX … check that it exists` | Likely artefact of the synced schema (those indexes were skipped on `up`); not conclusive |
Not fixed: editing already-shipped migrations is a release decision. Rolling back is **unsafe to rely on** for these.

## 5. Seed / bootstrap data
By code reading (not executed on a migration-built DB): no mandatory seed rows. GL accounts are created lazily (`accounting.service` `findOrCreate`); the default `MAIN` warehouse is created lazily (`inventory.service.ensureDefaultWarehouse`) and by the Phase 5 migration for existing distributors; the first Admin user is created only by `scripts/create-admin.js` (needs `admin_users`, `ADMIN_JWT_SECRET` ≥ 32 chars, ≠ `JWT_SECRET`). HSN/groups/products are user-entered.

## 6. Other database findings
* **`DB_PORT` is not supported** (`config/db.config.js`, `models/index.js` and `config/config.js` pass no port) — MySQL on a non-default port cannot be used without a code change. Not changed.
* `DB_SYNC` runs only when `NODE_ENV=development` **and** `DB_SYNC=true`; production never creates tables.
* **Demonstrated MySQL defect, fixed (D5):** `createdAt` is `DATETIME` (1-second) on MySQL/MariaDB; code/number generators ordered by `createdAt` alone tied within a second and produced duplicates. See PHASE22_AUDIT.md D5.
* Column `customer_code`/`vendor_code`/`distributor_code` are `STRING(6)` and globally sequenced (`CTR001`…): the 1000th record would need 7 characters. **Open — needs a numbering decision.**

## 7. What would close D4 (needs your approval)
1. Provide a dump of the *legacy baseline schema* (or an existing production schema) and write a single baseline migration from it, **or** declare `sequelize.sync()` + a controlled schema snapshot as the supported fresh-install path and remove the pretence that migrations build a database.
2. Re-run on **MySQL 8** the full sequence: fresh create → migrate → start → workflows → rollback/reapply → index/FK/data integrity checks.
