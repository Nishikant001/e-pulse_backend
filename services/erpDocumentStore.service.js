// services/erpDocumentStore.service.js — Phase 18. SECURE DOCUMENT STORE ABSTRACTION + readiness. This is NOT document synchronisation.
//
// The project has no approved document store: the only upload code (middleware/upload.js, routes/allRoutes.js) is a bulk-import spreadsheet upload that writes
// to a local ./uploads folder — it is NOT tenant- or distributor-isolated and is deliberately NOT reused for ERP documents. This file defines what an ERP document
// must pass BEFORE any store may hold it, and refuses to ingest anything while no approved store is registered:
//
//   ERP → Provider → Document sync (blocked) → this service (validate → scan → store through an adapter) → tenant-isolated storage (NOT PROVIDED)
//
// Provided here: safe filename, content-type allow-list with magic-byte check, size limit, path-traversal-proof storage keys (tenant / distributor / external
// document id), SHA-256 duplicate detection, a malware-scan HOOK (no scanner ships: none registered ⇒ ingestion refused), an adapter registry, and readiness.
// NOT provided: a storage adapter, a document table, document download / authorisation routes, a retention policy. Document sync therefore stays BLOCKED.
const crypto = require("crypto");
const { ErpIntegrationError } = require("./erp/erpErrors");

