// services/erp/authStrategies.js — authentication belongs to the connection/provider layer, never to the sync engine.
// A strategy turns server-side secrets into request headers; secrets are never logged, returned or attached to errors.
//   IMPLEMENTED: BASIC, BEARER_TOKEN, API_KEY     FUTURE (recognised, refused): OAUTH2, CLIENT_CERTIFICATE, CUSTOM
const { ErpIntegrationError } = require("./erpErrors");
const { AUTH_TYPES_FUTURE } = require("./erpConstants");

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "cookie", "set-cookie", "authorization", "proxy-authorization", "accept", "x-correlation-id", "upgrade", "te", "trailer", "expect"]);
const bad = (m) => new ErpIntegrationError("INVALID_CONFIGURATION", { message: m });
const clean = (v, what) => { if (typeof v !== "string" || !v || /[\r\n\0]/.test(v)) throw bad(`The ${what} is missing or malformed.`); return v; };

// Header an API key is sent in: admin-configurable but only a plain, non-reserved name — no arbitrary headers.
function validateHeaderName(name) {
  if (typeof name !== "string" || !HEADER_NAME.test(name)) throw bad("API key header name must be letters, digits and '-' only.");
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw bad("That header name is reserved and cannot be used for an API key.");
  return name;
}

const STRATEGIES = {
  BASIC: { implemented: true, secretFields: ["username", "password"], headers: (c) => ({ Authorization: "Basic " + Buffer.from(`${clean(c.username, "user name")}:${clean(c.password, "password")}`, "utf8").toString("base64") }) },
  BEARER_TOKEN: { implemented: true, secretFields: ["token"], headers: (c) => ({ Authorization: `Bearer ${clean(c.token, "token")}` }) },
  API_KEY: { implemented: true, secretFields: ["apiKey"], headers: (c, o) => ({ [validateHeaderName(o.headerName || "X-API-Key")]: clean(c.apiKey, "API key") }) },
};

const isImplemented = (t) => Boolean(STRATEGIES[t] && STRATEGIES[t].implemented);
const secretFieldsFor = (t) => (STRATEGIES[t] ? STRATEGIES[t].secretFields : []);

function buildAuthHeaders(authType, credentials, options = {}) {
  const s = STRATEGIES[authType];
  if (!s || !s.implemented) throw bad(AUTH_TYPES_FUTURE.includes(authType) ? `Authentication type ${authType} is planned but not available yet.` : "Unknown authentication type.");
  return s.headers(credentials || {}, options);
}

module.exports = { buildAuthHeaders, isImplemented, secretFieldsFor, validateHeaderName, STRATEGIES };
