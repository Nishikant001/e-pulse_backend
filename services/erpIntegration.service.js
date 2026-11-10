// services/erpIntegration.service.js — ERP connection master, default ERP, capabilities, status and the real connection test.
// Vendor-neutral since Phase 14: a connection has an erp_type (WHAT) and a provider (HOW); SAP is one provider among others.
// Controllers call ONLY this file; this file calls the provider layer for anything that touches an ERP. Every function takes
// `tenantKey` and filters on it — a record of another tenant is indistinguishable from a missing one (404).
const crypto = require("crypto");
const C = require("./erp/erpConstants");
const { ErpApiError } = require("./erp/erpApiError");
const { ErpIntegrationError, normalizeError, redact } = require("./erp/erpErrors");
const { credentialStatus, isValidRef } = require("./erp/secretResolver");
const { validateBaseUrl, validateServicePath } = require("./erp/urlValidator");
const { buildProvider } = require("./erp/connectionManager");
const { validateHeaderName, isImplemented } = require("./erp/authStrategies");
const registry = require("./erp/providerRegistry");
const { redactString, isSecretKey } = require("./erp/redaction");
const reqctx = require("../utils/requestContext");
const V = require("../utils/erpValidate");
const { validateConfiguration, computeConnectionHealth } = require("./erpConfigValidation.service");
const { describeTargets, getTarget, getUnsupported } = require("./erp/sync/targets");

const bad = (message, details) => new ErpApiError(400, "VALIDATION_FAILED", message, details);

