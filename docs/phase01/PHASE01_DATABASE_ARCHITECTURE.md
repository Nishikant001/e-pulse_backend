# PHASE 01 — DATABASE ARCHITECTURE

Nothing was created, migrated, dropped or re-assigned. Evidence tags: **[CONFIRMED]** read in source, **[REPORTED]** stated in the project's own Phase 24 report but not re-executed here (no database server was available), **[RECOMMENDATION]**, **[ASSUMPTION]**.

---

## 1. Existing database and tenant architecture

### 1.1 Topology — shared database, row-level tenancy [CONFIRMED]
- `models/index.js` builds **one** `Sequelize` instance from `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/DB_DIALECT` (`config/db.config.js`; tests switch to in-memory sqlite when `NODE_ENV=test`). Pool max 10.
- There is no connection registry, no per-request connection selection, no `AsyncLocalStorage` tenant context for data access (the one request context in `utils/requestContext.js` carries a correlation id only).
- **Tenant = Distributor.** Business rows carry `distributor_id` (Products, Batches, Customers, Vendors, SalesOrderHeader, SalesInvoiceHeader, SalesCreditNote, SalesReturn, PurchaseOrderHeader, Warehouses, groups, PricingMaster, Payments …) or `distributor_code` (GLMaster / JournalEntry). Child lines inherit through their header.
- Distributor requests are scoped by `req.user.id` (token) in each controller/service; Admin requests are intentionally cross-distributor.

### 1.2 Admin / company → distributor mapping [CONFIRMED]
| Concept | Where | Notes |
|---|---|---|
| Admin user | `admin_users` (`id, name, email, password_hash, role, is_active, last_login_at`) | no company column |
| Distributor | `Distributors` | login identity **and** tenant; admin-created distributors have `password = NULL` (cannot sign in until a password is set through the OTP reset flow) |
| Ownership | `Distributors.created_by_admin_id INT NULL`, index `distributors_created_by_admin_id`, **no FK** | set only in `services/adminDistributors.service.js` create; never updated; no reassignment route |
| ERP "tenant" | `tenant_key` on 7 `Erp*` tables, from `ERP_TENANT_KEY` env (default `DEFAULT`) | a single global key; not linked to admins or companies |
| Retailers | `Customers.distributor_id` | a retailer is a Customer |
| Scheme/claim/payment authorship | `created_by_admin_id` on Schemes, Payments, ErpConnections, ErpSyncSchedules | authorship only, not ownership |

Consequences:
1. **Company is not modelled.** "Admin account" = a row in `admin_users`. Super Admin's "distributors per Admin" is really "distributors per admin user who created them".
2. Admins are **not isolated from each other** (every admin service reads all distributors). A second company onboarded today would see the first company's distributors, orders, invoices, payments.
3. Distributor self-signup (`POST /api/signup`) creates an active distributor with `created_by_admin_id = NULL`.

### 1.3 Provisioning, credentials, migrations [CONFIRMED / REPORTED]
- No code creates databases, users, grants or per-tenant configuration. No secret store; DB credentials come from one `.env`.
- `sequelize.sync()` runs only when `NODE_ENV=development` and `DB_SYNC=true` (`config/dbSync.js`); `DB_FORCE=true` drops all tables (dev only). Production start-up logs "DB sync disabled".
- **Migrations are not an install path.** [CONFIRMED] The first migration (`20250814113459-add-tax-fields-to-products`) alters `Products`; only 27 `createTable` calls exist: 26 named tables (`PurchaseInvoiceLines, SalesCreditNoteLines, SalesReturns, SalesReturnLines, PurchaseReturns, PurchaseReturnLines, PurchaseDebitNotes, admin_users, sap_sync_records, Warehouses, StockTransfers, Schemes, Claims, ClaimItems, ClaimStatusHistories, Payments, PaymentAllocations, erp_* ×9`). The core tables come from `sync()` (56 tables). [REPORTED] `PHASE24_DATABASE_MIGRATION_REPORT.md`: fresh `db:migrate` fails at migration #1; over a `sync()` schema 8 migrations fail (duplicate column/index); 10 `down()` fail; engines verified: SQLite (tests) and MariaDB 10.11; **Oracle MySQL 8 not verified**.
- `sequelize-cli` does load `config/config.js` (verified: it printed `Loaded configuration file "config/config.js"` and then failed to connect because no DB exists in this environment).
- Failure handling for a partially provisioned tenant: **none exists** (nothing provisions).

