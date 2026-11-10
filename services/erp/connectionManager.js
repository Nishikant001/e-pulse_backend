// services/erp/connectionManager.js — turns a stored ERP connection into a ready provider and answers the sync engine's questions.
// Provider resolution: connection → provider key (explicit, else the ERP type's default) → registry → adapter instance.
// An unknown / unavailable provider is PROVIDER_NOT_SUPPORTED — never a fallback to SAP or anything else. Always tenant-scoped.
const { ErpIntegrationError } = require("./erpErrors");
const { resolveCredentials } = require("./secretResolver");
const { validateBaseUrl, validateServicePath, assertHostSafe } = require("./urlValidator");
const { getDescriptor, resolveProviderKey } = require("./providerRegistry");
const { implementsContract } = require("./providerContract");

async function buildProvider(connection, { capabilities = [], fetchImpl, logger, resolver } = {}) {
  const key = resolveProviderKey(connection);
  if (!key) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: `No provider is selected for ERP type ${connection.erp_type}. Choose one in the connection settings.` });
  const desc = getDescriptor(key);
  if (!desc) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: `Unknown provider ${key}.` });
  if (desc.status !== "IMPLEMENTED" || !desc.create) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: `The ${desc.label} provider is ${desc.status === "FUTURE" ? "planned" : "prepared"} but not implemented yet.` });
  if (!desc.authTypes.includes(connection.auth_type)) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: `${desc.label} does not support ${connection.auth_type} authentication.` });

  const base = validateBaseUrl(connection.base_url);
  const path = validateServicePath(connection.odata_service_path);
  await assertHostSafe(base, { resolver }); // Phase 17: production-only DNS check — runs BEFORE credentials are resolved and before any request
  const credentials = await resolveCredentials(connection.credential_ref, connection.auth_type);
  const provider = desc.create({ connection: { ...connection, base_url: base, odata_service_path: path }, capabilities, credentials, fetchImpl, logger });
  if (!implementsContract(provider)) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: `The ${desc.label} provider does not satisfy the provider interface.` });
  return provider;
}

const plain = (row) => (row ? row.get({ plain: true }) : null);
async function getDefaultConnection(db, tenantKey) { return plain(await db.ErpConnection.findOne({ where: { tenant_key: tenantKey, is_default: true, status: ["ACTIVE", "ERROR"] } })); }
async function requireDefaultConnection(db, tenantKey) {
  const c = await getDefaultConnection(db, tenantKey);
  if (!c) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "No default ERP connection is configured." });
  return c;
}
async function findConnectionsForCapability(db, tenantKey, capability) {
  const rows = await db.ErpConnection.findAll({
    where: { tenant_key: tenantKey, status: ["ACTIVE", "ERROR"] },
    include: [{ model: db.ErpConnectionCapability, as: "capabilities", where: { capability, enabled: true }, required: true }],
    order: [["is_default", "DESC"], ["id", "ASC"]],
  });
  return rows.map(plain);
}

module.exports = { buildProvider, getDefaultConnection, requireDefaultConnection, findConnectionsForCapability };
