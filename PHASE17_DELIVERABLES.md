# PHASE 17 — Production hardening of the ERP integration

## 1. Objective
Harden the Phase 13–16 vendor-neutral ERP integration for production **without rebuilding or removing anything**: server-side RBAC, tenant-isolation proof,
SSRF / URL policy, secret redaction, a standard error shape, correlation ids, scheduler / worker reliability, rate limiting, audit immutability, indexes,
honest connection health, readiness, frontend permission UX, and an automated Phase 17 test suite. No Retailer login / portal / dashboard was created; no
ERP adapter was added; no Oracle / Dynamics support is claimed; no Invoice / Return / Document sync was implemented.

## 2. Audit findings
See `PHASE17_AUDIT.md` (19 findings, severity and status). Highest: ERP routes had no authorization beyond "any Admin" (H), SSRF gaps — redirects, DNS rebinding, metadata addresses, cross-host next-page links (H), and a non-CAS stale-job reaper plus no cooperative stop (H).

## 3. Security changes
RBAC (§4–5) · tenant 404s with zero ERP calls (§6) · SSRF policy (§7) · redaction (§8) · standard errors and correlation ids · rate limiting · prototype-pollution rejection · CORS origin / body-size / `TRUST_PROXY` settings in `server.js` · access-denied auditing · append-only audit.

## 4. RBAC design
* Permissions: `ERP_VIEW, ERP_MANAGE, ERP_SYNC, ERP_RETRY, ERP_SCHEDULE, ERP_AUDIT`. Roles: `SUPER_ADMIN, ERP_ADMIN, ERP_OPERATOR, ERP_VIEWER`.
* **ERP-scoped**: only `/api/admin/erp-integrations*` and `/api/admin/erp-sync*` are governed. Every other Admin module keeps its old behaviour (any active admin) — nothing silently changes for Sales / Inventory / Accounts.
* The role is read from `admin_users` on **every** request (not from the JWT): a role change or deactivation applies to the next request.
* Deny by default: unknown / empty roles get no ERP permission. **Compatibility:** the legacy default role `ADMIN` keeps full ERP permissions so nobody loses access on upgrade; tighten with `node scripts/set-admin-role.js <email> <ROLE>` (audited as `ERP_RBAC_ROLE_CHANGED`).
* Distributor sessions never satisfy Admin authorization (separate cookie / secret).
* 401 `UNAUTHENTICATED` without a session; 403 `FORBIDDEN` "You don't have permission to perform this action." — the message never names the permission or role. Denials are audited (`ERP_ACCESS_DENIED`, throttled to one row / admin / permission / minute).
* `/session` and `/me` return `admin.erpPermissions` for the UI (UX only).
* Route order: `requireAdmin` → `erpPermission` → rate-limit policy → controller. (A 403 is answered before the limiter and before any validation.)

## 5. Permission matrix
| Route | Permission (any-of) | SUPER_ADMIN / ERP_ADMIN / ADMIN(legacy) | ERP_OPERATOR | ERP_VIEWER |
|---|---|:-:|:-:|:-:|
| GET lookups, readiness, connection list / detail, mappings, code-mappings, sync summary / jobs / job / errors, schedules, alerts, outbound list | ERP_VIEW | ✔ | ✔ | ✔ |
| GET `/erp-sync/audit` | ERP_AUDIT | ✔ | ✘ | ✔ |
| POST / PUT / PATCH connection, status, default, mappings, code-mappings (PUT / DELETE) | ERP_MANAGE | ✔ | ✘ | ✘ |
| POST `/erp-integrations/:id/test` | ERP_MANAGE or ERP_SYNC | ✔ | ✔ | ✘ |
| POST `/erp-sync/jobs` (start sync), POST `/erp-sync/schedules/:id/run`, POST `/erp-sync/outbound` | ERP_SYNC | ✔ | ✔ | ✘ |
| POST `/erp-sync/jobs/:id/retry` | ERP_RETRY | ✔ | ✔ | ✘ |
| PUT `/erp-integrations/:id/schedules/:capability` | ERP_SCHEDULE | ✔ | ✘ | ✘ |

Role → permissions: SUPER_ADMIN, ERP_ADMIN = all six; ERP_OPERATOR = VIEW, SYNC, RETRY; ERP_VIEWER = VIEW, AUDIT. The test suite walks **every registered ERP route × 7 roles + anonymous** and fails if a route is added without a matrix row.

## 6. Tenant isolation verification
Tenant comes only from the authenticated session (never body / query / header). Tests: a Tenant-A admin against Tenant-B connection, sync start, mappings, code mappings, schedule, outbound, job, errors, audit → **404 `NOT_FOUND`** on every probe, lists are empty, audit hides foreign rows, and the mock `fetch` is asserted **never called**. `tenantKey` / `tenant_key` in body, query and `X-Tenant-Key` are ignored. Single company-side admin identity today: every admin resolves to `ERP_TENANT_KEY` (default `DEFAULT`); when `admin_users` gains a tenant column set `req.admin.tenantKey` in `adminAuth.js` — nothing else changes.

