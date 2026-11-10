// services/erp/erpErrors.js — normalized, provider-neutral integration errors.
// Every provider translates native failures into ONE of these categories, so the sync engine, retry logic and UI never care
// which ERP produced them (SAP 401, Oracle 401, Dynamics 401 → AUTHENTICATION_ERROR).
//   message / toPublic(): safe for the browser (fixed wording per code). internal: log-only detail, always redact()ed.
const { ERROR_CODES } = require("./erpConstants");

const PUBLIC_MESSAGES = {
  AUTHENTICATION_ERROR: "The ERP rejected the credentials. Check the credential reference and the account.",
  AUTHORIZATION_ERROR: "The ERP account is not authorised for this request.",
  CONNECTION_ERROR: "The ERP could not be reached. Check the host name, port, network access and TLS certificate.",
  TIMEOUT: "The ERP did not respond in time.",
  RATE_LIMITED: "The ERP is rate limiting requests. Try again later.",
  SERVER_ERROR: "The ERP reported a server error. Try again later or contact the ERP administrator.",
  INVALID_RESPONSE: "The ERP answered, but not with a valid or expected response.",
  INVALID_CONFIGURATION: "The ERP connection is not configured correctly.",
  INVALID_ENDPOINT: "The endpoint was not found. Check the base URL and the endpoint path.",
  REQUEST_REJECTED: "The ERP rejected the request.",
  MAPPING_ERROR: "A value could not be transformed using the configured mapping.",
  MAPPING_NOT_CONFIGURED: "No field mapping is configured for this ERP and capability.",
  VALIDATION_ERROR: "The data is not valid for the DMS.",
  PROVIDER_NOT_SUPPORTED: "No integration provider is available for this ERP connection.",
  CAPABILITY_NOT_SUPPORTED: "This capability cannot be synchronised yet.",
  LIMIT_EXCEEDED: "The synchronisation exceeded a safety limit and was stopped.",
  BUSINESS_DECISION_REQUIRED: "The business has not defined who owns this data or how it maps. The record was not changed.",
  OUTBOUND_SYNC_BLOCKED: "Sending data to the ERP is blocked for this connection. See the reason shown with the record.",
  INTERNAL_ERROR: "Unexpected integration error.",
};
// Typically transient → bounded retry. AUTH / MAPPING / VALIDATION / CONFIGURATION are never retried.
const RETRYABLE = new Set(["TIMEOUT", "RATE_LIMITED", "CONNECTION_ERROR", "SERVER_ERROR"]);

class ErpIntegrationError extends Error {
  /** @param {string} code one of ERROR_CODES  @param {object} [o] { message (secret-free override), httpStatus (the ERP's status), internal (log-only) } */
  constructor(code, o = {}) {
    super(o.message || PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.INTERNAL_ERROR);
    this.name = "ErpIntegrationError";
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.INVALID_CONFIGURATION;
    this.retryable = RETRYABLE.has(this.code);
    this.httpStatus = o.httpStatus || null;
    this.internal = o.internal || null;
  }
  toPublic() { return { code: this.code, message: this.message, retryable: this.retryable, erpHttpStatus: this.httpStatus }; }
}

// Phase 17: one shared implementation (services/erp/redaction.js) so every layer masks the same things.
const { redactString } = require("./redaction");
function redact(value) { return redactString(value, 500); }

// Any thrown value → ErpIntegrationError (callers handle ONE shape). Also the default provider.handleError().
function normalizeError(err) {
  if (err instanceof ErpIntegrationError) return err;
  const detail = redact(err && (err.code || err.name) ? `${err.code || ""} ${err.name || ""} ${err.message || ""}` : err);
  return new ErpIntegrationError(ERROR_CODES.INTERNAL_ERROR, { internal: detail });
}

module.exports = { RETRYABLE, ErpIntegrationError, normalizeError, redact, PUBLIC_MESSAGES };
