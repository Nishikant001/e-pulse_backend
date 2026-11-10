// services/erp/httpClient.js — generic, vendor-neutral HTTP transport for ERP providers (extracted from the Phase 13 OData
// client so SAP OData and every REST provider share ONE implementation of URL building, auth headers, timeouts,
// HTTP→normalized-error mapping, same-origin protection, body cap and secret-free logging with a correlation id.
// Redirects are NOT followed. A "next page" URL from an ERP is followed only on the SAME ORIGIN as the configured base URL.
const crypto = require("crypto");
const { ErpIntegrationError, redact } = require("./erpErrors");

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class HttpClient {
  constructor({ root, authHeaders, defaultQuery, timeoutMs, fetchImpl, logger, label } = {}) {
    if (!root || !authHeaders || !Object.keys(authHeaders).length) throw new ErpIntegrationError("INVALID_CONFIGURATION");
    this._root = root.replace(/\/+$/, "");
    this._origin = new URL(this._root).origin;
    this._auth = authHeaders;
    this._defaultQuery = defaultQuery || {};
    this._timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a)); // resolved lazily so tests can mock global.fetch
    this._log = logger || ((line) => console.info(line));
    this._label = label || "erp-http";
  }

  resolve(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      let u;
      try { u = new URL(pathOrUrl); } catch { throw new ErpIntegrationError("INVALID_RESPONSE", { message: "The ERP returned a malformed link." }); }
      if (u.origin !== this._origin) throw new ErpIntegrationError("INVALID_RESPONSE", { message: "The ERP returned a link to a different host; it was not followed." });
      return u;
    }
    return new URL(this._root + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`));
  }

  async request(method, pathOrUrl, { query = {}, accept = "application/json", correlationId = crypto.randomUUID(), body, headers: extra = {} } = {}) {
    if (!["GET", "POST", "PUT", "PATCH"].includes(method)) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "Unsupported HTTP method." });
    const url = this.resolve(pathOrUrl);
    Object.entries(this._defaultQuery).forEach(([k, v]) => { if (!url.searchParams.has(k)) url.searchParams.set(k, String(v)); });
    Object.entries(query).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, String(v)));

    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);
    let res;
    try {
      const hasBody = body !== undefined && body !== null;
      // Provider-supplied headers (idempotency key, CSRF token, session cookie) can never replace the authentication or fixed headers.
      res = await this._fetch(url.toString(), { method, redirect: "manual", signal: ctrl.signal, headers: { ...extra, ...this._auth, Accept: accept, "X-Correlation-ID": correlationId, ...(hasBody ? { "Content-Type": "application/json" } : {}) }, ...(hasBody ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
      this._trace(correlationId, method, url, aborted ? "TIMEOUT" : "NETWORK", Date.now() - started, redact(err && (err.cause && err.cause.code ? err.cause.code : err.message)));
      throw new ErpIntegrationError(aborted ? "TIMEOUT" : "CONNECTION_ERROR", { internal: redact(err && err.cause && err.cause.code) });
    }

    let text = "";
    try { text = (await res.text()).slice(0, MAX_BODY_BYTES); } catch { text = ""; } finally { clearTimeout(timer); }
    const durationMs = Date.now() - started;
    this._trace(correlationId, method, url, res.status, durationMs);

    const s = res.status;
    if (s >= 300 && s < 400) throw new ErpIntegrationError("INVALID_ENDPOINT", { httpStatus: s, message: "The endpoint redirected the request. Check the base URL and the endpoint path." });
    if (s === 401) throw new ErpIntegrationError("AUTHENTICATION_ERROR", { httpStatus: s });
    if (s === 403) throw new ErpIntegrationError("AUTHORIZATION_ERROR", { httpStatus: s });
    if (s === 404) throw new ErpIntegrationError("INVALID_ENDPOINT", { httpStatus: s });
    if (s === 408) throw new ErpIntegrationError("TIMEOUT", { httpStatus: s });
    if (s === 429) throw new ErpIntegrationError("RATE_LIMITED", { httpStatus: s });
    if (s >= 500) throw new ErpIntegrationError("SERVER_ERROR", { httpStatus: s });
    if (s >= 400) throw new ErpIntegrationError("REQUEST_REJECTED", { httpStatus: s });

    const contentType = (res.headers && typeof res.headers.get === "function" && res.headers.get("content-type")) || "";
    let json = null;
    if (/json/i.test(contentType)) {
      try { json = JSON.parse(text); } catch { throw new ErpIntegrationError("INVALID_RESPONSE", { httpStatus: s }); }
    }
    const hget = (n) => (res.headers && typeof res.headers.get === "function" ? res.headers.get(n) : null);
    const setCookie = res.headers && typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    return { status: s, headers: { contentType, get: hget, setCookie }, text, json, correlationId, durationMs };
  }

  _trace(cid, method, url, outcome, ms, extra) { // host + path only — never the query string, never headers
    this._log(`[${this._label}] cid=${cid} ${method} ${url.host}${url.pathname} -> ${outcome} ${ms}ms${extra ? ` (${extra})` : ""}`);
  }
}

module.exports = { HttpClient, DEFAULT_TIMEOUT_MS };
