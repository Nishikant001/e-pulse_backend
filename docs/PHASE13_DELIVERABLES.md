# PHASE 13 — SAP / ERP Integration Architecture (foundation)

## 1. Objective
Lay the architecture for SAP/ERP integration: many ERP connections per tenant, a default ERP, per-connection capabilities with explicit direction, a provider/OData abstraction, a *real* connection test, normalized errors, secret-safe credential handling and tenant isolation. **No synchronisation is implemented** (Phase 14).

## 2. Existing SAP/ERP architecture found (audit)
| Area | Found | Decision |
|---|---|---|
| SAP/ERP connection config, OData client, integration services | **None** | Built new |
| `sap_sync_records` table + `SapSyncRecord` model (Phase 4) | Status-only table for sales documents; nothing writes to it | **Untouched.** Phase 14 will relate sync jobs to it |
| Admin dashboard `sap: { status: "not_configured" }` | Hard-coded honest placeholder | **Untouched** (see §13) |
| Frontend: `SapStatusIndicator`, `SapBadge`, shared nav group `sap` (all "planned") | Display only | Reused; nav group gets one live item |
| Scheduler / queue / Redis | `utils/batchExpiryJob.js` only (not scheduled anywhere). No Redis, no cron | Not added (Phase 14) |
| Audit system | **None** (docs mention only) | Events go to the existing console-trace convention; documented as future work |
| Encrypted secret storage | **None** | No secret is stored — see §10 |
| **Tenant concept** | "Tenant" = *Distributor*. Admin is a single company-side identity (`admin_users` has no tenant column) | See §11 — **business decision needed** |
| Logging / errors | `console.*`, `handle()` + typed error class per module | Followed |
No existing SAP functionality conflicts with this architecture.

## 3. Files created
**Backend** — `services/erp/{erpConstants,erpErrors,secretResolver,urlValidator,odataClient,sapProvider,connectionManager,tenantScope}.js` · `services/erpIntegration.service.js` · `controllers/admin.erp.controller.js` · `models/{erpconnection,erpconnectioncapability,erpentitymapping}.model.js` · `migrations/20261006090000-erp-integration-phase13.js` · `tests/erp-integration-phase13.test.js` · `docs/PHASE13_DELIVERABLES.md`
**Frontend** — `features/erpIntegration/{erpDisplay.js, api/erpApi.js, pages/ErpConnectionsPage.jsx, components/{ErpConnectionCard,ErpFormModal,ErpDetailDrawer,ErpStatusDialog}.jsx}`

## 4. Files modified (additive edits only)
Backend: `models/index.js` (register 3 models + associations) · `routes/adminRoutes.js` (8 routes + import).
Frontend: `App.jsx` (import + route `/admin/sap/connections`) · `config/adminNavigation.js` (SAP group: new live item "ERP Connections"; other items stay planned).

## 5. Database changes
Three new tables, created by one idempotent, reversible, non-destructive migration (`down` drops only these):
- `erp_connections` — tenant_key, code, name, erp_type, environment, odata_version, base_url, odata_service_path, sap_client, company_code, auth_type, credential_ref, timeout_ms, status, is_default, default_marker, description, last_test_* (at/ok/code/message/latency), created/updated_by_admin_id. Unique `(tenant_key, code)`; unique `default_marker`.
- `erp_connection_capabilities` — connection_id, capability, direction, enabled, endpoint_path. Unique `(connection_id, capability)`.
- `erp_entity_mappings` — connection_id, capability, sap_entity, sap_field, dms_entity, dms_field, is_key, transform (foundation only; no API/UI).
Verified: up → up → down → up on sqlite; `sap_sync_records` unaffected. **Not run against MySQL.**

## 6. API endpoints (`/api/admin/…`, all `requireAdmin`)
`GET /erp-integrations/lookups` · `GET /erp-integrations` (filters: q, status, erpType, environment) · `GET /:id` · `POST /` · `PUT /:id` · `PATCH /:id/status` `{status: ACTIVE|INACTIVE, clearDefault?}` · `PATCH /:id/default` · `POST /:id/test`.
Responses are `no-store`. Unknown/foreign id → 404. A **failed test returns HTTP 200 with `ok:false`** (the test ran; the failure is the result).

## 7. Multi-ERP architecture
`Tenant → ERP connections (N) → capabilities (per connection) → [Phase 14: sync jobs] → OData endpoint`. The UI is a card grid, one card per connection, with a DEFAULT badge. Codes auto-number per tenant (`ERP-001`…) or can be supplied. `OTHER_ERP` can be stored but has no provider yet.

