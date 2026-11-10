// services/erp/sapProvider.js — SAP OData provider (ECC and S/4HANA share the OData transport). Provider key: SAP_ODATA.
// ALL SAP-specific knowledge lives here: $metadata test, sap-client, OData V2/V4 envelopes, __next links, /Date()/ values.
// The generic sync engine sees only the ErpProvider contract (fetchPage → plain records + opaque cursor).
const { ODataClient, normalizeODataPayload } = require("./odataClient");
const { ErpProvider } = require("./providerContract");
const { ErpIntegrationError } = require("./erpErrors");

const DATE_V2 = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/;
function cleanRecord(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) throw new ErpIntegrationError("INVALID_RESPONSE");
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith("__") || k.startsWith("@odata")) continue;
    if (typeof v === "string") { const m = DATE_V2.exec(v); out[k] = m ? new Date(Number(m[1])).toISOString() : v; }
    else if (v && typeof v === "object" && !Array.isArray(v)) { if (!("__deferred" in v)) out[k] = cleanRecord(v); }
    else out[k] = v;
  }
  return out;
}

class SapODataProvider extends ErpProvider {
  constructor(deps) {
    super(deps);
    const c = deps.connection;
    this._client = new ODataClient({ serviceRoot: `${c.base_url}${c.odata_service_path || ""}`, credentials: deps.credentials, sapClient: c.sap_client, timeoutMs: c.timeout_ms, fetchImpl: deps.fetchImpl, logger: deps.logger });
  }
  get supports() { return { fetch: true, create: true, update: true, delete: false }; }

  // Phase 16 — OData writes. SAP requires an X-CSRF-Token (+ the session cookie it was issued with) on every POST / PATCH. Fetching and replaying
  // it is SAP transport detail, so it lives HERE and nowhere else; the token and cookie are never logged or returned. One refresh on a 403.
  async _csrf(correlationId, force = false) {
    if (this._csrfState && !force) return this._csrfState;
    const res = await this._client.request("GET", "/", { accept: "application/json", correlationId, headers: { "X-CSRF-Token": "Fetch" } }).catch((e) => { if (e && e.code === "INVALID_ENDPOINT") return null; throw e; });
    const token = res && res.headers.get ? res.headers.get("x-csrf-token") : null;
    if (!token || /^required$/i.test(token)) throw new ErpIntegrationError("OUTBOUND_SYNC_BLOCKED", { message: "SAP did not issue a CSRF token for this service, so a write cannot be made safely." });
    const cookie = (res.headers.setCookie || []).map((c) => String(c).split(";")[0]).join("; ");
    this._csrfState = { "X-CSRF-Token": token, ...(cookie ? { Cookie: cookie } : {}) };
    return this._csrfState;
  }
  async _write(method, path, body, idempotencyKey, correlationId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const csrf = await this._csrf(correlationId, attempt > 0);
      try {
        return await this._client.request(method, path, { body, headers: { ...csrf, "Idempotency-Key": idempotencyKey }, correlationId });
      } catch (e) {
        if (attempt === 0 && e && e.code === "AUTHORIZATION_ERROR") { this._csrfState = null; continue; } // token expired → fetch a new one once
        throw e;
      }
    }
    return null;
  }
  _idFrom(res, config) {
    const p = (config.outbound || {}).externalIdPath;
    const j = res.json && (res.json.d || res.json);
    const id = p && j ? cleanRecord(j)[p] : null;
    return id === null || id === undefined ? null : String(id).slice(0, 190);
  }
  async create({ endpointPath, payload, idempotencyKey, config = {}, correlationId }) {
    const res = await this._write("POST", endpointPath, payload, idempotencyKey, correlationId);
    return { externalId: this._idFrom(res, config), httpStatus: res.status };
  }
  async update({ endpointPath, externalId, payload, idempotencyKey, config = {}, correlationId }) {
    const key = String(externalId).replace(/'/g, "''");
    const res = await this._write("PATCH", `${String(endpointPath).replace(/\/+$/, "")}('${encodeURIComponent(key)}')`, payload, idempotencyKey, correlationId);
    return { externalId: String(externalId), httpStatus: res.status };
  }

  async testConnection({ correlationId } = {}) {
    const res = await this._client.request("GET", "/$metadata", { accept: "application/xml", correlationId });
    const edmx = /<(?:\w+:)?Edmx\b[^>]*>/i.exec(res.text.slice(0, 4000));
    if (!edmx) throw new ErpIntegrationError("INVALID_RESPONSE", { httpStatus: res.status });
    const ver = /\bVersion\s*=\s*["']([\d.]+)["']/i.exec(edmx[0]);
    const detected = ver ? (ver[1].startsWith("4") ? "V4" : "V2") : null;
    const warnings = [];
    if (detected && this.connection.odata_version && detected !== this.connection.odata_version) warnings.push(`The service speaks OData ${detected} but the connection is configured as ${this.connection.odata_version}.`);
    return { httpStatus: res.status, latencyMs: res.durationMs, detectedODataVersion: detected, warnings, correlationId: res.correlationId };
  }

  normalizeResponse(json) {
    const p = normalizeODataPayload(json);
    const records = p.results.map(cleanRecord);
    const nextCursor = typeof p.next === "string" && p.next ? p.next : null;
    return { records, nextCursor, hasMore: Boolean(nextCursor), total: p.count };
  }

  async fetchPage({ endpointPath, config = {}, cursor, pageSize, correlationId }) {
    const size = config.pageSize || pageSize;
    const res = cursor
      ? await this._client.request("GET", cursor, { correlationId })
      : await this._client.request("GET", endpointPath, { query: { $format: "json", $top: size, ...(config.select && config.select.length ? { $select: config.select.join(",") } : {}) }, correlationId });
    if (!res.json) throw new ErpIntegrationError("INVALID_RESPONSE", { httpStatus: res.status });
    return { ...this.normalizeResponse(res.json), meta: { httpStatus: res.status, durationMs: res.durationMs, correlationId: res.correlationId } };
  }
}

module.exports = { SapODataProvider, cleanRecord };
