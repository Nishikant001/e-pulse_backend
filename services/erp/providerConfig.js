// services/erp/providerConfig.js — safe path access and strict, allow-listed validation of provider-specific configuration.
// Configuration is DATA: only the keys below are accepted, nothing is evaluated, and nothing here can carry a header, a URL or a
// secret (query keys that look like credentials are refused). This is the SSRF / injection boundary for config.
const { ErpIntegrationError } = require("./erpErrors");

const bad = (m) => new ErpIntegrationError("INVALID_CONFIGURATION", { message: m });
const IDENT = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const PATH = /^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z_$][A-Za-z0-9_$-]*|\.\d+){0,9}$/;
const POISON = new Set(["__proto__", "constructor", "prototype"]);

function validatePath(p, name) {
  if (typeof p !== "string" || p.length > 120 || !PATH.test(p) || p.split(".").some((s) => POISON.has(s))) throw bad(`${name} must be a dotted path such as data.items`);
  return p;
}
function getPath(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  if (!path) return obj;
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (POISON.has(seg) || cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}
const only = (obj, allowed, where) => {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== "object" || Array.isArray(obj)) throw bad(`${where} must be an object`);
  Object.keys(obj).forEach((k) => { if (!allowed.includes(k)) throw bad(`${where}: unknown setting "${k}"`); });
  return obj;
};
const intIn = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be a whole number between ${lo} and ${hi}`); return n; };
const ident = (v, name) => { if (typeof v !== "string" || !IDENT.test(v)) throw bad(`${name} must be letters/digits/_/./- only`); return v; };

const PAGINATION_TYPES = ["NONE", "PAGE_NUMBER", "OFFSET_LIMIT", "NEXT_URL", "CURSOR"];
const PAG_KEYS = ["type", "pageSize", "pageParam", "sizeParam", "offsetParam", "limitParam", "cursorParam", "startPage", "nextPath", "cursorPath", "totalPath"];
const SECRETISH = /(key|token|secret|passw|auth|credential|signature)/i;

// Phase 16 — outbound (DMS → ERP) settings of a capability. `idempotencySupported` is the admin's ATTESTATION that the ERP endpoint honours the
// idempotency key we send; without it every outbound write is refused (OUTBOUND_SYNC_BLOCKED). Nothing here can carry a URL, header or secret.
function validateOutbound(o, { rest }) {
  const x = only(o, rest ? ["idempotencySupported", "externalIdPath", "updateMethod"] : ["idempotencySupported", "externalIdPath"], "outbound");
  const out = {};
  if (x.idempotencySupported !== undefined) { if (typeof x.idempotencySupported !== "boolean") throw bad("outbound.idempotencySupported must be true or false"); out.idempotencySupported = x.idempotencySupported; }
  if (x.externalIdPath !== undefined && x.externalIdPath !== "") out.externalIdPath = rest ? validatePath(x.externalIdPath, "outbound.externalIdPath") : ident(x.externalIdPath, "outbound.externalIdPath");
  if (rest && x.updateMethod !== undefined && x.updateMethod !== "") { const m = String(x.updateMethod).toUpperCase(); if (!["PUT", "PATCH"].includes(m)) throw bad("outbound.updateMethod must be PUT or PATCH"); out.updateMethod = m; }
  return out;
}
function validateRestCapabilityConfig(cfg) {
  const c = only(cfg, ["responsePath", "pagination", "query", "outbound"], "config");
  const out = {};
  if (c.outbound !== undefined) out.outbound = validateOutbound(c.outbound, { rest: true });
  if (c.responsePath !== undefined && c.responsePath !== "") out.responsePath = validatePath(c.responsePath, "responsePath");
  if (c.pagination !== undefined) {
    const p = only(c.pagination, PAG_KEYS, "pagination");
    const type = String(p.type || "NONE").toUpperCase();
    if (!PAGINATION_TYPES.includes(type)) throw bad(`pagination.type must be one of: ${PAGINATION_TYPES.join(", ")}`);
    const o = { type };
    if (p.pageSize !== undefined) o.pageSize = intIn(p.pageSize, 1, 1000, "pagination.pageSize");
    ["pageParam", "sizeParam", "offsetParam", "limitParam", "cursorParam"].forEach((k) => { if (p[k] !== undefined && p[k] !== "") o[k] = ident(p[k], `pagination.${k}`); });
    if (p.startPage !== undefined) o.startPage = intIn(p.startPage, 0, 1, "pagination.startPage");
    ["nextPath", "cursorPath", "totalPath"].forEach((k) => { if (p[k] !== undefined && p[k] !== "") o[k] = validatePath(p[k], `pagination.${k}`); });
    out.pagination = o;
  }
  if (c.query !== undefined) {
    const q = c.query;
    if (!q || typeof q !== "object" || Array.isArray(q) || Object.keys(q).length > 10) throw bad("query must be an object with at most 10 entries");
    out.query = {};
    for (const [k, v] of Object.entries(q)) {
      ident(k, "query name");
      if (SECRETISH.test(k)) throw bad("Credentials must not be sent as query parameters; use the connection's authentication settings.");
      if (typeof v !== "string" || v.length > 100 || /[\r\n]/.test(v)) throw bad(`query value for "${k}" must be short text`);
      out.query[k] = v;
    }
  }
  return out;
}
function validateODataCapabilityConfig(cfg) {
  const c = only(cfg, ["select", "pageSize", "outbound"], "config");
  const out = {};
  if (c.outbound !== undefined) out.outbound = validateOutbound(c.outbound, { rest: false });
  if (c.select !== undefined) {
    if (!Array.isArray(c.select) || c.select.length > 50) throw bad("select must be a list of at most 50 field names");
    out.select = c.select.map((s) => { if (typeof s !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(s)) throw bad("select entries must be plain field names"); return s; });
  }
  if (c.pageSize !== undefined) out.pageSize = intIn(c.pageSize, 1, 1000, "pageSize");
  return out;
}
function validateRestConnectionConfig(cfg) {
  const c = only(cfg, ["testPath"], "config");
  const out = {};
  if (c.testPath !== undefined && c.testPath !== "") {
    const p = String(c.testPath);
    if (!p.startsWith("/") || /[?#\\\s]/.test(p) || p.includes("..") || p.includes("//") || p.length > 255) throw bad("testPath must be a path starting with '/'");
    out.testPath = p;
  }
  return out;
}
const validateNoConnectionConfig = (cfg) => { only(cfg, [], "config"); return {}; };

module.exports = { getPath, validatePath, validateRestCapabilityConfig, validateODataCapabilityConfig, validateRestConnectionConfig, validateNoConnectionConfig, PAGINATION_TYPES };