## 7. API hardening
* **Validation** (`utils/erpValidate.js`): allow-listed enums, bounded integers / strings, strict dates, capped paging (`pageSize ≤ 200`), unknown provider-config keys → 400, `__proto__` / `constructor` / `prototype` keys → 400 `VALIDATION_FAILED` in body and query, JSON body limit (`JSON_BODY_LIMIT`, default 100 kb).
* **Standard error**: `{success:false, error:{code,message,correlationId[,details]}}`; the legacy flat keys (`code`, `message`, `details`) are retained so Phase 13–16 clients and tests still work. Existing business codes are unchanged. Unexpected exceptions return a fixed `INTERNAL_ERROR` "Unable to complete the request" (details only in the redacted server log, with the correlation id). Success bodies are unchanged.
* **Correlation ids**: `X-Correlation-ID` accepted (sanitised, ≤ 64 chars `[A-Za-z0-9._-]`) or generated; echoed in the response header and error body; carried by `AsyncLocalStorage` into audit rows, sync jobs, and the provider request header.
* **Rate limiting** (dependency-free fixed window, per admin, else IP; headers `X-RateLimit-*`, 429 `RATE_LIMITED` + `Retry-After`): defaults / min — read 600, write 60, test 10, sync 20, outbound 120, audit 60, heavy 60, report 120, login 30. Env-tunable; `RATE_LIMIT_DISABLED=true` turns it off. **The scheduler / worker never pass through the limiter** (asserted by test).
* **SSRF / URL policy** (`services/erp/urlValidator.js`):
  * Always refused (every environment, even with opt-ins): non-http(s) schemes, credentials in URL, cloud metadata (`169.254.169.254`, `metadata.google.internal`…), link-local, unspecified, multicast, IPv6 equivalents, encoded / octal / decimal IP tricks.
  * Production additionally refuses `http://` (unless `ERP_ALLOW_HTTP`), loopback, RFC1918 / CGNAT / ULA ranges and internal host names unless `ERP_ALLOW_PRIVATE_NETWORK=true` (on-premise ERP over VPN).
  * `ERP_ALLOWED_HOSTS` (comma list): when set, only those hosts.
  * Production DNS check (`ERP_DNS_CHECK`, default on): the host is resolved at connect time; **any** internal answer refuses the call before credentials are resolved or a request is made.
  * Service paths: no `..`, `//`, encoded traversal, query, fragment, backslash, control chars; ≤ 255 chars.
  * Redirects are **never followed** (`redirect:"manual"`; any 3xx is an error). A pagination "next" link must stay on the same origin.
* **Config validation** (`erpConfigValidation.service.js`): errors block the save, warnings are returned (`configWarnings`) — e.g. `http` on a PRODUCTION connection, auth type unsupported by the provider, pagination without response path, ownership / direction conflict (`OWNERSHIP_DIRECTION_CONFLICT`, a warning so Phase 16 runtime `BUSINESS_DECISION_REQUIRED` behaviour is preserved).
* **Connection health** (`health.status`): `CONNECTED` (last real test passed, recent, credentials present, last sync not failed) · `DEGRADED` (passed with warnings, or test older than `ERP_TEST_STALE_HOURS`, or latest sync failed) · `FAILED` · `NOT_TESTED` · `DISABLED` (inactive). Never CONNECTED merely because configuration exists. Legacy `health.state` (`REACHABLE | FAILED | NOT_TESTED`) kept.
* **Documented production network policy:** egress from the app host should be limited to the ERP hosts (firewall / security group / proxy allow-list) in addition to the in-app policy; the app host must not be able to reach cloud metadata or internal admin interfaces; ERP endpoints should be reached over TLS (VPN / private link for on-premise); inbound only from the reverse proxy.

## 8. Secret handling
Connections store only a credential **reference** (`credentialRef`); secrets live in server environment variables / a secret manager. API responses expose `credentials:{reference,status}` only. `services/erp/redaction.js` redacts keys matching password / secret / token / authorization / cookie / apiKey / clientSecret / accessToken / refreshToken / csrf and `Bearer …` / `Basic …` / JWT-looking strings in logs, error messages, provider error bodies, job-error rows and audit metadata. Test: a connection test, a failing test, a sync and an HTTP round trip with known secret values — none appear in logs, responses, audit rows or error rows.

