# PHASE 17 — Pre-change audit (ERP integration, Phases 13–16 baseline)

Scope: the backend and frontend delivered at the end of Phase 16. Method: read the ERP routes, controllers, services, scheduler, models and the Admin
authentication path; run the existing suite for a baseline (569 tests: 564 pass, 5 fail — all in `fefo-expiry-phase6`, unrelated to ERP, caused by
real-date dependence); then review each Phase 17 requirement against the code. Severity: **H** = exploitable / data-integrity risk, **M** = hardening gap,
**L** = polish. "Fixed" points to the section of `PHASE17_DELIVERABLES.md`.

| # | Area | Finding (before Phase 17) | Sev | Status |
|---|------|---------------------------|-----|--------|
| 1 | Authorization | Every ERP route required only `requireAdmin` (any active Admin). `admin_users.role` was a label; no ERP permission existed. A read-only user could create connections, trigger syncs, retry jobs and read the audit log. | H | Fixed (§4, §5) |
| 2 | Authorization | The role would have been trusted from the JWT had RBAC been added naively; deactivated / re-roled admins must take effect at once. | M | Fixed: role read from `admin_users` on every request |
| 3 | Tenant isolation | Tenant resolved from the session (good) and every query filtered by `tenant_key`, but there was no test proving "foreign id ⇒ 404 and **no ERP call**" across all routes (connections, mappings, code mappings, schedules, jobs, outbound, audit). | M | Verified by tests (§6) |
| 4 | Input validation | Query / body values were validated route by route; paging caps, filter allow-lists, string lengths and unknown-field handling were inconsistent. `__proto__` / `constructor` / `prototype` keys were not rejected. | M | Fixed (§7) |
| 5 | SSRF | URL validator blocked bad schemes and some hosts, but: no metadata / link-local / multicast block independent of environment flags; private ranges were accepted in production; no DNS re-check (a public name resolving to `169.254.169.254`); HTTP redirects were followed by `fetch`; paginated "next" links could point to another host. | H | Fixed (§7, §8) |
| 6 | Secrets | Credentials were already references only (never stored, never returned). Redaction was ad hoc: error messages, provider error bodies and log lines could still carry a token if an ERP echoed it. | M | Fixed: central `redaction.js` (§9) |
| 7 | Error shape | Errors were `{success:false, code, message}` in some controllers and thrown 500s with raw messages in others. | M | Fixed: standard envelope + legacy keys (§7) |
| 8 | Observability | Correlation id existed for sync jobs only. HTTP request → audit row → job → provider header were not linked. | M | Fixed (§7) |
| 9 | Scheduler | Schedule claim and job claim were compare-and-swap (Phase 15). Gaps: stale-job reaper was not CAS (two reapers could both close and double-audit); retry delay was uncapped; a disabled schedule did not stop a run already in progress; no graceful shutdown (in-flight runs left RUNNING until the stale timeout); no heartbeat index. | H | Fixed (§9) |
| 10 | Rate limiting | None. Test-connection, manual sync, audit search and summaries could be hammered; a naive limiter could also throttle the scheduler. | M | Fixed; the scheduler path is limiter-free (§7) |
| 11 | Audit | Append-only by service API (Phase 16) but nothing stopped a model-level `update` / `destroy`; access denials and security-config changes were not recorded. | M | Fixed (§10) |
| 12 | Database | Hot queries without an index: stale-job reaper (`status, heartbeat_at`), due-retry branch (`enabled, next_retry_at`), audit "who" filter (`tenant_key, actor_admin_id`). | M | Fixed (§11, §14) |
| 13 | Connection health | `REACHABLE / FAILED / NOT_TESTED` only; a connection with a stale test or a failing last sync still showed "reachable". | M | Fixed: `CONNECTED / DEGRADED / FAILED / NOT_TESTED / DISABLED`, legacy `state` kept |
| 14 | Alerts | Computed from real data (Phase 16) — correct, no notification channel. | L | Verified; no fake alerts, no email / SMS added |
| 15 | Config validation | Save-time validation covered URL and enums; no cross-field checks (auth type vs provider, pagination vs response path, http on a PRODUCTION connection, unknown provider-config keys). | M | Fixed (§7) |
| 16 | Readiness | No endpoint summarising whether the integration can run in production. | M | Fixed (§12) |
| 17 | Frontend | UI offered every action to every Admin; errors lost the server reference; no new health states. | M | Fixed (§13) |
| 18 | Queue | Jobs run on a DB-backed worker inside the app process. No external queue, no dead-letter queue. | — | Documented limitation (§17); no Redis / BullMQ added |
| 19 | Rate limiter scope | (new, by design) The Phase 17 limiter is in-memory, per process. | — | Documented limitation (§17) |

## Pre-existing failures (not touched)
`tests/fefo-expiry-phase6.test.js` — 5 tests (expiry buckets and FEFO tenant-isolation HTTP checks) fail on the baseline because they depend on the current
real date. They are unrelated to ERP; no business logic was changed to hide them.

## Items verified and left unchanged
Phase 16 ownership gate and business error codes (`BUSINESS_DECISION_REQUIRED`, `PROVIDER_NOT_SUPPORTED`, `OUTBOUND_SYNC_BLOCKED` …); inventory and accounting
paths (the ERP target never writes `StockLedger`); SAP-specific logic stays inside `sapProvider.js` / `odataClient.js` (the generic engine has none).