### 1.4 Storage measurement [CONFIRMED absence]
No code reads `information_schema`, table sizes, row counts per tenant, or quotas. Uploaded spreadsheets go to local `uploads/` (multer, random names) and are not tracked or cleaned.

### 1.5 Integrity features and weak spots
- Foreign keys exist for most Sequelize associations (`onDelete: CASCADE` on several headers/lines — a distributor delete would cascade widely; the Admin API never deletes).
- `constraints: false` on Vendor→VendorGroup, Product→ItemGroup (by `code`), Warehouse/StockTransfer links. `Distributors.created_by_admin_id` has no FK.
- Business codes are `STRING(6)`: `DTC###`, `CTR###` → hard ceiling of 999 per system (global, not per company).
- Raw SQL in services uses MySQL back-tick quoting and `COALESCE/NULLIF`; test suite runs on SQLite, so MySQL-only behaviour depends on the manual MariaDB verification noted above.
- DATETIME has second precision; one ERP echo-prevention test fails on MariaDB for that reason [REPORTED].

## 2. Ownership attribution — what can and cannot be proven

| Distributor population | `created_by_admin_id` | Attributable? |
|---|---|---|
| Created through Admin portal **after** migration `20261012090000` | set | **Yes** (but the admin row may later be deactivated; a deleted admin leaves a dangling id because there is no FK) |
| Created through Admin portal **before** the migration | NULL | **No** — no field/audit records the creator |
| Self-signup (any time) | NULL | **No** (nobody "owns" them) |
| Seeded/imported rows | NULL | **No** |

Rules to keep: never infer ownership from email domain, city, creation time or ERP key; show these as **Unassigned**; assignment only by an explicit, audited Super Admin action. Missing today: an audit/history table for onboarding and assignment, `created_by` for self-signup source, a `source` column (ADMIN/SELF_SIGNUP/IMPORT). **[RECOMMENDATION]** add `onboarding_source` and an append-only `distributor_ownership_events` table before any migration to per-company databases.

## 3. Recommended design — one database per Admin/company

### 3.1 Principle
Introduce an explicit **Company** (tenant) in a new **control-plane database**; each company gets one **tenant database** containing that company's distributors, and everything beneath them. The existing schema is reused unchanged inside each tenant database.

### 3.2 Control plane (new, small, shared)
Tables **[RECOMMENDATION]**:
- `companies` (id, code, name, status `provisioning|active|suspended|failed|archived`, db_name, db_host_ref, db_schema_version, created_at, …)
- `company_admins` (company_id, admin_user_id, role) and move `admin_users` here (identity stays global so login can find the company first), with `company_id` NOT NULL for company admins and NULL only for `SUPER_ADMIN`.
- `distributor_directory` (distributor_email/id → company_id) so the Distributor login endpoint can route to the correct tenant database (Distributor login currently looks up email in the one DB; with many DBs it needs this global directory, with a globally-unique email constraint).
- `company_usage` (company_id, measured_at, data_bytes, index_bytes, row_estimate, file_bytes) for storage monitoring.
- `provisioning_jobs` (id, company_id, step, status, error, started_at, finished_at, attempts) and `ownership_events`.
- Credentials are **not** stored in plain columns: store a secret reference (`db_secret_ref`) resolved from a vault/KMS or an encrypted column; app connects with a per-tenant MySQL user limited to its own schema (`GRANT … ON company_x.*`).

### 3.3 Tenant resolution
1. Admin: session → `admin_users.company_id` (server-derived; never from body/query/header — the same rule `services/erp/tenantScope.js` already states). `SUPER_ADMIN` resolves to the control plane.
2. Distributor: JWT carries `company_id` + `distributor_id`; the middleware loads the tenant connection from a bounded LRU pool keyed by company_id; re-read distributor status each request (also fixes finding S3).
3. Models are bound per connection (factory `initModels(sequelize)` instead of the module-level singleton in `models/index.js`); services receive `db` already today (`getOverview(db)` style), which makes the change mostly mechanical for services but **not** for `require("../models")` call sites in controllers/middleware (to be inventoried in Phase 5 — roughly every controller imports `../models` directly).
4. Background jobs (ERP scheduler, `batchExpiryJob`) must iterate companies explicitly.

