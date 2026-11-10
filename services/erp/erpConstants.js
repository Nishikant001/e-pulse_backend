// services/erp/erpConstants.js — ONE place that defines every ERP-integration enum (vendor-neutral since Phase 14).
// Provider-specific vocabulary (SAP client, OData, …) lives ONLY inside the provider files, never here or in the sync engine.
const ERP_TYPES = ["SAP_ECC", "SAP_S4HANA", "ORACLE_ERP", "MS_DYNAMICS", "TALLY", "CUSTOM_ERP", "OTHER_ERP"];
const ERP_TYPE_LABELS = { SAP_ECC: "SAP ECC", SAP_S4HANA: "SAP S/4HANA", ORACLE_ERP: "Oracle ERP", MS_DYNAMICS: "Microsoft Dynamics", TALLY: "Tally", CUSTOM_ERP: "Custom ERP", OTHER_ERP: "Other ERP" };
const ENVIRONMENTS = ["PRODUCTION", "SECONDARY", "QUALITY", "DEVELOPMENT", "TEST"];
const STATUSES = ["ACTIVE", "INACTIVE", "ERROR"];
const ODATA_VERSIONS = ["V2", "V4"]; // only read by the OData provider
const DIRECTIONS = ["ERP_TO_DMS", "DMS_TO_ERP", "BIDIRECTIONAL", "DISABLED"]; // Phase 16: DISABLED = the capability is switched off (enabled=false)
// Phase 16 — who owns the data of a capability. NULL = the business has not decided (the sync then returns BUSINESS_DECISION_REQUIRED where a decision is mandatory).
const OWNERSHIPS = ["ERP_OWNED", "DMS_OWNED", "SHARED"];
// Capabilities whose ownership MUST be set explicitly (new in Phase 16, no legacy behaviour to stay compatible with).
const OWNERSHIP_REQUIRED = ["STOCK", "SALES", "INVOICE", "RETURN", "DOCUMENT"];
// Phase 13 stored vendor-named directions; still ACCEPTED on input and mapped to the neutral value.
const LEGACY_DIRECTION_ALIASES = { SAP_TO_DMS: "ERP_TO_DMS", DMS_TO_SAP: "DMS_TO_ERP" };

// Business capabilities (what data), independent of any ERP vendor. defaultDirection is a PROPOSAL needing business confirmation.
const CAPABILITIES = [
  { value: "PRODUCT_MASTER", label: "Product master", defaultDirection: "ERP_TO_DMS" },
  { value: "CUSTOMER_MASTER", label: "Customer master", defaultDirection: "ERP_TO_DMS" },
  { value: "DISTRIBUTOR_MASTER", label: "Distributor master", defaultDirection: "ERP_TO_DMS" },
  { value: "PRICING", label: "Pricing", defaultDirection: "ERP_TO_DMS" },
  { value: "STOCK", label: "Stock", defaultDirection: "BIDIRECTIONAL" },
  { value: "SALES", label: "Sales orders", defaultDirection: "DMS_TO_ERP" },
  { value: "INVOICE", label: "Invoices", defaultDirection: "DMS_TO_ERP" },
  { value: "RETURN", label: "Returns", defaultDirection: "DMS_TO_ERP" },
  { value: "PAYMENT", label: "Payments", defaultDirection: "DMS_TO_ERP" },
  { value: "DOCUMENT", label: "Documents", defaultDirection: "BIDIRECTIONAL" },
];
const CAPABILITY_VALUES = CAPABILITIES.map((c) => c.value);

// Authentication types. Only IMPLEMENTED ones can be saved; the rest are recognised so the UI can say "future".
const AUTH_TYPES = ["BASIC", "BEARER_TOKEN", "API_KEY"];
const AUTH_TYPES_FUTURE = ["OAUTH2", "CLIENT_CERTIFICATE", "CUSTOM"];

// Provider-neutral, normalized error categories (connection tests, providers and the sync engine all use these).
const ERROR_CODES = {
  CONNECTION_ERROR: "CONNECTION_ERROR", AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR", AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
  TIMEOUT: "TIMEOUT", RATE_LIMITED: "RATE_LIMITED", SERVER_ERROR: "SERVER_ERROR", INVALID_RESPONSE: "INVALID_RESPONSE",
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION", INVALID_ENDPOINT: "INVALID_ENDPOINT", REQUEST_REJECTED: "REQUEST_REJECTED",
  MAPPING_ERROR: "MAPPING_ERROR", MAPPING_NOT_CONFIGURED: "MAPPING_NOT_CONFIGURED", VALIDATION_ERROR: "VALIDATION_ERROR",
  PROVIDER_NOT_SUPPORTED: "PROVIDER_NOT_SUPPORTED", CAPABILITY_NOT_SUPPORTED: "CAPABILITY_NOT_SUPPORTED", LIMIT_EXCEEDED: "LIMIT_EXCEEDED", INTERNAL_ERROR: "INTERNAL_ERROR",
  OUTBOUND_SYNC_BLOCKED: "OUTBOUND_SYNC_BLOCKED", // Phase 16: a DMS → ERP write cannot be made safe (no ERP-side idempotency, no write support …)
  BUSINESS_DECISION_REQUIRED: "BUSINESS_DECISION_REQUIRED", // Phase 15: ownership / mapping is not defined by the business — the sync refuses to guess
};
// Phase 13 error names → neutral names (used by the Phase 14 data migration for stored last_test_code values).
const LEGACY_ERROR_CODES = { CONFIGURATION_ERROR: "INVALID_CONFIGURATION", CONNECTION_TIMEOUT: "TIMEOUT", NETWORK_ERROR: "CONNECTION_ERROR", SAP_SERVER_ERROR: "SERVER_ERROR", SAP_REQUEST_REJECTED: "REQUEST_REJECTED" };

// Phase 15 — schedules. The in-process scheduler (see erpScheduler.service.js) cannot safely go below 15 minutes.
const SCHEDULE_FREQUENCIES = [
  { value: "EVERY_15_MIN", label: "Every 15 minutes", minutes: 15 },
  { value: "EVERY_30_MIN", label: "Every 30 minutes", minutes: 30 },
  { value: "HOURLY", label: "Hourly", minutes: 60 },
  { value: "DAILY", label: "Daily", minutes: 1440 },
];
const SCHEDULE_FREQUENCY_VALUES = SCHEDULE_FREQUENCIES.map((f) => f.value);

module.exports = { OWNERSHIPS, OWNERSHIP_REQUIRED, SCHEDULE_FREQUENCIES, SCHEDULE_FREQUENCY_VALUES, ERP_TYPES, ERP_TYPE_LABELS, ENVIRONMENTS, STATUSES, AUTH_TYPES, AUTH_TYPES_FUTURE, ODATA_VERSIONS, DIRECTIONS, LEGACY_DIRECTION_ALIASES, CAPABILITIES, CAPABILITY_VALUES, ERROR_CODES, LEGACY_ERROR_CODES };
