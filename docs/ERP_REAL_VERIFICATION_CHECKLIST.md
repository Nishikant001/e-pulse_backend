# ERP real-environment verification checklist (repeatable)

**Purpose.** Turn "mock verified" into evidence. **Nothing below has been run against a real ERP. Every step is `NOT RUN` until a person executes it with authorised access and records evidence.**
Mock verification is not real-ERP verification. Configuration is not proof of production readiness. `PRODUCTION_VERIFIED` is never set automatically.

**Preconditions (all must be true, else mark the whole run `NOT RUN` and stop):**
- Written authorisation for the specific **staging / test** ERP tenant and the capabilities under test. **Never a production ERP for writes.**
- Credentials supplied through the credential reference (environment/secret store) — never pasted into a ticket, mapping or log.
- A dedicated DMS test tenant/distributor; a DB backup or disposable copy.
- The connection's `environment` is `TEST`/`STAGING`, base URL passes the SSRF policy.

| # | Step | How (DMS) | Pass criterion | Evidence to attach | Result |
|---|---|---|---|---|---|
| 1 | Connection test | Connections → Test | `last_test_ok`, latency recorded, no secret in response | screenshot/JSON, correlation id | NOT RUN |
| 2 | Read-only metadata / endpoint test | Provider metadata (OData `$metadata`) or a `GET` of the configured endpoint, page size 1 | 200 + parsable response; no write verbs used | request log with redacted headers | NOT RUN |
| 3 | Read Product Master | Bounded sync of `PRODUCT_MASTER` (scope: test distributor + HSN) with `limits.maxRecords` ≤ 20 | records fetched, mapped, created as expected | job id, counts | NOT RUN |
| 4 | Validate field mappings | Mapping screen + preflight (no blockers; review warnings) | `sync.preflight` returns no blockers; every required field mapped; sample record maps correctly | preflight output, 3 sample records ERP vs DMS | NOT RUN |
| 5 | Bounded test sync | Run with small page/record limits per capability under test | job SUCCESS/PARTIAL with explained errors; no unexpected rows | job summary + error list | NOT RUN |
| 6 | Idempotent re-run | Re-run the same job immediately | `created=0`, `updated=0`, all `skipped`; no new ledger/journal rows | before/after row counts | NOT RUN |
| 7 | Errors and retries | Induce a controlled failure (wrong endpoint path, revoked test token); retry a PARTIAL job | typed error (AUTHENTICATION_ERROR / INVALID_ENDPOINT…), bounded retry, no secret in message | error list, audit lines | NOT RUN |
| 8 | Outbound (only where approved **and** supported) | Customer master / Payment `send` to the **test** ERP only; provider must have `CREATE` + `IDEMPOTENCY` and `outbound.idempotencySupported` attested | same idempotency key → one ERP record; ERP id stored; no echo-import | outbound event, ERP-side record id | NOT RUN |
| 9 | Audit, correlation ids, redaction | Inspect audit events and server log for the runs above | every run has one correlation id across job/outbound/audit; tokens/passwords redacted | audit rows, log excerpt | NOT RUN |
| 10 | Record result | Fill the evidence record below | complete, signed by the reviewer | JSON record | NOT RUN |

Additional per-capability gates (do not skip): STOCK — first snapshot over empty DMS stock only; verify ledger rows come from `inventory.postAdjustment`. SALES — orders arrive as DRAFT only. PAYMENT — verify mode mapping and that the same ERP payment never posts twice.
**Out of scope until the business decides (see PHASE19_DECISION_REGISTER.md):** Invoice, Return, Document. Do not test them.

## Evidence record (one per provider × environment × capability × run)
```json
{
  "provider": "SAP_ODATA | GENERIC_REST",
  "environment": "STAGING",
  "connectionId": 0,
  "capability": "PRODUCT_MASTER",
  "step": "1-10",
  "result": "PASS | FAIL | NOT RUN",
  "timestamp": "2026-00-00T00:00:00Z",
  "correlationId": "",
  "evidence": ["job id / screenshot / log excerpt (redacted)"],
  "performedBy": "",
  "reviewedBy": "",
  "notes": "limitations, deviations"
}
```
Current recorded state: SAP OData — **mock verified, real NOT RUN**. Generic REST — **mock verified, real NOT RUN**. Oracle REST / Dynamics REST / Generic SOAP — **UNSUPPORTED (no adapter)**.