### 3.4 Provisioning workflow **[RECOMMENDATION]**
State machine with idempotent steps and a recorded status: `PENDING → CREATING_DB → CREATING_USER → APPLYING_SCHEMA → SEEDING → VERIFYING → ACTIVE`; on any failure → `FAILED` with the step and error, **no automatic drop**; a separate, explicitly-approved cleanup job handles partial resources. Re-running a failed job resumes from the failed step. Guard: unique `db_name` from the company id (not user input), whitelist characters, one provisioning job per company.
Prerequisite: **a reproducible schema installer**. Because migrations cannot build a database (§1.3), Phase 5 must first deliver either (a) a baseline migration generated from the verified production schema plus a versioned schema snapshot, then mark existing migrations as applied, or (b) controlled `sync()` + snapshot. This is the open decision recorded by the project's Phase 24 report.
Seeding: GL master defaults, tax groups, any required lookups — from the existing seed paths (to be inventoried).

### 3.5 Migration of existing data **[RECOMMENDATION — do not execute in Phase 1]**
1. Decide company boundaries (Decision 5/6 in the audit report) and produce a **mapping file**: distributor_id → company, signed off by the business. Unassigned distributors stay in a clearly named holding company/legacy DB or stay in the shared DB until assigned.
2. Take a verified backup; dry-run the copy into a scratch tenant DB; copy per distributor in dependency order inside one transaction per distributor; preserve primary keys **or** keep an explicit id-map for every table (documents reference ids; Payments/Journal reference customer/invoice ids).
3. Reconcile: row counts per table, sums (invoice totals, AR balance, stock by batch), referential checks, Σ outstanding − advance = AR ledger (an invariant the existing tests already assert), and a sample hash.
4. Cut over per company with the old data kept read-only until sign-off. No destructive step before reconciliation passes.
Cross-tenant risk to design out: shared global tables today — `Distributors`, `admin_users`, `Erp*`, codes (`DTC###`, `CTR###`) are **global sequences** and distributor/customer codes will collide across tenant DBs unless made per-company or prefixed.

### 3.6 Storage metering **[RECOMMENDATION]**
Sample on a schedule (not per request): `SELECT table_schema, SUM(data_length), SUM(index_length), SUM(table_rows) FROM information_schema.tables GROUP BY table_schema` (rows are estimates for InnoDB — label as such), plus file storage per company directory/bucket. Store in `company_usage`; Super Admin dashboard shows the latest sample with `measured_at` and an "estimate" label; alerts at configurable thresholds; never block writes on a stale sample.

