// services/erpConfigValidation.service.js — Phase 17. Cross-field validation of an ERP connection + its capabilities, and the CONNECTION HEALTH rule.
// Pure functions (no DB, no network): the same code runs when a connection is saved (errors block, warnings are returned) and when the
// readiness check inspects the stored connections. Nothing here guesses a missing business mapping — it only reports it.
const C = require("./erp/erpConstants");
const registry = require("./erp/providerRegistry");

const OUTBOUND_DIRS = ["DMS_TO_ERP", "BIDIRECTIONAL"];
const INBOUND_DIRS = ["ERP_TO_DMS", "BIDIRECTIONAL"];
const providerOf = (conn) => { const key = registry.resolveProviderKey(conn); return { key, desc: key ? registry.getDescriptor(key) : null }; };

/**
 * @param {object} conn  { provider, erp_type, environment, base_url, credential_ref }
 * @param {object[]} caps [{ capability, direction, enabled, endpoint_path|endpointPath, config, ownership }]
 * @returns {{errors:{field:string,message:string,capability?:string}[], warnings:{code:string,message:string,capability?:string}[]}}
 */
function validateConfiguration(conn, caps = []) {
  const errors = []; const warnings = [];
  const { key, desc } = providerOf(conn);
  if (!key) warnings.push({ code: "NO_PROVIDER", message: "No provider is selected, so nothing can be synchronised until one is chosen." });
  else if (desc && desc.status !== "IMPLEMENTED") warnings.push({ code: "PROVIDER_NOT_IMPLEMENTED", message: `The ${desc.label} provider is not implemented yet; this connection cannot synchronise.` });
  if (conn.environment === "PRODUCTION" && /^http:\/\//i.test(conn.base_url || "")) warnings.push({ code: "PRODUCTION_OVER_HTTP", message: "A PRODUCTION connection uses plain http://. Credentials would travel unencrypted." });
  const writable = Boolean(desc && desc.status === "IMPLEMENTED" && desc.writeCapable);

  for (const c of caps) {
    const enabled = c.enabled !== false && c.direction !== "DISABLED";
    const endpoint = c.endpoint_path !== undefined ? c.endpoint_path : c.endpointPath;
    const outbound = OUTBOUND_DIRS.includes(c.direction);
    const inbound = INBOUND_DIRS.includes(c.direction);
    const attested = Boolean(((c.config || {}).outbound || {}).idempotencySupported);
    const w = (code, message) => warnings.push({ code, message, capability: c.capability });
    const e = (field, message) => errors.push({ field, message, capability: c.capability });
    if (!enabled) continue;

    if (outbound && key && desc && !writable) e("direction", `${c.capability}: the ${desc.label} provider cannot send data to the ERP, so a DMS → ERP direction is not allowed. Choose ERP → DMS or disable the capability.`);
    if (attested && !writable) e("config", `${c.capability}: outbound idempotency was confirmed, but the selected provider cannot write to the ERP.`);
    // A contradiction is a WARNING, not an error: since Phase 16 the runtime gate answers BUSINESS_DECISION_REQUIRED for it (documented behaviour), and
    // the business may legitimately record the ownership decision before it changes the direction.
    if (c.ownership && ((c.direction === "ERP_TO_DMS" && c.ownership === "DMS_OWNED") || (c.direction === "DMS_TO_ERP" && c.ownership === "ERP_OWNED"))) {
      w("OWNERSHIP_DIRECTION_CONFLICT", `${c.capability}: ownership ${c.ownership} contradicts direction ${c.direction}, so it cannot run (BUSINESS_DECISION_REQUIRED). Use SHARED, or change one of them.`);
    }
    if (!c.ownership && C.OWNERSHIP_REQUIRED.includes(c.capability)) w("OWNERSHIP_UNDECIDED", `${c.capability}: the business has not decided who owns this data, so it cannot run (BUSINESS_DECISION_REQUIRED).`);
    if (inbound && !endpoint) w("ENDPOINT_MISSING", `${c.capability}: no endpoint is configured, so nothing can be read.`);
    if (outbound && !endpoint) w("ENDPOINT_MISSING", `${c.capability}: no endpoint is configured, so nothing can be sent.`);
    if (outbound && !attested) w("OUTBOUND_IDEMPOTENCY_NOT_CONFIRMED", `${c.capability}: ERP-side idempotency is not confirmed (outbound.idempotencySupported), so outbound writes are blocked (OUTBOUND_SYNC_BLOCKED).`);
    if (["INVOICE", "RETURN", "DOCUMENT"].includes(c.capability)) w("CAPABILITY_BLOCKED", `${c.capability}: this capability is blocked until its business decisions are approved; it will not synchronise.`);
  }
  return { errors, warnings };
}

/**
 * CONNECTION HEALTH — never CONNECTED just because configuration exists.
 *   DISABLED    the connection is INACTIVE
 *   NOT_TESTED  no test since the last connectivity change
 *   FAILED      the last real test failed
 *   DEGRADED    the last test passed BUT: slow (> 60 % of the timeout), older than ERP_TEST_STALE_HOURS (default 24), credentials no longer
 *               resolvable, or the latest sync of this ERP failed
 *   CONNECTED   the last real test passed, recently, with credentials present, and no failed latest sync
 * `state` (REACHABLE | FAILED | NOT_TESTED) is the Phase 13 field, kept for existing clients.
 */
function computeConnectionHealth(c, { credentialStatus, lastSync, now = new Date() } = {}) {
  const tested = Boolean(c.last_test_at);
  const staleHours = Math.min(Math.max(Number(process.env.ERP_TEST_STALE_HOURS) || 24, 1), 720);
  const base = { testedAt: c.last_test_at || null, code: c.last_test_code || null, latencyMs: c.last_test_latency_ms ?? null };
  if (c.status === "INACTIVE") return { status: "DISABLED", reason: "The connection is deactivated.", ...base };
  if (!tested) return { status: "NOT_TESTED", reason: "The connection has not been tested.", ...base };
  if (!c.last_test_ok) return { status: "FAILED", reason: c.last_test_message || "The last connection test failed.", ...base };
  const reasons = [];
  if (credentialStatus && credentialStatus !== "RESOLVED") reasons.push("The server can no longer resolve this connection's credentials.");
  if (c.last_test_latency_ms && c.timeout_ms && c.last_test_latency_ms > c.timeout_ms * 0.6) reasons.push("The ERP answered slowly in the last test.");
  if (now.getTime() - new Date(c.last_test_at).getTime() > staleHours * 3600000) reasons.push(`The last successful test is older than ${staleHours} hours.`);
  if (lastSync && lastSync.status === "FAILED") reasons.push("The latest synchronisation failed.");
  if (reasons.length) return { status: "DEGRADED", reason: reasons.join(" "), ...base };
  return { status: "CONNECTED", reason: "The last connection test passed.", ...base };
}

module.exports = { validateConfiguration, computeConnectionHealth, OUTBOUND_DIRS, INBOUND_DIRS };