// Allow-list: content type → { extensions, magic-byte check }. Nothing executable, no scripts, no archives, no HTML/SVG (active content).
const TYPES = {
  "application/pdf": { ext: ["pdf"], magic: (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "image/png": { ext: ["png"], magic: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: ["jpg", "jpeg"], magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};
const ALLOWED_CONTENT_TYPES = Object.keys(TYPES);
const maxBytes = () => { const n = Number(process.env.ERP_DOCUMENT_MAX_BYTES); return Number.isFinite(n) && n >= 1024 ? Math.min(n, 50 * 1024 * 1024) : 10 * 1024 * 1024; };
const refuse = (code, message) => new ErpIntegrationError(code, { message });

/** Reduces a client/ERP supplied name to a safe base name. Directory parts, control characters, leading dots and odd characters are removed. */
function safeFilename(name) {
  const base = String(name === undefined || name === null ? "" : name).replace(/\0/g, "").split(/[\\/]/).pop();
  const cleaned = base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_{2,}/g, "_").replace(/^[._]+/, "").slice(0, 100);
  if (!cleaned || !/\.[A-Za-z0-9]{1,5}$/.test(cleaned)) throw refuse("VALIDATION_ERROR", "The document needs a file name with an extension (letters and digits only).");
  return cleaned;
}

/** Validates name, declared type, size and the file's real content. Returns the facts the store needs. Never trusts the declared type alone. */
function validateDocument({ filename, contentType, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw refuse("VALIDATION_ERROR", "The document is empty.");
  if (buffer.length > maxBytes()) throw refuse("VALIDATION_ERROR", `The document is larger than the ${Math.round(maxBytes() / 1024)} KB limit.`);
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (!TYPES[type]) throw refuse("VALIDATION_ERROR", `Content type "${type || "unknown"}" is not allowed. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}.`);
  const name = safeFilename(filename);
  const ext = name.split(".").pop().toLowerCase();
  if (!TYPES[type].ext.includes(ext)) throw refuse("VALIDATION_ERROR", "The file extension does not match the content type.");
  if (!TYPES[type].magic(buffer)) throw refuse("VALIDATION_ERROR", "The file content does not match its declared type.");
  return { filename: name, contentType: type, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

const seg = (v, label) => { const s = String(v === undefined || v === null ? "" : v); if (!/^[A-Za-z0-9_-]{1,40}$/.test(s)) throw refuse("VALIDATION_ERROR", `${label} is not valid for a storage path.`); return s; };
/** Storage key = tenant / distributor / hash of the ERP document id / safe file name. Built only from validated segments, so it cannot escape its tenant folder. */
function storageKey({ tenantKey, distributorId, externalDocumentId, filename }) {
  const did = Number(distributorId);
  if (!Number.isInteger(did) || did <= 0) throw refuse("VALIDATION_ERROR", "A distributor is required for a document.");
  const ext = String(externalDocumentId === undefined || externalDocumentId === null ? "" : externalDocumentId).trim();
  if (!ext || ext.length > 190) throw refuse("VALIDATION_ERROR", "The ERP document id is required (max 190 characters).");
  const key = ["tenants", seg(tenantKey, "Tenant"), "distributors", String(did), crypto.createHash("sha256").update(ext).digest("hex").slice(0, 24), safeFilename(filename)].join("/");
  if (key.includes("..") || key.includes("//") || key.startsWith("/")) throw refuse("VALIDATION_ERROR", "Unsafe storage key.");
  return key;
}

// ── registry: nothing is registered by default ──
let store = null; let scanner = null;
const ADAPTER_METHODS = ["put", "get", "delete", "exists"];
function setDocumentStore(adapter) {
  if (adapter === null) { store = null; return; }
  if (!adapter || ADAPTER_METHODS.some((m) => typeof adapter[m] !== "function") || adapter.tenantIsolated !== true) throw new Error("A document store adapter needs put/get/delete/exists and must attest tenantIsolated === true.");
  store = adapter;
}
function setMalwareScanner(fn) { if (fn !== null && typeof fn !== "function") throw new Error("The scanner must be a function (buffer) → { clean: boolean }."); scanner = fn; }
const hasStore = () => Boolean(store);
const hasScanner = () => Boolean(scanner);

/** The pipeline a synchronised ERP document would take. With no approved store/scanner it REFUSES (BUSINESS_DECISION_REQUIRED) — nothing is written anywhere. */
// Phase 19 — FAIL CLOSED. A scanner or store that throws is an unavailable dependency, never a "pass": the document is not stored, the caller gets a fixed, secret-free
// message (CONNECTION_ERROR = retryable dependency outage) with `stage` = SCAN | STORE, and the adapter's own message is kept only in the redacted `internal` field.
const unavailable = (stage, what, e) => { const x = new ErpIntegrationError("CONNECTION_ERROR", { message: `The ${what} is unavailable. The document was not stored; try again later.`, internal: redactInternal(e) }); x.stage = stage; return x; };
const redactInternal = (e) => require("./erp/erpErrors").redact(e && e.message ? e.message : e);
async function ingest({ tenantKey, distributorId, externalDocumentId, filename, contentType, buffer }) {
  if (!store) throw refuse("BUSINESS_DECISION_REQUIRED", "Document synchronisation is blocked: no secure, tenant-isolated document store has been approved and registered.");
  if (!scanner) throw refuse("BUSINESS_DECISION_REQUIRED", "Document synchronisation is blocked: no malware scanner is registered.");
  const facts = validateDocument({ filename, contentType, buffer });
  let verdict;
  try { verdict = await scanner(buffer); } catch (e) { throw unavailable("SCAN", "malware scanner", e); }
  if (!verdict || verdict.clean !== true) throw refuse("VALIDATION_ERROR", "The document was rejected by the malware scan.");
  const key = storageKey({ tenantKey, distributorId, externalDocumentId, filename: facts.filename });
  let exists;
  try { exists = await store.exists(key); } catch (e) { throw unavailable("STORE", "document store", e); }
  if (exists) return { key, duplicate: true, ...facts }; // same ERP document id for the same distributor: stored once
  try { await store.put(key, buffer, { contentType: facts.contentType, sha256: facts.sha256 }); } catch (e) { throw unavailable("STORE", "document store", e); }
  return { key, duplicate: false, ...facts };
}

// In-memory store for TESTS ONLY (never registered by this module).
function createMemoryStore() {
  const m = new Map();
  return { tenantIsolated: true, async put(k, b) { m.set(k, Buffer.from(b)); }, async get(k) { return m.get(k) || null; }, async delete(k) { m.delete(k); }, async exists(k) { return m.has(k); }, size: () => m.size, keys: () => [...m.keys()] };
}

/** What stands between this DMS and Document sync. READY = implemented here; MISSING = does not exist / needs a business decision. */
function readiness() {
  const item = (id, label, ready, note) => ({ id, label, status: ready ? "READY" : "MISSING", note });
  const checks = [
    item("storageAbstraction", "Storage abstraction (adapter interface)", true, "Defined in this module."),
    item("approvedStore", "Approved, tenant-isolated store registered", hasStore(), hasStore() ? "An adapter is registered." : "No adapter exists. The local ./uploads folder is not isolated and is not used."),
    item("tenantIsolation", "Tenant isolation", true, "Storage keys start with the tenant; an adapter must attest tenantIsolated."),
    item("distributorIsolation", "Distributor isolation", true, "Storage keys include the distributor id."),
    item("safeFilename", "Safe filename", true, "safeFilename()."),
    item("contentType", "Content-type allow-list and magic-byte check", true, `Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}.`),
    item("sizeLimit", "Size limit", true, `${Math.round(maxBytes() / 1024)} KB (ERP_DOCUMENT_MAX_BYTES).`),
    item("pathTraversal", "Path-traversal prevention", true, "Keys are built from validated segments only."),
    item("malwareScan", "Malware-scan hook with a registered scanner", hasScanner(), hasScanner() ? "A scanner is registered." : "The hook exists; no scanner is registered, so ingestion is refused."),
    item("externalDocumentId", "Persistent external document id + document record", false, "There is no document table/entity in the DMS to link an ERP document id to."),
    item("duplicateDetection", "Duplicate detection", false, "SHA-256 and key-exists checks exist, but without a document record duplicates cannot be tracked across runs."),
    item("accessAuthorization", "Access authorisation (who may read a document)", false, "No document download/list route or permission exists."),
    item("audit", "Audit of document access", false, "Document events are not defined in the audit trail yet."),
    item("retention", "Retention / deletion policy", false, "Needs a business decision (legal retention period for pharmaceutical records)."),
  ];
  const ready = checks.every((c) => c.status === "READY");
  // Phase 19: the decisions only the business can take. They are REQUIRED until an approved adapter / scanner is registered; "retention" has no registry at all, so it stays REQUIRED
  // whatever is registered (a policy is a business decision, not something this code can detect). Nothing here is ever reported as approved on the business's behalf.
  const requiredDecisions = [
    { id: "storageProvider", question: "Which tenant-isolated storage provider is approved?", status: hasStore() ? "TECHNICALLY_REGISTERED" : "REQUIRED", note: hasStore() ? "An adapter is registered in code; the business approval is not recorded in the system." : "None approved." },
    { id: "malwareScanner", question: "Which malware scanner is approved?", status: hasScanner() ? "TECHNICALLY_REGISTERED" : "REQUIRED", note: hasScanner() ? "A scanner is registered in code; the business approval is not recorded in the system." : "None approved." },
    { id: "retention", question: "Which access-control and retention rules apply (who may read, how long, how deleted)?", status: "REQUIRED", note: "No retention or access policy is recorded; no document record or download route exists." },
  ];
  return { ready, status: ready ? "READY" : "BUSINESS_DECISION_REQUIRED", checks, missing: checks.filter((c) => c.status !== "READY").map((c) => c.id), requiredDecisions };
}

module.exports = { safeFilename, validateDocument, storageKey, setDocumentStore, setMalwareScanner, ingest, readiness, createMemoryStore, hasStore, hasScanner, ALLOWED_CONTENT_TYPES };