### 3.7 Isolation and recovery requirements
- Per-tenant DB user with schema-level grants only; the control-plane user cannot read tenant business tables.
- Tests: automatic cross-tenant tests (company A token must get 403/404 on company B ids at every route; connection-pool tests that prove a request cannot reuse another tenant's connection).
- Backups per tenant database (point-in-time recovery where the provider supports it); restore drill documented; `schema_version` per company with a controlled rolling migration runner (apply to one canary company first, record result per company, never "all or nothing" silently).
- Connection limits: N databases × pool (currently 10) can exhaust MySQL `max_connections`; use a bounded LRU of pools with small per-tenant max.
- Observability: every log line carries `company_id` + correlation id.
- Feasibility: incremental delivery is possible **if** Phase 5 starts with the control plane + tenant resolver behind a feature flag while the shared DB remains the default for un-migrated companies. It cannot be done without touching authentication (login routing), the model layer and the ERP scheduler.

## 4. Export and migration to another database

Neither export, import scripts, manifests nor job tracking exist [CONFIRMED absence]. The only file-producing code is a front-end CSV download for invoices (`features/adminSales/invoices/invoiceCsv.js`).

### 4.1 What is exportable (inventory of the data model)
52 Sequelize models / 56 tables: masters (Distributor, Product, Batch, Customer, Address, Vendor, groups, HSN, Pricing, Warehouse, GL), transactions (orders, deliveries, invoices, credit/debit notes, returns, payments + allocations, journal, stock ledger/transfers), engines (Scheme*, Claim*), integration (Erp*, SapSyncRecord), identity (admin_users, Distributor passwords/OTP columns). **Files:** only transient upload spreadsheets; no document attachments are stored → "associated documents" scope is effectively empty today.

### 4.2 Export package design **[RECOMMENDATION]**
- Job table `export_jobs` (id, company_id, requested_by, format, status `QUEUED|RUNNING|VALIDATING|READY|FAILED|EXPIRED`, progress, error_code, created_at, expires_at, size, sha256).
- Authorization: only a `COMPANY_ADMIN`/`SUPER_ADMIN` of that company; the company id comes from the session, never from the request; export runs against that tenant connection only (physical isolation in the target design makes cross-tenant export structurally impossible; in the shared DB it would require a mandatory `distributor_id IN (company set)` filter on every table — error-prone).
- Output: a ZIP per job: `manifest.json` (format, schema version, table list, row counts, per-file SHA-256, export time, source app version, redaction notes), data files, schema/DDL or collection definitions, import scripts + `README`, `validation_summary.json` (counts re-read from the produced files vs the source, FK check results).
- Secure download: one-time signed URL or authenticated streaming endpoint, short expiry, `Cache-Control: no-store`, audit log entry, files stored encrypted at rest and deleted on expiry. Rate-limit job creation (one running job per company).
- **Exclude by default:** `password`, `reset_otp*`, `password_hash`, ERP connection `config`/credential references, audit tables unless requested.

### 4.3 Format feasibility
| Target | Feasible? | What the conversion needs |
|---|---|---|
| **MySQL / SQL** | Highest (same dialect) | `CREATE TABLE` DDL from the installer/snapshot; data as `INSERT` batches or CSV + `LOAD DATA`; keep FKs/indexes; disable FK checks during load; DECIMAL(…) preserved. Verified-engine caveat: MySQL 8 not yet verified for the app. |
| **PostgreSQL** | Feasible with transformations | Types: `TINYINT(1)`→`boolean`, `DATETIME`→`timestamptz` (timezone decision), `ENUM`→native enum or `CHECK`, `DECIMAL` same, `AUTO_INCREMENT`→`GENERATED … IDENTITY` and **reset sequences** after load, back-ticks→double quotes, case-sensitive identifiers (tables are PascalCase like `SalesInvoiceHeaders` — quote or normalise), `TEXT`/`JSON` mapping, index/FK DDL re-generated; use `COPY`. Need a loader that orders tables by FK dependency (circular/loose links exist: item_group/vendor_group by `code` without FK). |
| **MongoDB** | Feasible, but a *redesign*, not a conversion | Decide embed vs reference: documents with lines (order+lines, invoice+lines, credit note+lines, return+lines, payment+allocations, claim+items+history) embed naturally; masters stay referenced. FKs/constraints/unique indexes must be re-declared as indexes + application validation (JSON Schema validators); no multi-table transactions semantic equivalent for accounting invariants (Dr/Cr balance) — export is a snapshot, not a runnable DMS; ids → keep numeric `legacy_id` and add `_id`; decimals → `Decimal128` (not float); dates → ISO dates; the app **cannot** run on the exported Mongo data without a new data layer. Be explicit in the UI that Mongo export is for data portability/analytics. |
Common: relationships are expressed in `manifest.json` (parent/child, key columns); validation = row-count parity, sum checks (invoice totals, AR), FK parity, checksum.

### 4.4 Risks
Large exports → streaming/chunking + background job; memory; consistent snapshot (`REPEATABLE READ` or read replica); sensitive columns; time zones; collation; identifier case on Linux MySQL; Super Admin vs company-admin permission model (needs RBAC from Phase 3/4 first).

## 5. What must exist before Phase 5 (database) can start
1. RBAC and company model decisions (audit §8.1, 8.5, 8.6, 8.7).
2. Reproducible schema installer (baseline migration or approved snapshot approach) verified on the production engine (MySQL 8 and/or MariaDB — to be fixed by decision).
3. Inventory of `require("../models")` usages and background jobs that need tenant context.
4. A staging database server where databases can be created (this audit environment had no DB server).