## 9. Scheduler hardening
Compare-and-swap schedule claim and QUEUED→RUNNING job claim (no double run with concurrent schedulers / workers); stale reaper is CAS (closed once, audited `ERP_SYNC_INTERRUPTED`, frees `active_key`); retries bounded (`ERP_SYNC_AUTO_MAX_RETRIES`), exponential backoff with cap (`…_MAX_DELAY_MINUTES`), transient errors only, never later than the next regular slot; schedule disabled / ERP deactivated → queued run cancelled, running run stops between pages; `shutdownScheduler` waits `ERP_SHUTDOWN_GRACE_SECONDS` for in-flight runs then returns the rest as FAILED (retryable) and frees the schedule; QUEUED jobs survive restart; `ERP_SCHEDULER_ENABLED=false` to run the scheduler in exactly one process. All limits clamped to safe ranges.

## 10. Audit improvements
Append-only enforced in the model (hooks reject `update` / `destroy` / bulk update / bulk destroy) and by API design (no update / delete function or route). New events: `ERP_ACCESS_DENIED`, `ERP_RBAC_ROLE_CHANGED`, `ERP_SECURITY_CONFIG_UPDATED`, `ERP_SYNC_INTERRUPTED`. Metadata is key-filtered, value-redacted and truncated; a write failure never breaks the business flow. Optional DB-level protection (trigger / `REVOKE UPDATE, DELETE`) is documented only, not applied.

## 11. Performance / index changes
Three indexes (also declared in the models): `ix_erp_job_status_heartbeat (status, heartbeat_at)` — reaper and readiness; `ix_erp_sched_retry (enabled, next_retry_at)` — due-schedule retry branch; `ix_erp_audit_tenant_actor (tenant_key, actor_admin_id)` — audit "who" filter. Existing Phase 13–16 indexes were reviewed and kept. List endpoints are capped.

## 12. Monitoring / readiness
`GET /api/admin/erp-integrations/health/readiness` (ERP_VIEW; rate-limited "heavy"): read-only report — database, environment, required env var **names**, migrations, connections, credential resolution, provider status, stored-config validity, failed / untested connections, ownership decisions, scheduler timer, stale jobs, overdue schedules, queue (always WARN: no external queue), audit store, secret store. Statuses PASS / WARN / FAIL / SKIP → `READY | READY_WITH_WARNINGS | NOT_READY`. Never returns a secret or env value, never calls an ERP. Alerts remain computed from real job / connection data; **no email / SMS / webhook delivery exists** (not faked).

## 13. Frontend changes
`erpPermissions.js` (`useErpPermissions`, `hasErpPermission`), `ErpAccessGate` on ERP routes (no-access page), navigation entries filtered by permission (`filterAdminNavigation`; non-ERP modules untouched), buttons hidden by permission (Add / Edit / Activate / Default / Mapping → MANAGE; Test → MANAGE|SYNC; Sync → SYNC; Schedule → SCHEDULE; Retry → RETRY; code mappings read-only without MANAGE), `AdminApiError.correlationId` and "(ref …)" in error toasts, the five health states, and an Integration readiness panel on the dashboard. **These checks are UX only; the backend enforces everything.**

## 14. Database changes
`migrations/20261010090000-erp-phase17.js`: three indexes only; idempotent (`up` skips existing), reversible (`down` removes only these); no table / column / data change. **Verified on sqlite (up / up / down / down / up) in `erp-reliability-phase17.test.js`. Migration not verified against MySQL** (no MySQL server in this environment) — run it on a staging copy first.

## 15. Tests
New: `erp-security-phase17.test.js` (86) and `erp-reliability-phase17.test.js` (30) = **116 new tests**, plus `tests/helpers-http.js` (real Express app over `node:http`). Covered: RBAC route × role matrix, role change / deactivation, denial audit, tenant isolation with zero ERP calls, SSRF (URL, DNS, redirects, next-page), secret redaction end to end, standard errors, correlation flow, input hardening, rate limiting (per admin / policy; scheduler exempt), config validation, health states; scheduler concurrency, stale worker, crash during sync, crash after provider success, crash before completion, retry exhaustion, duplicate trigger, schedule disabled during execution, shutdown, audit immutability, paging caps, readiness, alerts, migration, indexes. All ERP transports are mocks — they prove our handling, not real ERP connectivity.
Two intentional assertion updates in `erp-integration-phase13.test.js`: route count 14 → 15 (readiness route) and private-IP base URLs now refused in production unless `ERP_ALLOW_PRIVATE_NETWORK` (assert both).

## 16. Build status
Backend `npx jest --runInBand`: **685 tests, 680 passed, 5 failed** (20 suites: 19 passed, 1 failed). **NEW failures: 0.** **PRE-EXISTING failures: 5**, all in `fefo-expiry-phase6.test.js` (real-date dependent, identical to the baseline of 569 tests / 5 failed). Baseline 569 + 116 new = 685. (One run of `inventory-phase5` failed once while another jest process was running concurrently; it passes alone and in the clean full run — a load-timing flake, not a regression.) Frontend `npm run build`: success. ESLint on the touched frontend files: no findings.