// Audit: every event goes to the server log (Phase 13 convention) AND, since Phase 16, to the persistent append-only table (erpAudit.service).
// Phase 17: the log line is redacted, and carries the request's correlation id when the event happens inside an HTTP request.
function audit(event, adminId, tenantKey, conn, extra = "") {
  require("./erpAudit.service").fromLogLine(require("../models"), event, adminId, tenantKey, conn, extra);
  const cid = reqctx.currentCorrelationId();
  console.info(redactString(`[erp-audit] event=${event} admin=${adminId || "-"} tenant=${tenantKey} connection=${conn ? `${conn.code}#${conn.id}` : "-"}${extra ? ` ${extra}` : ""}${cid && !/\bcid=/.test(extra) ? ` cid=${cid}` : ""}`, 1000));
}

// ───────────────────────── input parsing ─────────────────────────
const str = (v, name, { max, required = false, pattern, patternMsg, upper = false } = {}) => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw bad(`${name} is required`, { field: name });
    return null;
  }
  if (typeof v !== "string") throw bad(`${name} must be text`, { field: name });
  let s = v.trim();
  if (upper) s = s.toUpperCase();
  if (max && s.length > max) throw bad(`${name} must be at most ${max} characters`, { field: name });
  if (pattern && !pattern.test(s)) throw bad(patternMsg || `${name} is not valid`, { field: name });
  return s;
};
const oneOf = (v, allowed, name, { required = false, fallback = null } = {}) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${name} is required`, { field: name });
    return fallback;
  }
  const s = String(v).toUpperCase();
  if (!allowed.includes(s)) throw bad(`${name} must be one of: ${allowed.join(", ")}`, { field: name });
  return s;
};
const asBad = (field) => (e) => { throw e instanceof ErpIntegrationError ? bad(e.message, { field }) : e; };

// The provider a connection resolves to (explicit, else the ERP type's default). Descriptor or null.
const descriptorFor = (v) => registry.getDescriptor(registry.resolveProviderKey({ provider: v.provider, erp_type: v.erp_type }));

function parseCapabilities(input, descriptor) {
  if (!Array.isArray(input)) throw bad("capabilities must be a list", { field: "capabilities" });
  const seen = new Set();
  return input.map((c) => {
    if (!c || typeof c !== "object") throw bad("Each capability must be an object", { field: "capabilities" });
    const capability = oneOf(c.capability, C.CAPABILITY_VALUES, "capability", { required: true });
    if (seen.has(capability)) throw bad(`Capability ${capability} is listed more than once`, { field: "capabilities" });
    seen.add(capability);
    const def = C.CAPABILITIES.find((x) => x.value === capability).defaultDirection;
    const raw = c.direction === undefined || c.direction === null || c.direction === "" ? def : String(c.direction).toUpperCase();
    const direction = C.LEGACY_DIRECTION_ALIASES[raw] || raw;
    if (!C.DIRECTIONS.includes(direction)) throw bad(`direction must be one of: ${C.DIRECTIONS.join(", ")}`, { field: "direction" });
    const endpointPath = str(c.endpointPath, "endpointPath", { max: 255 });
    if (endpointPath && (/[?#\\\s]/.test(endpointPath) || endpointPath.includes("..") || endpointPath.includes("//"))) throw bad("endpointPath contains invalid characters", { field: "capabilities" });
    let config = null;
    if (c.config !== undefined && c.config !== null) {
      if (!descriptor) throw bad("Choose a provider before configuring capability settings", { field: "capabilities" });
      try { config = descriptor.validateCapabilityConfig(c.config); } catch (e) { asBad("capabilities")(e); }
      if (!Object.keys(config).length) config = null;
    }
    const out = { capability, direction, enabled: direction !== "DISABLED" && (c.enabled === undefined ? true : Boolean(c.enabled)), endpoint_path: endpointPath, config };
    if ("ownership" in c) { // Phase 16: only touched when the caller sends it, so an older client never wipes a decision
      const o = c.ownership === null || c.ownership === "" ? null : String(c.ownership).toUpperCase();
      if (o !== null && !C.OWNERSHIPS.includes(o)) throw bad(`ownership must be one of: ${C.OWNERSHIPS.join(", ")}`, { field: "ownership" });
      out.ownership = o;
    }
    return out;
  });
}

// Validates a create/update body → column values. `partial` = update (only supplied keys are returned).
function parseConnection(body, { partial }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Request body must be an object");
  // Phase 17: credentials are NEVER accepted by this API (only a server-side reference name). A secret-looking field is refused loudly instead of being silently ignored.
  const SAFE_KEYS = ["credentialRef", "authType", "authHeaderName"];
  const secretKey = Object.keys(body).find((k) => !SAFE_KEYS.includes(k) && isSecretKey(k));
  if (secretKey) throw bad("Credentials are not accepted here. Store them on the server and enter only the credential reference name.", { field: secretKey });
  const has = (k) => body[k] !== undefined;
  const out = {};
  const take = (key, bodyKey, fn) => { if (!partial || has(bodyKey)) out[key] = fn(); };

  take("name", "name", () => str(body.name, "name", { required: true, max: 120 }));
  take("erp_type", "erpType", () => oneOf(body.erpType, C.ERP_TYPES, "erpType", { required: true }));
  take("provider", "provider", () => {
    if (body.provider === null || body.provider === "") return null;
    const p = oneOf(body.provider, Object.keys(registry.PROVIDERS), "provider");
    return p;
  });
  take("environment", "environment", () => oneOf(body.environment, C.ENVIRONMENTS, "environment", { required: true }));
  take("odata_version", "odataVersion", () => oneOf(body.odataVersion, C.ODATA_VERSIONS, "odataVersion", { fallback: "V2" }));
  take("base_url", "baseUrl", () => { try { return validateBaseUrl(body.baseUrl); } catch (e) { return asBad("baseUrl")(e); } });
  take("odata_service_path", "odataServicePath", () => { try { return validateServicePath(body.odataServicePath) || null; } catch (e) { return asBad("odataServicePath")(e); } });
  take("sap_client", "sapClient", () => str(body.sapClient, "sapClient", { pattern: /^\d{3}$/, patternMsg: "SAP client must be 3 digits" }));
  take("company_code", "companyCode", () => str(body.companyCode, "companyCode", { max: 10, pattern: /^[A-Za-z0-9]+$/, patternMsg: "Company code must be letters/digits only" }));
  take("auth_type", "authType", () => {
    const raw = body.authType === undefined || body.authType === null || body.authType === "" ? "BASIC" : String(body.authType).toUpperCase();
    if (C.AUTH_TYPES_FUTURE.includes(raw)) throw bad(`Authentication type ${raw} is planned but not available yet`, { field: "authType" });
    if (!C.AUTH_TYPES.includes(raw)) throw bad(`authType must be one of: ${C.AUTH_TYPES.join(", ")}`, { field: "authType" });
    return raw;
  });
  take("auth_header_name", "authHeaderName", () => {
    const h = str(body.authHeaderName, "authHeaderName", { max: 64 });
    if (!h) return null;
    try { return validateHeaderName(h); } catch (e) { return asBad("authHeaderName")(e); }
  });
  take("credential_ref", "credentialRef", () => {
    const r = str(body.credentialRef, "credentialRef", { upper: true });
    if (r && !isValidRef(r)) throw bad("Credential reference must be 2–40 characters: A–Z, 0–9 and _ (it names a server-side secret; it is not the password)", { field: "credentialRef" });
    return r;
  });
  take("timeout_ms", "timeoutMs", () => {
    if (body.timeoutMs === undefined || body.timeoutMs === null || body.timeoutMs === "") return 10000;
    const n = Number(body.timeoutMs);
    if (!Number.isInteger(n) || n < 1000 || n > 60000) throw bad("Timeout must be a whole number of milliseconds between 1000 and 60000", { field: "timeoutMs" });
    return n;
  });
  take("description", "description", () => str(body.description, "description", { max: 500 }));
  if (has("config")) { if (body.config !== null && (typeof body.config !== "object" || Array.isArray(body.config))) throw bad("config must be an object", { field: "config" }); out._config = body.config; }
  return out;
}

// Cross-field checks once the final (merged) provider settings are known.
function checkProviderSettings(merged, rawConfig) {
  const key = registry.resolveProviderKey({ provider: merged.provider, erp_type: merged.erp_type });
  const desc = key ? registry.getDescriptor(key) : null;
  if (merged.provider && !desc) throw bad("Unknown provider", { field: "provider" });
  if (desc && !desc.authTypes.includes(merged.auth_type)) throw bad(`${desc.label} supports: ${desc.authTypes.join(", ")} authentication`, { field: "authType" });
  if (merged.auth_header_name && merged.auth_type !== "API_KEY") throw bad("The header name applies to API_KEY authentication only", { field: "authHeaderName" });
  let config = null;
  if (rawConfig !== undefined && rawConfig !== null) {
    if (!desc) throw bad("Choose a provider before configuring provider settings", { field: "config" });
    try { config = desc.validateConnectionConfig(rawConfig); } catch (e) { asBad("config")(e); }
    if (!Object.keys(config).length) config = null;
  }
  return { descriptor: desc, config };
}

// ───────────────────────── presentation (NEVER includes a secret) ─────────────────────────
async function present(row, { capabilities, lastSync, mappedCaps } = {}) {
  const c = row.get ? row.get({ plain: true }) : row;
  const caps = (capabilities || c.capabilities || []).map((x) => ({
    capability: x.capability,
    label: (C.CAPABILITIES.find((d) => d.value === x.capability) || {}).label || x.capability,
    direction: x.direction,
    ownership: x.ownership || null,
    ownershipRequired: C.OWNERSHIP_REQUIRED.includes(x.capability),
    enabled: Boolean(x.enabled),
    endpointPath: x.endpoint_path || null,
    config: x.config || null,
    syncSupported: Boolean(getTarget(x.capability)),
  })).sort((a, b) => C.CAPABILITY_VALUES.indexOf(a.capability) - C.CAPABILITY_VALUES.indexOf(b.capability));
  const providerKey = registry.resolveProviderKey(c);
  const desc = registry.getDescriptor(providerKey);
  const credStatus = await credentialStatus(c.credential_ref, c.auth_type);
  const health = computeConnectionHealth(c, { credentialStatus: credStatus, lastSync });
  const cfg = validateConfiguration(c, caps.map((x) => ({ capability: x.capability, direction: x.direction, enabled: x.enabled, endpointPath: x.endpointPath, config: x.config, ownership: x.ownership })));
  if (credStatus !== "RESOLVED" && c.status !== "INACTIVE") cfg.warnings.push({ code: credStatus === "NOT_SET" ? "CREDENTIALS_NOT_SET" : "CREDENTIALS_MISSING", message: credStatus === "NOT_SET" ? "No credential reference is set." : "The server cannot resolve this connection's credentials." });
  if (mappedCaps) for (const x of caps) if (x.enabled && x.direction !== "DISABLED" && x.syncSupported && !mappedCaps.has(x.capability)) cfg.warnings.push({ code: "MAPPING_MISSING", message: `${x.capability}: no field mapping (with a key) is configured yet.`, capability: x.capability });
  return {
    id: c.id, code: c.code, name: c.name,
    erpType: c.erp_type, erpTypeLabel: C.ERP_TYPE_LABELS[c.erp_type] || c.erp_type,
    provider: { key: providerKey, explicit: Boolean(c.provider), label: desc ? desc.label : null, protocol: desc ? desc.protocol : null, status: desc ? desc.status : "NOT_SELECTED" },
    environment: c.environment, odataVersion: c.odata_version,
    baseUrl: c.base_url, odataServicePath: c.odata_service_path || null, sapClient: c.sap_client || null, companyCode: c.company_code || null,
    authType: c.auth_type, authHeaderName: c.auth_header_name || null,
    config: c.config || null,
    credentials: { reference: c.credential_ref || null, status: credStatus }, // RESOLVED | MISSING | NOT_SET — never the values
    timeoutMs: c.timeout_ms,
    status: c.status, // ACTIVE | INACTIVE | ERROR — admin lifecycle, NOT proof of reachability
    isDefault: Boolean(c.is_default),
    description: c.description || null,
    capabilities: caps,
    health: {
      state: !c.last_test_at ? "NOT_TESTED" : c.last_test_ok ? "REACHABLE" : "FAILED", // Phase 13 field, kept for existing clients
      status: health.status, reason: health.reason, // Phase 17: CONNECTED | DEGRADED | FAILED | NOT_TESTED | DISABLED
      testedAt: c.last_test_at || null, ok: c.last_test_at ? Boolean(c.last_test_ok) : null,
      code: c.last_test_code || null, message: c.last_test_message || null, latencyMs: c.last_test_latency_ms ?? null,
    },
    configWarnings: cfg.warnings,
    lastSync: lastSync || null,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

const withCaps = (db) => [{ model: db.ErpConnectionCapability, as: "capabilities", required: false }];
async function loadOwned(db, tenantKey, id, opts = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.ErpConnection.findOne({ where: { id: n, tenant_key: tenantKey }, include: withCaps(db), ...opts });
}

// Latest finished-or-running job per connection (tenant-scoped), for the "Last sync" line. Real data only; null when none.
async function lastSyncMap(db, tenantKey, ids) {
  if (!ids.length) return {};
  // newest job per connection in two bounded queries (no scan of the whole job history)
  const newest = await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, connection_id: ids }, attributes: ["connection_id", [db.Sequelize.fn("MAX", db.Sequelize.col("id")), "id"]], group: ["connection_id"], raw: true });
  if (!newest.length) return {};
  const jobs = await db.ErpSyncJob.findAll({ where: { tenant_key: tenantKey, id: newest.map((n) => n.id) } });
  const map = {};
  for (const j of jobs) map[j.connection_id] = { jobId: j.id, status: j.status, capability: j.capability, at: j.completed_at || j.started_at || j.createdAt };
  return map;
}
async function mappedCapabilities(db, ids) { // connection id → Set of capabilities that have a key mapping (one query for the whole list)
  const out = new Map(ids.map((i) => [i, new Set()]));
  if (!ids.length) return out;
  const rows = await db.ErpEntityMapping.findAll({ where: { connection_id: ids, is_key: true }, attributes: ["connection_id", "capability"], raw: true });
  for (const r of rows) out.get(r.connection_id).add(r.capability);
  return out;
}

// ───────────────────────── operations ─────────────────────────
const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();
function getLookups() {
  const providers = registry.listProviders();
  return {
    erpTypes: C.ERP_TYPES.map((v) => {
      const dp = registry.DEFAULT_PROVIDER_FOR_ERP_TYPE[v];
      const d = dp ? registry.getDescriptor(dp) : null;
      return { value: v, label: C.ERP_TYPE_LABELS[v], defaultProvider: dp, supported: Boolean(d && d.status === "IMPLEMENTED") };
    }),
    providers,
    environments: C.ENVIRONMENTS.map((v) => ({ value: v, label: cap(v) })),
    statuses: C.STATUSES.map((v) => ({ value: v, label: cap(v) })),
    authTypes: C.AUTH_TYPES,
    authTypesFuture: C.AUTH_TYPES_FUTURE,
    odataVersions: C.ODATA_VERSIONS,
    directions: [{ value: "ERP_TO_DMS", label: "ERP → DMS" }, { value: "DMS_TO_ERP", label: "DMS → ERP" }, { value: "BIDIRECTIONAL", label: "Both ways" }, { value: "DISABLED", label: "Disabled" }],
    ownerships: [{ value: "ERP_OWNED", label: "ERP owns the data" }, { value: "DMS_OWNED", label: "DMS owns the data" }, { value: "SHARED", label: "Shared" }],
    ownershipRequired: C.OWNERSHIP_REQUIRED,
    codeMappingTypes: require("./erpCodeMapping.service").describe(),
    outboundCapabilities: require("./erpOutbound.service").OUTBOUND_CAPABILITIES,
    capabilities: C.CAPABILITIES.map((x) => { const u = getUnsupported(x.value); return { ...x, syncSupported: Boolean(getTarget(x.value)), syncUnsupportedCode: u ? u.code : null, syncUnsupportedReason: u ? u.reason : null }; }),
    syncTargets: describeTargets(),
    scheduleFrequencies: C.SCHEDULE_FREQUENCIES.map(({ value, label }) => ({ value, label })),
  };
}

async function listConnections(db, tenantKey, query = {}) {
  const where = { tenant_key: tenantKey };
  if (query.status) where.status = oneOf(query.status, C.STATUSES, "status");
  if (query.erpType) where.erp_type = oneOf(query.erpType, C.ERP_TYPES, "erpType");
  if (query.environment) where.environment = oneOf(query.environment, C.ENVIRONMENTS, "environment");
  const q = (V.text(query.q, "q", { max: 100 }) || "").toLowerCase();
  // bounded: a tenant has a handful of ERP connections; 200 is a hard safety cap, never a page the UI needs to walk
  let rows = await db.ErpConnection.findAll({ where, include: withCaps(db), order: [["is_default", "DESC"], ["name", "ASC"], ["id", "ASC"]], limit: 200 });
  if (q) rows = rows.filter((r) => `${r.name} ${r.code}`.toLowerCase().includes(q));
  const last = await lastSyncMap(db, tenantKey, rows.map((r) => r.id));
  const mapped = await mappedCapabilities(db, rows.map((r) => r.id));
  const items = await Promise.all(rows.map((r) => present(r, { lastSync: last[r.id] || null, mappedCaps: mapped.get(r.id) })));
  const defaultRow = await db.ErpConnection.findOne({ where: { tenant_key: tenantKey, is_default: true } });
  const total = await db.ErpConnection.count({ where: { tenant_key: tenantKey } });
  return { items, total: items.length, tenantTotal: total, defaultConnectionId: defaultRow ? defaultRow.id : null, hasDefault: Boolean(defaultRow) };
}

async function getConnection(db, tenantKey, id) {
  const row = await loadOwned(db, tenantKey, id);
  if (!row) return null;
  const last = await lastSyncMap(db, tenantKey, [row.id]);
  return present(row, { lastSync: last[row.id] || null, mappedCaps: (await mappedCapabilities(db, [row.id])).get(row.id) });
}

async function nextCode(db, tenantKey, t) {
  const rows = await db.ErpConnection.findAll({ where: { tenant_key: tenantKey }, attributes: ["code"], transaction: t });
  const max = rows.reduce((m, r) => { const x = /^ERP-(\d+)$/.exec(r.code); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `ERP-${String(max + 1).padStart(3, "0")}`;
}

async function createConnection(db, tenantKey, adminId, body) {
  const { _config, ...values } = parseConnection(body, { partial: false });
  const { descriptor, config } = checkProviderSettings(values, _config);
  const caps = body.capabilities === undefined ? [] : parseCapabilities(body.capabilities, descriptor);
  const cfgCheck = validateConfiguration(values, caps);
  if (cfgCheck.errors.length) throw bad(cfgCheck.errors[0].message, { field: cfgCheck.errors[0].field, errors: cfgCheck.errors });
  const explicitCode = str(body.code, "code", { upper: true, pattern: /^[A-Z0-9][A-Z0-9_-]{1,39}$/, patternMsg: "Code must be 2–40 characters: A–Z, 0–9, - and _" });
  try {
    const created = await db.sequelize.transaction(async (t) => {
      const code = explicitCode || (await nextCode(db, tenantKey, t));
      const dup = await db.ErpConnection.findOne({ where: { tenant_key: tenantKey, code }, transaction: t });
      if (dup) throw new ErpApiError(409, "DUPLICATE_CODE", `An ERP connection with code ${code} already exists`);
      // is_default is NEVER set here — no arbitrary default is chosen. Use setDefault.
      const row = await db.ErpConnection.create({ ...values, config, code, tenant_key: tenantKey, status: "ACTIVE", is_default: false, default_marker: null, created_by_admin_id: adminId || null, updated_by_admin_id: adminId || null }, { transaction: t });
      for (const c of caps) await db.ErpConnectionCapability.create({ ...c, connection_id: row.id }, { transaction: t });
      return row;
    });
    audit("ERP_CREATED", adminId, tenantKey, created);
    return await getConnection(db, tenantKey, created.id);
  } catch (err) {
    if (err instanceof db.Sequelize.UniqueConstraintError) throw new ErpApiError(409, "DUPLICATE_CODE", "An ERP connection with this code already exists");
    throw err;
  }
}

// Fields whose change alters WHERE we connect, HOW we authenticate or which credential is used → audited separately (names only, never values; host without path).
const SECURITY_FIELDS = ["base_url", "odata_service_path", "provider", "erp_type", "environment", "auth_type", "auth_header_name", "credential_ref", "timeout_ms"];
const hostOf = (u) => { try { return new URL(u).host; } catch { return "-"; } };
const CONNECTIVITY_FIELDS = ["erp_type", "provider", "odata_version", "base_url", "odata_service_path", "sap_client", "credential_ref", "auth_type", "auth_header_name", "timeout_ms"];
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function updateConnection(db, tenantKey, adminId, id, body) {
  if (body && typeof body === "object" && (body.status !== undefined || body.isDefault !== undefined || body.is_default !== undefined)) {
    throw bad("Status and default are changed through their own actions, not by editing the connection");
  }
  if (body && body.code !== undefined) throw bad("The connection code cannot be changed", { field: "code" });
  const { _config, ...values } = parseConnection(body, { partial: true });

  const ownershipChanges = []; const securityChanges = [];
  const changed = await db.sequelize.transaction(async (t) => {
    const row = await loadOwned(db, tenantKey, id, { transaction: t });
    if (!row) return null;
    const merged = { provider: row.provider, erp_type: row.erp_type, auth_type: row.auth_type, auth_header_name: row.auth_header_name, ...values };
    const { descriptor, config } = checkProviderSettings(merged, _config === undefined ? row.config : _config);
    const caps = body.capabilities === undefined ? null : parseCapabilities(body.capabilities, descriptor);
    const patch = { ...values, updated_by_admin_id: adminId || null };
    {
      // Phase 17: configuration rules over the MERGED state. Blocking errors apply when capabilities are being saved or the provider changes (an
      // untouched legacy state never blocks an unrelated edit); everything else is reported as a warning on the connection.
      const storedCaps = caps ? null : (await db.ErpConnectionCapability.findAll({ where: { connection_id: row.id }, transaction: t })).map((x) => x.get({ plain: true }));
      const check = validateConfiguration({ ...row.get({ plain: true }), ...values }, caps || storedCaps);
      if (check.errors.length && (caps || "provider" in values || "erp_type" in values)) throw bad(check.errors[0].message, { field: check.errors[0].field, errors: check.errors });
    }
    for (const f of SECURITY_FIELDS) if (f in patch && !sameJson(patch[f], row[f])) securityChanges.push(f);
    if ("config" in patch && !sameJson(patch.config, row.config)) securityChanges.push("config");
    if (_config !== undefined || ("provider" in values) || ("erp_type" in values)) patch.config = _config === undefined ? row.config : config;
    const connectivityChanged = CONNECTIVITY_FIELDS.some((f) => f in patch && patch[f] !== row[f]) || ("config" in patch && !sameJson(patch.config, row.config));
    if (connectivityChanged) {
      // The old test result no longer describes this configuration → back to "Not tested"; a stale ERROR is cleared.
      Object.assign(patch, { last_test_at: null, last_test_ok: null, last_test_code: null, last_test_message: null, last_test_latency_ms: null });
      if (row.status === "ERROR") patch.status = "ACTIVE";
    }
    await row.update(patch, { transaction: t });
    if (caps) {
      const keep = caps.map((c) => c.capability);
      await db.ErpConnectionCapability.destroy({ where: { connection_id: row.id, capability: { [db.Sequelize.Op.notIn]: keep.length ? keep : ["__none__"] } }, transaction: t });
      for (const c of caps) {
        const ex = await db.ErpConnectionCapability.findOne({ where: { connection_id: row.id, capability: c.capability }, transaction: t });
        if (ex) {
          const before = ex.ownership || null;
          await ex.update({ direction: c.direction, enabled: c.enabled, endpoint_path: c.endpoint_path, config: c.config, ...("ownership" in c ? { ownership: c.ownership } : {}) }, { transaction: t });
          if ("ownership" in c && c.ownership !== before) ownershipChanges.push(`capability=${c.capability} ownership=${c.ownership || "UNDECIDED"} previous=${before || "UNDECIDED"}`);
        }
        else await db.ErpConnectionCapability.create({ ...c, connection_id: row.id }, { transaction: t });
      }
    }
    return row;
  });
  if (!changed) return null;
  audit("ERP_UPDATED", adminId, tenantKey, changed);
  for (const line of ownershipChanges) audit("ERP_OWNERSHIP_UPDATED", adminId, tenantKey, changed, line);
  if (securityChanges.length) audit("ERP_SECURITY_CONFIG_UPDATED", adminId, tenantKey, changed, `change=updated fields=${securityChanges.join(",")} host=${hostOf(changed.base_url)}`);
  return getConnection(db, tenantKey, id);
}

// Activate / deactivate. ERROR is system-set (by a failed test) and cannot be requested.
async function setStatus(db, tenantKey, adminId, id, body = {}) {
  const status = oneOf(body.status, ["ACTIVE", "INACTIVE"], "status", { required: true });
  const clearDefault = body.clearDefault === true;
  const result = await db.sequelize.transaction(async (t) => {
    const row = await loadOwned(db, tenantKey, id, { transaction: t });
    if (!row) return null;
    if (status === "INACTIVE" && row.is_default && !clearDefault) {
      throw new ErpApiError(409, "DEFAULT_ERP_CONNECTION", "This is the default ERP connection. Choose another default first, or deactivate it and leave the tenant with no default.", { requiresClearDefault: true });
    }
    if (row.status === status) return { row, cleared: false, noop: true };
    const patch = { status, updated_by_admin_id: adminId || null };
    let cleared = false;
    if (status === "INACTIVE" && row.is_default) { patch.is_default = false; patch.default_marker = null; cleared = true; }
    await row.update(patch, { transaction: t });
    return { row, cleared, noop: false };
  });
  if (!result) return null;
  if (!result.noop) {
    audit(status === "ACTIVE" ? "ERP_ACTIVATED" : "ERP_DEACTIVATED", adminId, tenantKey, result.row);
    if (result.cleared) audit("ERP_DEFAULT_CHANGED", adminId, tenantKey, result.row, "default=NONE");
  }
  return { ...(await getConnection(db, tenantKey, id)), defaultCleared: result.cleared };
}

// Exactly one default per tenant: clear the old one, mark the new one — ONE transaction; the unique index on default_marker is the backstop.
async function setDefault(db, tenantKey, adminId, id) {
  try {
    const r = await db.sequelize.transaction(async (t) => {
      const row = await loadOwned(db, tenantKey, id, { transaction: t });
      if (!row) return null;
      if (row.status === "INACTIVE") throw new ErpApiError(409, "ERP_CONNECTION_INACTIVE", "An inactive ERP connection cannot be the default. Activate it first.");
      if (row.is_default) return { row, changed: false };
      await db.ErpConnection.update({ is_default: false, default_marker: null }, { where: { tenant_key: tenantKey, is_default: true }, transaction: t });
      await row.update({ is_default: true, default_marker: tenantKey, updated_by_admin_id: adminId || null }, { transaction: t });
      return { row, changed: true };
    });
    if (!r) return null;
    if (r.changed) audit("ERP_DEFAULT_CHANGED", adminId, tenantKey, r.row, "default=SET");
    return getConnection(db, tenantKey, id);
  } catch (err) {
    if (err instanceof db.Sequelize.UniqueConstraintError) throw new ErpApiError(409, "DEFAULT_CONFLICT", "The default ERP was changed by someone else. Reload and try again.");
    throw err;
  }
}

// Performs a REAL request through the connection's provider. The outcome is persisted (last_test_*) and, for an enabled connection,
// moves status ACTIVE ⇄ ERROR. A failed test is a normal API response with ok:false — the test itself ran.
async function testConnection(db, tenantKey, adminId, id, { fetchImpl, logger, correlationId: cidIn, resolver } = {}) {
  const row = await loadOwned(db, tenantKey, id); // ownership first: a foreign / unknown id returns here, before any provider or network code runs
  if (!row) return null;
  const conn = row.get({ plain: true });
  const correlationId = cidIn || reqctx.currentCorrelationId() || crypto.randomUUID();
  const startedAt = Date.now();
  let outcome;
  try {
    const provider = await buildProvider(conn, { capabilities: conn.capabilities || [], fetchImpl, logger, resolver });
    const r = await provider.testConnection({ correlationId, capabilities: conn.capabilities || [] });
    const slow = conn.timeout_ms && r.latencyMs > conn.timeout_ms * 0.6;
    const warnings = [...(r.warnings || []), ...(slow ? ["The ERP answered slowly."] : [])];
    outcome = { ok: true, status: warnings.length ? "DEGRADED" : "CONNECTED", code: "CONNECTED", message: "Connected", httpStatus: r.httpStatus, latencyMs: r.latencyMs, warnings };
  } catch (e) {
    const err = normalizeError(e);
    if (err.internal) console.error(`[erp-test] cid=${correlationId} connection=${conn.code} code=${err.code} detail=${redact(err.internal)}`);
    outcome = { ok: false, status: "FAILED", code: err.code, message: err.message, httpStatus: err.httpStatus, latencyMs: Date.now() - startedAt, retryable: err.retryable, warnings: [] };
  }
  const patch = { last_test_at: new Date(), last_test_ok: outcome.ok, last_test_code: outcome.ok ? "CONNECTED" : outcome.code, last_test_message: String(outcome.message).slice(0, 255), last_test_latency_ms: outcome.latencyMs, updated_by_admin_id: adminId || null };
  if (conn.status !== "INACTIVE") patch.status = outcome.ok ? "ACTIVE" : "ERROR"; // an inactive connection can be tested but is never re-enabled by a test
  await row.update(patch);
  audit("ERP_CONNECTION_TESTED", adminId, tenantKey, conn, `result=${outcome.ok ? outcome.status : outcome.code} cid=${correlationId}`);
  // Generic result: provider-specific details stay inside the provider; nothing here can contain a credential.
  return { connectionId: conn.id, provider: registry.resolveProviderKey(conn), ...outcome, testedAt: patch.last_test_at, correlationId, connection: await getConnection(db, tenantKey, id) };
}

module.exports = { ErpApiError, ErpIntegrationError, getLookups, listConnections, getConnection, createConnection, updateConnection, setStatus, setDefault, testConnection, loadOwned, audit, str, oneOf, bad };
