# PHASE 20 — ERP Business Decision Management UI

**Outcome in one line:** the Business Decision Register is now visible in the ERP Integration dashboard, driven by real backend data, with accurate REQUIRED / CONFIGURED presentation, filters, expandable details, separate capability-readiness dimensions and all UI states. **It is read-only by design:** no approval or decision-saving workflow was built, because the business approver and approval policy are unknown (see §3). Nothing is claimed as business-approved. No migration. Invoice, Return and Document sync remain BLOCKED; no real ERP was reached.

## 1. Audit
`PHASE20_AUDIT.md`. Key findings: the register is returned by the existing overview but was **not rendered anywhere** (the old panel only shows an Invoice-only list); the register was tenant-wide, so a connection filter was impossible; `BUSINESS_APPROVED` exists nowhere in the backend; only `ownership`/`direction` persist, with an existing validated, `ERP_MANAGE`-protected, audited (`ERP_OWNERSHIP_UPDATED`) write path.

## 2. What was built
**Backend (additive, no new route, no model, no migration)**
* `services/erpDecisionRegister.service.js`: every item now also returns `capability`, `mechanism`, `scope` (`CONNECTION` for the 4 ownership questions, else `TENANT`) and, for ownership questions, `connections[]` = `{connectionId, connectionName, enabled, ownership, direction}` (no URL, credential reference or header). The register returns `meta`: `statuses: ["REQUIRED","CONFIGURED"]` and `approvalTracking: {implemented:false, reason}`. All Phase 19 keys/values are unchanged.
* `services/erpBusiness.service.js`: passes the connection name to the register and the `meta` through (same endpoint `GET /api/admin/erp-sync/business/overview`, same `ERP_VIEW` + rate-limit guard).

**Frontend (extends the existing dashboard `/admin/sap/dashboard`)**
* `ErpDecisionRegisterPanel.jsx` (new panel under the existing Business capabilities panel), `erpDecisionView.js` (pure view-model).
* Summary tiles (Required / Configured-not-approved / Business approved = "Not tracked" / All), filters (capability, status, ERP connection), 7 areas in the documented order (Payment and Pricing grouped), expandable rows (current safe behaviour, impact while unresolved, how it is recorded, per-connection ownership table), a **separate-dimension readiness table** (what the DMS can do · production verification · decisions open · why limited) and a provider list (SAP OData / Generic REST "mock verified only"; Oracle / Dynamics / SOAP "unsupported — no adapter").
* States: loading, error (with retry and correlation ref), empty, permission-denied (server 403 or missing `ERP_VIEW`). Responsive: no horizontal page scroll at 390 px.
* Fixed explanatory banners: "Recording a decision does not build the capability" and "Approval tracking is not implemented".
* The only action is a link to the **existing** ERP Connections screen to change ownership (disabled for roles without `ERP_MANAGE`; the server still enforces). Nothing is saved from this panel.

## 3. Persistence and approval workflow — NOT implemented (deliberate)
Reasons (details and the full design table in `PHASE20_AUDIT.md` §4): (1) the brief forbids inventing an approver; the system has no business-approver role — `ERP_MANAGE` is a technical permission; (2) none of the 19 non-ownership answers is read by any code, so a stored answer would be advisory text; (3) a new table cannot be verified on MySQL here; (4) the one executable decision (ownership/direction) already has validated, RBAC-protected, audited persistence.
Consequently: no approve/propose button, `BUSINESS_APPROVED` is never rendered (an unrecognised status is shown as "Unrecognised status", never as approved), and the **confirmation-dialog requirement is not applicable** to this panel because it makes no change (ownership changes keep their existing flow on ERP Connections).
Proposed design (keys, scope, roles, audit events, versioning, behaviour when a decision changes during sync) is documented as **design only**. Unresolved dependencies: which role approves per area, two-person review, approval evidence, retention.