## 17. Known limitations
* Rate limiter and the denial throttle are in-memory, **per process** — behind several instances limits multiply; use the reverse proxy / gateway for global limits.
* No external queue / dead-letter queue (no Redis / BullMQ in the project): the DB-backed worker runs in-process; exhausted jobs stay visible as FAILED. Run the scheduler in one process (`ERP_SCHEDULER_ENABLED`).
* Admin identity has no tenant column: all admins share the configured tenant.
* ERP-scoped RBAC only; the legacy `ADMIN` role keeps full ERP access until admins are re-roled.
* Credentials come from environment variables; a secret manager is recommended.
* DNS check narrows but cannot fully eliminate DNS-rebinding between check and connect; the network egress policy is the second layer.
* Alerts are visible in the UI only; there is no notification delivery.
* Migration not verified against MySQL. Real SAP / REST ERP connectivity not verified (mocks only).
* Audit immutability is enforced in the application; DB-level enforcement is optional and not applied.

## 18. Production deployment requirements
`NODE_ENV=production`; strong `JWT_SECRET` / `ADMIN_JWT_SECRET`; `CORS_ORIGIN` set to the real frontend origin; `TRUST_PROXY` set to the proxy hop count; HTTPS termination; run `npx sequelize-cli db:migrate` (after staging check on MySQL); assign roles (`node scripts/set-admin-role.js`); set `ERP_<REF>_*` credential variables or a secret manager; decide `ERP_ALLOWED_HOSTS` / `ERP_ALLOW_PRIVATE_NETWORK`; egress firewall to ERP hosts only; exactly one scheduler process; back up the DB; check `/health/readiness` returns no FAIL; monitor logs by correlation id.

## 19. Remaining business decisions
Unchanged from Phase 16: ownership of STOCK, payments, prices etc. (`BUSINESS_DECISION_REQUIRED`); approved accounting ownership before Invoice sync; invoice / delivery architecture before Return sync; secure document storage before Document sync. New: which admins get which ERP role; whether to add a tenant column to admin users; whether alert notifications (email / SMS / chat) are wanted and through which channel; whether to adopt an external queue.

## 20. Files created
Backend — `utils/requestContext.js`, `utils/erpValidate.js`, `config/erpPermissions.js`, `middleware/{requestContext,errorHandler,rateLimiter,erpAccess}.js`, `services/erp/{redaction,runtimeConfig}.js`, `services/{erpConfigValidation,erpInflight,erpReadiness}.service.js`, `migrations/20261010090000-erp-phase17.js`, `scripts/set-admin-role.js`, `tests/{helpers-http,erp-security-phase17,erp-reliability-phase17}.test.js`, `PHASE17_AUDIT.md`, `PHASE17_DELIVERABLES.md`.
Frontend — `src/features/erpIntegration/{erpPermissions.js,ErpAccessGate.jsx}`, `src/features/erpIntegration/components/ErpReadinessPanel.jsx`.

## 21. Files modified
Backend — `server.js`, `.env.example`, `middleware/adminAuth.js`, `controllers/{admin.auth,admin.erp}.controller.js`, `routes/{adminRoutes,allRoutes}.js`, `scripts/create-admin.js`, `services/{erpIntegration,erpSync,erpScheduler,erpMonitoring,erpAudit,erpOutbound,erpCodeMapping}.service.js`, `services/erp/{urlValidator,connectionManager,erpErrors,providerRegistry}.js`, `services/erp/sync/syncEngine.js`, models `erpsyncjob / erpsyncschedule / erpauditevent` (indexes only), `tests/erp-integration-phase13.test.js` (2 intentional assertions).
Frontend — `src/App.jsx`, `src/config/adminNavigation.js`, `src/utils/adminApi.js`, `src/features/adminAuth/AdminLayout.jsx`, `src/features/erpIntegration/{erpDisplay.js, api/erpApi.js}`, components `ErpConnectionCard, ErpCodeMappingModal, ErpFormModal, ErpMappingModal, ErpScheduleModal, ErpStartSyncModal, ErpStatusDialog`, pages `ErpConnectionsPage, ErpIntegrationDashboardPage, ErpSyncHistoryPage, ErpErrorMonitorPage, ErpAuditLogPage`.

## 22. Files intentionally NOT changed
`sapProvider.js`, `odataClient.js`, `genericRestProvider.js`, `restPagination.js` (no SAP or vendor logic moved into the engine); `targets.js` and every inventory / accounting service (no direct StockLedger writes, no accounting bypass); `erpOwnership.service.js`; all non-ERP Admin and Distributor controllers, routes and pages; Distributor authentication; existing migrations; no Retailer login / portal / dashboard.
