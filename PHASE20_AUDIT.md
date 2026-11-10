# PHASE 20 — Pre-change audit (ERP Business Decision Management UI)

Method: unpacked the Phase 19 backend and frontend ZIPs, read the **code** (not only the reports), ran the full backend suite for a baseline on **2026-10-10 (IST)**, then decided what can be built safely. Nothing in this file is copied from a report without being checked against the code.

## 0. Baseline

| Check | Result (before any Phase 20 change) |
|---|---|
| Backend `npx jest --runInBand` (clean, single process) | **22 suites, 753 tests, 753 passed, 0 failed** (matches `PHASE19_DELIVERABLES.md` §10) |
| Frontend `eslint src/features/erpIntegration` | clean |
| MySQL | not available in this environment → migration verification would be `NOT RUN` |

## 1. Existing functionality (verified in code)

| Area | What exists | Where |
|---|---|---|
| Decision register data | 23 questions, static list + `build()` + `summary()` | `services/erpDecisionRegister.service.js` |
| Register delivery | Part of the Phase 18 overview: `GET /api/admin/erp-sync/business/overview` → `decisionRegister` | `routes/adminRoutes.js:185`, `services/erpBusiness.service.js:215-216` |
| Route guard | `requireAdmin` + `erp("ERP_VIEW", "heavy")` (role re-read from `admin_users` on every request; deny-by-default; denied calls audited as `ERP_ACCESS_DENIED`) | `middleware/erpAccess.js`, `config/erpPermissions.js` |
| Tenant scope | overview filters `ErpConnection` by `tenant_key` resolved from the session; the register is built only from those rows | `erpBusiness.service.js:90`, `services/erp/tenantScope.js` |
| Only persisted decision | `erp_connection_capabilities.ownership` / `.direction`; written by `PUT /erp-integrations/:id` (`ERP_MANAGE`), validated against `OWNERSHIPS`, audited as `ERP_OWNERSHIP_UPDATED` | `erpIntegration.service.js:78-81`, `erpAudit.service.js:14` |
| Dashboard | `ErpIntegrationDashboardPage` renders `ErpReadinessPanel` + `ErpBusinessPanel` (route `/admin/sap/dashboard`, `ERP_VIEW`) | `fe/src/App.jsx:156` |
| Existing decision display | `ErpBusinessPanel` shows a per-connection **INVOICE-only** list (`x.decisions`, status DECIDED/REQUIRED/READY) and a "Decisions pending" count. **It does not render `decisionRegister` at all.** | `ErpBusinessPanel.jsx:94` |
| FE permission helper | `useErpPermissions()` (UX only), `ErpAccessGate` | `erpPermissions.js`, `ErpAccessGate.jsx` |
| FE data hook / API | `useAsyncData`, `erpBusinessApi.overview` | `useAsyncData.js`, `api/erpApi.js` |
| FE UI kit | Alert, Badge, Card, ConfirmationModal, EmptyState, ErrorState, LoadingState, Select, Tabs, KpiCard, FilterBar … | `fe/src/components/ui` |

### 1.1 Actual `decisionRegister` schema (from `build()` / `summary()`)

```
decisionRegister: {
  items: [{ id, area, question, blocks: [CAPABILITY], interim, status: "REQUIRED"|"CONFIGURED",
            answer: null | ["OWNERSHIP / DIRECTION", …], approval: "NOT_RECORDED", persistence }],
  summary: { REQUIRED: n, CONFIGURED: n }
}
```
Findings against the Phase 20 brief:
* `BUSINESS_APPROVED` does not exist anywhere in the backend; `approval` is the constant `"NOT_RECORDED"`.
* Items do **not** carry the capability they belong to except through `blocks` (and `capability` only exists on the 4 ownership questions in the static list, it is not returned).
* `answer` is a **tenant-wide aggregate** across connections; it does not say *which connection* holds which ownership, so the required **filter by ERP connection** cannot be done from the current register.
* The overview already has the per-connection ownership (`connections[].capabilities[].ownership`), classification, verification level, providers (`status`, `verification.real`) and `documentStore` readiness — enough to show capability readiness as **separate dimensions** without new queries.
* `decisionRegister` exposes no machine-readable statement that approval tracking is unavailable; the UI would have to hard-code it.

## 2. Reusable components and endpoints (no parallel implementation)

* **Endpoint:** reuse `GET /erp-sync/business/overview`. No new route is needed for reading (and a new route would change the Phase 14/17 route-count and RBAC-matrix tests for no benefit).
* **Ownership change action:** already exists (ERP Connections → edit connection → capability ownership, `ERP_MANAGE`, audited). The register UI **links to it**; it does not add a second write path.
* **UI:** extend `ErpBusinessPanel`'s page (the ERP Integration dashboard) with a new panel; reuse `useAsyncData`, `Badge`, `Card`, `Alert`, `Select`, `EmptyState`, `ErrorState`, `useErpPermissions`, and the display-map pattern in `erpBusinessDisplay.js`.

## 3. Files to create or modify

Backend (additive, backward-compatible; **no migration, no model change, no new route**):
* modify `services/erpDecisionRegister.service.js` — each item additionally returns `capability`, `mechanism`, `scope`, and (ownership questions) `connections[]`; the register returns `meta` (allowed statuses, approval tracking = not implemented + reason). Existing keys and values unchanged.
* modify `services/erpBusiness.service.js` — pass connection id/name to the register (one line); register `meta` passed through.
* create `tests/erp-phase20.test.js`.