## 8. Default ERP behaviour
- At most one default per tenant: enforced by a transaction **and** by a DB unique index (`default_marker`, set to the tenant key only on the default row) — works on MySQL, which has no partial indexes.
- Setting a default clears the previous one atomically. Creating connections never selects a default.
- An INACTIVE connection cannot be default.
- Deactivating the default is refused (409 `DEFAULT_ERP_CONNECTION`) unless the admin explicitly confirms "leave no default" (`clearDefault:true`); nothing else is promoted. The list endpoint exposes `hasDefault` and the UI shows a "No default ERP" warning.

## 9. SAP OData architecture
`Controller → erpIntegration.service → connectionManager.buildProvider → sapProvider → ODataClient → SAP`.
`ODataClient`: URL building, `sap-client`, Basic auth built internally, per-request timeout (AbortController), redirects **not** followed, HTTP→error mapping, body cap, V2/V4 payload normalization, secret-free trace log with correlation id (`X-Correlation-ID`). Phase 14 adds reads/writes (and CSRF-token handling for writes) in the provider.
`connectionManager` also provides `getDefaultConnection`, `requireDefaultConnection`, `findConnectionsForCapability` — the Phase 14 entry points.

## 10. Security approach
- **No password/secret is stored in the database, returned by any API, or entered in the browser.** A connection stores only `credential_ref` (e.g. `SAP_PROD`); the server resolves `ERP_<REF>_USERNAME` / `ERP_<REF>_PASSWORD` from its environment. The UI shows a masked `••••••••` and whether the server can find the reference.
- **Production requirement:** use your secret manager (Vault / AWS Secrets Manager / Azure Key Vault) by calling `setSecretProvider()` in `services/erp/secretResolver.js`; env vars are a minimum, not a recommendation for production. No custom encryption was invented.
- URL validation (server-side, also re-checked at test time): http(s) only, **https required in production**, no embedded user:password, no query/fragment, link-local/metadata addresses refused, loopback refused in production, optional `ERP_ALLOWED_HOSTS` allow-list. Private ranges are allowed on purpose (on-premise SAP).
- Errors shown to users use fixed wording per code; raw SAP bodies, headers and stack traces are never returned; `redact()` is applied to log detail.
- Not covered: RBAC (Admin role is a label only, as in earlier phases) — any admin can manage ERPs.

## 11. Tenant isolation approach
Every query filters on `tenant_key`, derived **only** from the authenticated session by `services/erp/tenantScope.js` (a `tenantKey` in body/query is ignored). Another tenant's record is a 404 and SAP is never contacted. **Limitation:** the Admin portal has no tenant model today, so every admin resolves to `ERP_TENANT_KEY` (default `DEFAULT`). Isolation is proven in tests by passing different session tenant keys; it becomes operational when `admin_users` gets a tenant and `middleware/adminAuth.js` sets `req.admin.tenantKey`.

## 12. Connection test behaviour
Performs `GET <base_url><service_path>/$metadata` (with `sap-client`) and requires a real EDMX document. Outcomes: `CONNECTED`, `AUTHENTICATION_ERROR` (401/403), `INVALID_ENDPOINT` (404/redirect), `SAP_SERVER_ERROR` (5xx/429), `SAP_REQUEST_REJECTED` (other 4xx), `INVALID_RESPONSE` (e.g. HTML login page with 200), `CONNECTION_TIMEOUT`, `NETWORK_ERROR` (DNS/refused/TLS), `CONFIGURATION_ERROR` (bad URL, missing credentials, unsupported ERP type — SAP is not called). A version mismatch (V2 vs V4) is a warning. The result is saved; for an enabled connection status moves ACTIVE⇄ERROR; an INACTIVE connection can be tested but is never re-enabled. Saving configuration never marks it connected ("Not tested"); editing connectivity fields resets the last result.

## 13. Future Phase 14 integration points
`findConnectionsForCapability(db, tenant, capability)` → which ERP / direction / `endpoint_path`; `getDefaultConnection`; `buildProvider(connection)`; `ErpIntegrationError` (+`retryable`) for job retry logic; `erp_entity_mappings` for field mapping; `sap_sync_records` for document status; the dashboard `sap` block and header `SapStatusIndicator` can be fed from `last_test_*` / job health (left unchanged now to avoid scope creep).