## 4. Tests and exact results
| Check | Result |
|---|---|
| Baseline before changes (backend, clean single process) | 22 suites, 753 tests, **753 passed, 0 failed** |
| Final backend `npx jest --runInBand` | **23 suites, 766 tests, 766 passed, 0 failed** (753 + 13 new) |
| New `tests/erp-phase20.test.js` (13) | schema (23 items, keys, statuses), `meta` says approval tracking not implemented and no `BUSINESS_APPROVED`, REQUIRED vs CONFIGURED with per-connection answers, non-ownership questions never CONFIGURED, tenant isolation, no secrets in the register, RBAC over a real Express app (401 / 403 fixed message / 200 for ERP_VIEWER, OPERATOR, ADMIN, SUPER_ADMIN; inactive admin 401; denial audited), no decision/approval write route (POST/PUT/PATCH/DELETE → 404, nothing written), invalid ownership still rejected (400) and valid change still audited, INVOICE/RETURN/DOCUMENT stay BLOCKED and sync start → 409 with no ERP call/job/invoice/return/ledger row even with CONFIGURED ownership, classification + provider verification statuses unchanged |
| Frontend unit tests `node --test src/features/erpIntegration/erpDecisionView.test.mjs` | **10 / 10 passed** (status labels, CONFIGURED never approval, unknown status never approved, counts, filters, grouping, readiness dimensions, providers, panel states, no approve/save helper) |
| Frontend `npm run build` | succeeded |
| `eslint src/features/erpIntegration` | clean (0 errors, 0 warnings) |
| Project-wide `npm run lint` | 33 errors / 10 warnings — **identical to the Phase 19 baseline** (unrelated pre-existing files); none from Phase 20 files |
| Browser render check (headless Chromium, real overview payload generated by the backend, API mocked at the network layer) | ready, connection+capability filter (5 of 23), viewer role (button disabled, no link), server 403, server 500 (with ref), empty register, loading, mobile 390 px: **0 page errors, 0 non-GET requests, no horizontal scroll** |
| Migration up/down | **N/A — no migration added.** MySQL not available; Phase 18 migration remains not verified against MySQL |
Existing assertions: none weakened or removed; no existing test file modified.

**Not verified:** no component-level (React) test runner exists in the project and none was added, so panel states are covered by the pure `panelState` tests plus the browser render check above, which is a manual/scripted check not shipped in the ZIP. The browser check used mocked API responses; it does not prove behaviour against a deployed backend.

## 5. Status table (separate dimensions — do not read as one score)
| Capability | In the DMS | Production-verified | Notes |
|---|---|---|---|
| Product master, Customer master, Distributor master, Pricing, Payment | COMPLETE (code + mock tests only) | No | Pricing manual-price and payment-allocation decisions open |
| Stock | PARTIAL | No | 3 of 4 stock questions REQUIRED; ownership CONFIGURED-only |
| Sales | PARTIAL | No | 2 of 3 REQUIRED |
| Invoice | BLOCKED | No | 6 questions + code change to invoice create path |
| Return | BLOCKED (depends on Invoice) | No | 5 questions |
| Document | BLOCKED | No | 3 questions; no store/scanner/record/retention |
| SAP OData, Generic REST | IMPLEMENTED | Mock verified only; **real ERP NOT RUN** | |
| Oracle REST, Dynamics REST, Generic SOAP | UNSUPPORTED (no adapter) | n/a | |
| Decision register UI | COMPLETE for read-only display | Browser-checked with mocked API only | no approval workflow (NOT IMPLEMENTED) |

## 6. Security and tenant-isolation findings
* Read access is enforced by the server (`requireAdmin` + `ERP_VIEW`, role re-read per request); proven over HTTP. The UI only mirrors it; a server 403 always wins.
* Register is built only from the session tenant's connections; a second tenant's connection name/ownership never appears (tested). Connection ids are not accepted from the client anywhere in this feature.
* No secrets: serialised register contains no credential reference, base URL, token or header (tested).
* No write surface was added; existing ownership write path unchanged (validation, `ERP_MANAGE`, `ERP_OWNERSHIP_UPDATED`).
* No change to authentication, RBAC tables, SSRF policy, rate limiting, redaction or audit immutability; Phase 17 suites pass unchanged.

## 7. Business decisions still awaiting actual business input
All 23 in `PHASE19_DECISION_REGISTER.md` (21 REQUIRED with nothing configured; the 4 ownership questions can only be CONFIGURED, never approved), plus the approval-policy questions in `PHASE20_AUDIT.md` §4.2.

## 8. Known limitations / recommended next phase
* Read-only: answers to 19 questions cannot be recorded anywhere yet. Next phase, **once the business names approver roles and evidence policy**: `erp_business_decisions` (versioned, tenant-scoped, advisory by default), new approval permission, audit events, UI proposal/review, MySQL up/down verification.
* The connection filter only narrows ownership questions; the other 19 are tenant-wide and stay listed (the UI says so).
* The register has no history; "who configured ownership" is only in the ERP audit log.
* Latent Phase 19 §3.10 test-clock risk (`2027-01-01`) is unchanged.
* Real SAP/REST verification, Oracle/Dynamics/SOAP adapters, invoice/return/document sync remain open from Phase 19.

## 9. Files
**Created:** `PHASE20_AUDIT.md`, `PHASE20_DELIVERABLES.md`, `tests/erp-phase20.test.js` (backend); `src/features/erpIntegration/erpDecisionView.js`, `erpDecisionView.test.mjs`, `components/ErpDecisionRegisterPanel.jsx` (frontend).
**Modified:** backend `services/erpDecisionRegister.service.js`, `services/erpBusiness.service.js`; frontend `src/features/erpIntegration/pages/ErpIntegrationDashboardPage.jsx` (one import, one element).