Frontend:
* create `src/features/erpIntegration/erpDecisionView.js` (pure view-model: filters, counts, readiness dimensions, panel state — unit-testable without a browser).
* create `src/features/erpIntegration/components/ErpDecisionRegisterPanel.jsx`.
* modify `src/features/erpIntegration/pages/ErpIntegrationDashboardPage.jsx` (one import + one element) (no change to `erpBusinessDisplay.js`: the new status/readiness meta lives in the pure `erpDecisionView.js`).
* create `src/features/erpIntegration/erpDecisionView.test.mjs` (`node --test`, no new dependency; the project has no frontend test runner).

## 4. Persistence — what can safely be implemented

**Decision: nothing new is persisted in Phase 20.** Reasons, all verified:
1. The brief forbids inventing a business approver or approval policy. The system has no role, table, policy or document that says *who in the business* may approve a stock/invoice/return/document decision. `ERP_MANAGE` is a **technical** permission (it also edits mappings and credentials references), not a business-approval authority. Using it as "approver" would make `BUSINESS_APPROVED` a statement the system cannot back.
2. No code consumes any of the 19 non-ownership answers. A stored answer would be **advisory text**; presenting it as a decision that changes behaviour would be misleading, and wiring it to behaviour is Invoice/Return/Stock/Document implementation, which is out of scope.
3. A new approval table needs MySQL verification (unavailable here → `NOT RUN`), and Phase 17 pinned the route count and RBAC matrix.
4. The one executable decision (ownership/direction) is already persisted, validated, RBAC-protected and audited. The UI links to it.

Therefore: the UI is **read-only for decisions**, states plainly that approval tracking is not implemented, and has **no approve / propose button** (nothing that could change only frontend state).

### 4.1 Proposed persisted decisions — design only, NOT implemented, NOT claimed

Table `erp_business_decisions` (tenant-scoped, versioned, append-only history) — proposal for a later phase, **blocked on the unresolved dependencies in §4.2**.

| Item | Proposal |
|---|---|
| Decision key / allowed values | `decision_key` = register `id` (23 keys). Values per key, closed enums, e.g. `stock.batchCreation`: `NEVER` / `ERP_MAY_CREATE_WITH_EXPIRY_AND_MRP`; `sales.autoConfirm`: `NEVER` / `ALLOWED_WITH_RULE`; `invoice.erpAuthoritative`: `ERP` / `DMS_RECONCILE_ONLY`; free text only as `rationale` (length-capped). Values are rejected unless in the key's enum. |
| Tenant / connection scope | `tenant_key` NOT NULL (from the session, never from the body). `connection_id` NULL = tenant-wide, else must belong to the tenant (validated like every ERP route). UNIQUE (`tenant_key`, `decision_key`, `connection_id`, `version`). |
| Who proposes / reviews / approves | **UNKNOWN — business input required.** Technical sketch only: propose = `ERP_MANAGE`; review/approve = a **new** permission (e.g. `ERP_DECISION_APPROVE`) assigned to a role the business names; proposer ≠ approver enforced server-side. Not created. |
| Advisory vs executable | Default **advisory**. A key becomes executable only when the code that enforces it exists and is reviewed (ownership already is). |
| Audit events | `ERP_DECISION_PROPOSED`, `ERP_DECISION_APPROVED`, `ERP_DECISION_REJECTED`, `ERP_DECISION_SUPERSEDED` through `erpAudit.record` (immutable table), with actor, version, old/new value, correlation id; no free-text secrets. |
| Versioning / review | Every change inserts a new version row (`PROPOSED` → `APPROVED`/`REJECTED`); approved rows are never updated; a new proposal supersedes. |
| Change after sync has begun | An executable decision change must not alter a running job; it applies from the next job; a change on a key whose capability already has linked records must show an impact warning and require re-running reconciliation; ownership flips already follow this rule (preflight re-evaluates per job). |

### 4.2 Unresolved dependencies for any approval workflow
1. Which business role approves (per area: Stock, Sales, Invoice, Return, Payment/Pricing, Documents)?
2. Is two-person review (proposer ≠ approver) required?
3. What evidence counts as approval (internal ticket, signed minute, attachment)? Document storage is itself undecided (`document.storageProvider`).
4. Retention period for approval history.
5. Whether a decision may ever be executable without an accompanying code change.

## 5. Security and migration risks

| Risk | Assessment / handling |
|---|---|
| `CONFIGURED` mistaken for approval | UI uses the label "Configured — not business approval"; `BUSINESS_APPROVED` is never rendered as a status; tests pin it. |
| Fake approval UI | None built (no approve/propose control). |
| Tenant leak through the register | Register built only from tenant-filtered connections; new `connections[]` field carries id/name/ownership/direction only; test proves another tenant's connection never appears. |
| Secrets in the response | New fields exclude `credentialRef`, `baseUrl`, headers; a test asserts the serialised register contains none of those. |
| Client-side RBAC | UX only; `ERP_VIEW` is enforced by the route. Test over HTTP: no session → 401, role without `ERP_VIEW` → 403, `ERP_VIEWER` → 200. |
| Write endpoints | None added; test asserts no decision write route exists (POST/PUT/PATCH/DELETE → 404/405). |
| Rate limit | Reuses the existing `heavy` policy on the overview (unchanged). |
| Migration | None added. Existing Phase 18 migration remains "not verified against MySQL". |
| Date-dependent tests | Latent `2027-01-01` risk from Phase 19 §3.10 is unchanged; not part of this phase. |

## 6. Missing dependencies (for anything beyond read-only)
The business answers to all 23 register questions; a named approver role and evidence policy (§4.2); MySQL for migration verification; a frontend test runner if component-level tests are wanted (none is installed; not added here to keep `package.json` unchanged).