## 14. Tests executed
- New `tests/erp-integration-phase13.test.js`: **55/55 pass** — CRUD, validation, default rules (incl. DB-level uniqueness), activate/deactivate, 3 ERPs coexisting, tenant isolation (read/edit/status/default/test → 404, SAP never called), body-tenant ignored, capabilities, every connection-test outcome, timeout really aborts, no secret in responses/logs, audit events, migration.
- **Full backend suite: 406 pass / 1 fail of 407.** The failure is `fefo-expiry-phase6 › Batch Detail's fefo.priority … tenant boundaries` — **pre-existing** (fails identically on the untouched Phase 12 code; previously noted in Phases 9–12). **Phase 13 failures: 0.**
- HTTP smoke (real Express + Admin cookie login + local mock SAP gateway): unauthenticated 401; 3 ERPs created; default set/flipped, always exactly one; mock gateway test → CONNECTED / AUTHENTICATION_ERROR / INVALID_RESPONSE; ERP #2 deactivated; default deactivation refused without consent; no secret in any response.

## 15. Build / lint
`npm run build` — **PASS**. ESLint — **clean on all new/changed files**. Project-wide `npm run lint` reports 33 errors / 10 warnings in 23 **existing** files (e.g. `adminSales/sample/sampleSalesApi.js`) that this phase did not touch.

## 16. Known limitations
- **Real SAP connectivity was NOT verified.** No SAP credentials/system were available; the "Connected" results above come from a mock gateway/mocked `fetch`. Real connectivity needs real credentials and network access. Nothing was faked as successful in the product.
- Frontend has no test suite; UI behaviour (cards, add/edit, set default, test, activate/deactivate, masked fields, navigation) was verified by build + lint + the API contract, **not by in-browser clicking** — please run the manual steps in §17.
- Migration not run on MySQL. Basic auth only (OAuth/X.509 later). Sequential test timeout min 1 s. Entity mappings have no API/UI. No RBAC. Audit = log lines only. No credential-rotation tooling.

## 17. Manual testing steps
1. Set `ERP_SAP_PROD_USERNAME`, `ERP_SAP_PROD_PASSWORD` (and `ERP_TENANT_KEY` if desired) in the backend environment; run the migration (`npx sequelize-cli db:migrate`).
2. Admin login → **SAP Integration → ERP Connections**.
3. Add ERP #1 (ref `SAP_PROD`), #2, #3 → three cards appear, "No default ERP" warning shows.
4. Set ERP #1 default → only #1 shows DEFAULT. Set #2 → #1 loses it.
5. Test: wrong URL → Invalid endpoint; wrong creds → Authentication error; real SAP → Connected.
6. Deactivate #2 → card inactive, "Set default" disabled. Deactivate the default → confirmation explains "no default".
7. Edit → password field is masked/disabled; confirm no secret appears in the Network tab.
8. Open Dashboard, Sales, Inventory, Claims, Accounts, and the Distributor portal — all load as before.

## 18. Business decisions still required
1. **Tenant model:** is the tenant the manufacturer company (current single-tenant behaviour), or must admins be scoped to several companies? Needed before multi-tenant isolation is live.
2. Production secret store (Vault / cloud manager) and who owns credential rotation.
3. Which OData **service per capability** (e.g. API_PRODUCT_SRV, API_BUSINESS_PARTNER) and its entity sets — `endpoint_path` is ready but unpopulated.
4. **Default directions** in `erpConstants.js` are proposals (masters SAP→DMS, transactions DMS→SAP, stock/documents both ways) — confirm.
5. Mapping keys/transformations (material number leading zeros, customer ↔ retailer vs distributor, plant ↔ warehouse, company code).
6. Whether `SECONDARY`/`QUALITY`/`TEST` environments and "Other ERP" are the right list; whether a default may be a connection in ERROR state (currently allowed; INACTIVE is not).
7. Who may manage ERPs (RBAC) and whether audit events need a persistent table.

---
## PHASE 13 STATUS
Architecture: **COMPLETE** · Backend: **COMPLETE** · Frontend: **COMPLETE (build/lint verified; not click-tested in a browser)** · Database: **COMPLETE** (MySQL not run) · Multi-ERP: **COMPLETE** · SAP OData Foundation: **COMPLETE** (real SAP not reachable from here) · Security: **COMPLETE** for credentials/URL/errors; **PARTIAL** (no RBAC, env-var secrets) · Tenant Isolation: **PARTIAL** (enforced in code and tests; admin→tenant mapping does not exist yet) · Tests: **PASS** (Phase 13 55/55; suite 406/407, 1 pre-existing) · Build: **PASS**

**Files Not Changed:** all existing controllers, services, models, routes and pages outside the four modified files above — including Sales, Inventory, Claims, Accounts, Distributor portal, `sapsyncrecord.model.js`, `adminDashboard.service.js`, `navigation.js`, `SapStatusIndicator.jsx`.

Phase 14 can now implement actual SAP Sync Management.
