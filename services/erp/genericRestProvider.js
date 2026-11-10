// services/erp/genericRestProvider.js — Generic REST provider (key: GENERIC_REST). Read-only (fetch) in Phase 14.
// Any ERP exposing JSON over HTTP(S): base URL + per-capability endpoint, response path, pagination, static query params — all
// admin-configured DATA validated by providerConfig.js. No custom headers, no custom URLs, no scripts: the only headers sent are
// the auth strategy's, so a user cannot make the server call arbitrary hosts or inject headers. Next links stay on the same origin.
const { HttpClient } = require("./httpClient");
const { buildAuthHeaders } = require("./authStrategies");
const { ErpProvider } = require("./providerContract");
const { ErpIntegrationError } = require("./erpErrors");
const { getPath } = require("./providerConfig");
const { buildPageRequest, readPageResult } = require("./restPagination");

class GenericRestProvider extends ErpProvider {
  constructor(deps) {
    super(deps);
    const c = deps.connection;
    this._client = new HttpClient({
      root: `${c.base_url}${c.odata_service_path || ""}`, // "service path" = API base path for REST
      authHeaders: buildAuthHeaders(c.auth_type, deps.credentials, { headerName: c.auth_header_name }),
      timeoutMs: c.timeout_ms, fetchImpl: deps.fetchImpl, logger: deps.logger, label: "erp-rest",
    });
  }
  get supports() { return { fetch: true, create: true, update: true, delete: false }; }

  // Phase 16 — outbound. POST to the capability endpoint; update = PUT or PATCH (capability config outbound.updateMethod, default PATCH) on
  // <endpoint>/<ERP id>. The idempotency key travels in the "Idempotency-Key" header so a retried request cannot create a second ERP document.
  async create({ endpointPath, payload, idempotencyKey, config = {}, correlationId }) {
    const res = await this._client.request("POST", endpointPath, { body: payload, headers: { "Idempotency-Key": idempotencyKey }, correlationId });
    return this._writeResult(res, config);
  }
  async update({ endpointPath, externalId, payload, idempotencyKey, config = {}, correlationId }) {
    const method = ((config.outbound || {}).updateMethod || "PATCH").toUpperCase();
    const path = `${String(endpointPath).replace(/\/+$/, "")}/${encodeURIComponent(String(externalId))}`;
    const res = await this._client.request(method, path, { body: payload, headers: { "Idempotency-Key": idempotencyKey }, correlationId });
    return { ...this._writeResult(res, config), externalId: String(externalId) };
  }
  _writeResult(res, config) {
    const p = (config.outbound || {}).externalIdPath;
    let id = p && res.json ? getPath(res.json, p) : null;
    if ((id === null || id === undefined) && res.headers.get) { const loc = res.headers.get("location"); if (loc) id = String(loc).split("?")[0].split("/").filter(Boolean).pop(); }
    return { externalId: id === null || id === undefined ? null : String(id).slice(0, 190), httpStatus: res.status };
  }

  async testConnection({ correlationId, capabilities = this.capabilities } = {}) {
    const testPath = (this.connection.config || {}).testPath;
    if (testPath) {
      const res = await this._client.request("GET", testPath, { correlationId });
      if (res.json === null) throw new ErpIntegrationError("INVALID_RESPONSE", { httpStatus: res.status });
      return { httpStatus: res.status, latencyMs: res.durationMs, warnings: [], correlationId: res.correlationId };
    }
    const cap = capabilities.find((x) => x.enabled && x.endpoint_path);
    if (!cap) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "Set a test path, or configure an endpoint for at least one enabled capability, so the connection can be tested." });
    const page = await this.fetchPage({ endpointPath: cap.endpoint_path, config: cap.config || {}, cursor: null, pageSize: 1, correlationId });
    return { httpStatus: page.meta.httpStatus, latencyMs: page.meta.durationMs, warnings: [], correlationId: page.meta.correlationId };
  }

  normalizeResponse(json, config = {}) {
    const raw = config.responsePath ? getPath(json, config.responsePath) : json;
    if (!Array.isArray(raw)) throw new ErpIntegrationError("INVALID_RESPONSE", { message: config.responsePath ? "The response does not contain a list at the configured response path." : "The response is not a list. Configure a response path." });
    raw.forEach((r) => { if (r === null || typeof r !== "object" || Array.isArray(r)) throw new ErpIntegrationError("INVALID_RESPONSE"); });
    return raw;
  }

  async fetchPage({ endpointPath, config = {}, cursor, pageSize, correlationId }) {
    const pg = config.pagination || { type: "NONE" };
    const size = pg.pageSize || pageSize;
    const req = buildPageRequest(pg, cursor, size);
    const res = await this._client.request("GET", req.url || endpointPath, { query: req.url ? {} : { ...(config.query || {}), ...req.query }, correlationId });
    if (res.json === null) throw new ErpIntegrationError("INVALID_RESPONSE", { httpStatus: res.status });
    const records = this.normalizeResponse(res.json, config);
    const next = readPageResult(pg, res.json, records, cursor, size);
    return { records, nextCursor: next.nextCursor, hasMore: next.hasMore, total: next.total, meta: { httpStatus: res.status, durationMs: res.durationMs, correlationId: res.correlationId } };
  }
}

module.exports = { GenericRestProvider };
