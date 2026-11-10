// services/erp/providerContract.js — the ERP PROVIDER INTERFACE every adapter implements. The sync engine talks ONLY to this
// contract (never to a vendor, protocol or HTTP library): adding an ERP = implement a provider + register it.
//   connect() · testConnection() · fetchPage({endpointPath, config, cursor, pageSize, correlationId}) → {records, nextCursor, hasMore, total?}
//   Phase 16 WRITE contract (DMS → ERP):  create({endpointPath, payload, idempotencyKey, config, correlationId}) → {externalId, httpStatus}
//                                         update({endpointPath, externalId, payload, idempotencyKey, config, correlationId}) → {externalId, httpStatus}
//   A provider that cannot write keeps the base behaviour (PROVIDER_NOT_SUPPORTED — never a fake success). CSRF tokens, session cookies and
//   vendor URL shapes stay INSIDE the provider; the outbound service only passes a plain payload and an idempotency key.
//   delete: not implemented anywhere.  normalizeResponse(raw) · handleError(err)
const { ErpIntegrationError, normalizeError } = require("./erpErrors");

class ErpProvider {
  constructor({ connection, capabilities, credentials, fetchImpl, logger } = {}) {
    this.connection = connection;
    this.capabilities = capabilities || [];
    this._credentials = credentials; // server-side only; never exposed
    this._fetchImpl = fetchImpl;
    this._logger = logger;
  }
  get supports() { return { fetch: false, create: false, update: false, delete: false }; }
  async connect() { return true; }
  async testConnection() { throw this._unsupported("testConnection"); }
  async fetchPage() { throw this._unsupported("fetch"); }
  async create() { throw this._unsupported("create"); }
  async update() { throw this._unsupported("update"); }
  async delete() { throw this._unsupported("delete"); }
  normalizeResponse() { throw this._unsupported("normalizeResponse"); }
  handleError(err) { return normalizeError(err); }
  _unsupported(op) { return new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: `This provider does not support the "${op}" operation.` }); }
}

const REQUIRED_METHODS = ["connect", "testConnection", "fetchPage", "normalizeResponse", "handleError"];
const implementsContract = (p) => Boolean(p) && REQUIRED_METHODS.every((m) => typeof p[m] === "function") && typeof p.supports === "object";

module.exports = { ErpProvider, implementsContract, REQUIRED_METHODS };
