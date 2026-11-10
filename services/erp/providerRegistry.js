// services/erp/providerRegistry.js — the PROVIDER REGISTRY. erp_type says WHAT the ERP is; the provider says HOW we talk to it.
// Each connection resolves to exactly one provider; there is NEVER a silent fallback to another one.
//   IMPLEMENTED      adapter exists and is covered by tests   → SAP_ODATA, GENERIC_REST
//   FOUNDATION_ONLY  registered + described, NO adapter yet   → ORACLE_REST, DYNAMICS_REST  (→ PROVIDER_NOT_SUPPORTED)
//   FUTURE           planned protocol, nothing built           → GENERIC_SOAP
// An Oracle or Dynamics system that exposes a plain JSON API can use GENERIC_REST today.
// Adding an ERP: write an ErpProvider adapter → add one entry here (status IMPLEMENTED, create: deps => new Adapter(deps)).
const { SapODataProvider } = require("./sapProvider");
const { GenericRestProvider } = require("./genericRestProvider");
const cfg = require("./providerConfig");
const { ErpIntegrationError } = require("./erpErrors");

const REST_AUTH = ["BASIC", "BEARER_TOKEN", "API_KEY"];
// Phase 18 — what each provider REALLY provides (declared next to the code that does it; a registered class alone claims nothing). DELETE is not
// implemented by any provider. OAUTH is not implemented (AUTH_TYPES_FUTURE). `verification` is the honest test status: mock = covered by tests that use a
// MOCK transport; real = verified against a real ERP system. No real ERP has been available, so `real` is false everywhere.
const PROVIDER_FEATURES = ["READ", "CREATE", "UPDATE", "DELETE", "PAGINATION", "IDEMPOTENCY", "OAUTH", "BASIC_AUTH", "BEARER_AUTH", "API_KEY_AUTH", "ODATA", "REST"];
const PROVIDERS = {
  SAP_ODATA: { key: "SAP_ODATA", label: "SAP OData", protocol: "ODATA", status: "IMPLEMENTED", writeCapable: true, authTypes: ["BASIC"], pagination: ["ODATA_NEXT_LINK"], features: ["READ", "CREATE", "UPDATE", "PAGINATION", "IDEMPOTENCY", "BASIC_AUTH", "ODATA"], verification: { mock: true, real: false }, create: (d) => new SapODataProvider(d), validateCapabilityConfig: cfg.validateODataCapabilityConfig, validateConnectionConfig: cfg.validateNoConnectionConfig },
  GENERIC_REST: { key: "GENERIC_REST", label: "Generic REST", protocol: "REST", status: "IMPLEMENTED", writeCapable: true, authTypes: REST_AUTH, pagination: ["NONE", "PAGE_NUMBER", "OFFSET_LIMIT", "NEXT_URL", "CURSOR"], features: ["READ", "CREATE", "UPDATE", "PAGINATION", "IDEMPOTENCY", "BASIC_AUTH", "BEARER_AUTH", "API_KEY_AUTH", "REST"], verification: { mock: true, real: false }, create: (d) => new GenericRestProvider(d), validateCapabilityConfig: cfg.validateRestCapabilityConfig, validateConnectionConfig: cfg.validateRestConnectionConfig },
  ORACLE_REST: { key: "ORACLE_REST", label: "Oracle REST", protocol: "REST", status: "FOUNDATION_ONLY", authTypes: REST_AUTH, pagination: [], features: [], verification: { mock: false, real: false }, create: null },
  DYNAMICS_REST: { key: "DYNAMICS_REST", label: "Dynamics REST", protocol: "REST", status: "FOUNDATION_ONLY", authTypes: REST_AUTH, pagination: [], features: [], verification: { mock: false, real: false }, create: null },
  GENERIC_SOAP: { key: "GENERIC_SOAP", label: "Generic SOAP", protocol: "SOAP", status: "FUTURE", authTypes: ["BASIC"], pagination: [], features: [], verification: { mock: false, real: false }, create: null },
};
const notYet = (c) => {
  if (c && Object.keys(c).length) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "This provider is not implemented yet, so it cannot be configured beyond the basic connection." });
  return {};
};
Object.values(PROVIDERS).filter((p) => !p.create).forEach((p) => { p.validateCapabilityConfig = notYet; p.validateConnectionConfig = notYet; });

// Default provider per ERP type. null = the admin must choose (no guessing, no SAP fallback).
const DEFAULT_PROVIDER_FOR_ERP_TYPE = { SAP_ECC: "SAP_ODATA", SAP_S4HANA: "SAP_ODATA", ORACLE_ERP: "ORACLE_REST", MS_DYNAMICS: "DYNAMICS_REST", CUSTOM_ERP: "GENERIC_REST", TALLY: null, OTHER_ERP: null };

const getDescriptor = (key) => (key && Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null);
const resolveProviderKey = (connection) => connection.provider || DEFAULT_PROVIDER_FOR_ERP_TYPE[connection.erp_type] || null;
const featuresOf = (p) => (p && p.status === "IMPLEMENTED" ? [...(p.features || [])] : []); // a provider that is not implemented provides nothing, whatever it lists
const hasFeature = (p, f) => featuresOf(p).includes(f);
const verificationOf = (p) => ({ mock: Boolean(p && p.status === "IMPLEMENTED" && p.verification && p.verification.mock), real: Boolean(p && p.status === "IMPLEMENTED" && p.verification && p.verification.real) });
const publicDescriptor = (p) => ({ key: p.key, label: p.label, protocol: p.protocol, status: p.status, writeCapable: Boolean(p.writeCapable), authTypes: p.authTypes, pagination: p.pagination, features: featuresOf(p), unsupportedFeatures: PROVIDER_FEATURES.filter((f) => !featuresOf(p).includes(f)), verification: verificationOf(p) });
const listProviders = () => Object.values(PROVIDERS).map(publicDescriptor);

module.exports = { PROVIDER_FEATURES, featuresOf, hasFeature, verificationOf, PROVIDERS, DEFAULT_PROVIDER_FOR_ERP_TYPE, getDescriptor, resolveProviderKey, listProviders, publicDescriptor };
