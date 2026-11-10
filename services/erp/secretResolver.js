// services/erp/secretResolver.js — resolves a connection's credential REFERENCE into real secrets (server-side only).
// No secret is ever stored in the database. A connection stores only credential_ref (e.g. "ERP_PROD"); the variables read depend on auth type:
//   BASIC → ERP_<REF>_USERNAME + ERP_<REF>_PASSWORD   BEARER_TOKEN → ERP_<REF>_TOKEN   API_KEY → ERP_<REF>_API_KEY
// In production replace envProvider with Vault / AWS Secrets Manager / Azure Key Vault via setSecretProvider().
const { ErpIntegrationError } = require("./erpErrors");
const { secretFieldsFor } = require("./authStrategies");

const REF_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
const envProvider = {
  name: "env",
  async get(ref) {
    const e = (s) => process.env[`ERP_${ref}_${s}`] || "";
    return { username: e("USERNAME"), password: e("PASSWORD"), token: e("TOKEN"), apiKey: e("API_KEY") };
  },
};
let provider = envProvider;
const setSecretProvider = (p) => { provider = p || envProvider; };

const isValidRef = (ref) => typeof ref === "string" && REF_PATTERN.test(ref);
const complete = (c, authType) => Boolean(c) && secretFieldsFor(authType).length > 0 && secretFieldsFor(authType).every((f) => c[f]);

async function resolveCredentials(ref, authType = "BASIC") {
  if (!isValidRef(ref)) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "No valid credential reference is configured for this connection." });
  const c = await provider.get(ref);
  if (!complete(c, authType)) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "The credentials for this connection's reference are not available on the server." });
  return Object.fromEntries(secretFieldsFor(authType).map((f) => [f, c[f]]));
}

// → "RESOLVED" | "MISSING" | "NOT_SET". Never returns or logs a value.
async function credentialStatus(ref, authType = "BASIC") {
  if (!ref) return "NOT_SET";
  if (!isValidRef(ref)) return "MISSING";
  try { return complete(await provider.get(ref), authType) ? "RESOLVED" : "MISSING"; } catch { return "MISSING"; }
}

module.exports = { resolveCredentials, credentialStatus, isValidRef, setSecretProvider, REF_PATTERN };
