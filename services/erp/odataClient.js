// services/erp/odataClient.js — OData transport: a thin specialisation of the generic HttpClient (no duplicated HTTP logic).
// Adds Basic authentication and the optional `sap-client` query parameter; keeps the OData V2/V4 payload helper. SAP provider only.
const { HttpClient, DEFAULT_TIMEOUT_MS } = require("./httpClient");
const { ErpIntegrationError } = require("./erpErrors");
const { buildAuthHeaders } = require("./authStrategies");

class ODataClient extends HttpClient {
  constructor({ serviceRoot, credentials, sapClient, timeoutMs, fetchImpl, logger } = {}) {
    if (!serviceRoot || !credentials || !credentials.username || !credentials.password) throw new ErpIntegrationError("INVALID_CONFIGURATION");
    super({ root: serviceRoot, authHeaders: buildAuthHeaders("BASIC", credentials), defaultQuery: sapClient ? { "sap-client": sapClient } : {}, timeoutMs, fetchImpl, logger, label: "erp-odata" });
  }
}

function normalizeODataPayload(json) {
  if (!json || typeof json !== "object") throw new ErpIntegrationError("INVALID_RESPONSE");
  if (json.d && typeof json.d === "object") {
    const d = json.d;
    const results = Array.isArray(d.results) ? d.results : Array.isArray(d) ? d : [d];
    return { version: "V2", results, count: d.__count !== undefined ? Number(d.__count) : null, next: d.__next || null };
  }
  if (Array.isArray(json.value)) return { version: "V4", results: json.value, count: json["@odata.count"] !== undefined ? Number(json["@odata.count"]) : null, next: json["@odata.nextLink"] || null };
  throw new ErpIntegrationError("INVALID_RESPONSE");
}

module.exports = { ODataClient, normalizeODataPayload, DEFAULT_TIMEOUT_MS };
