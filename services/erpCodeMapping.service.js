// services/erpCodeMapping.service.js — Phase 16. REUSABLE "ERP code → DMS value" lookups: customer group, HSN, plant / storage location (warehouse),
// batch and payment mode. They are stored in the EXISTING erp_external_links table (no new mapping tables) under their own entity types, so they
// share its UNIQUE identity (connection, type, ERP code, scope) and are tenant-checked through the connection.
//   scope_key = "distributor:<id>" for per-distributor lookups; "" for the connection-wide payment mode.
//   ID-type lookups store the DMS row id in dms_entity_id; the payment mode (a value, not a row) stores dms_value and dms_entity_id = 0.
// A missing mapping is NEVER guessed: resolution throws BUSINESS_DECISION_REQUIRED naming the code that needs a mapping.
const { ErpApiError } = require("./erp/erpApiError");
const { ErpIntegrationError } = require("./erp/erpErrors");
const audit = require("./erpAudit.service");
const V = require("../utils/erpValidate");

const TYPES = {
  CUSTOMER_GROUP: { entityType: "CODE_CUSTOMER_GROUP", label: "Customer group", scoped: true, model: "CustomerGroup", dmsLabel: "customer group" },
  HSN: { entityType: "CODE_HSN", label: "HSN / tax", scoped: true, model: "HSNGroup", dmsLabel: "HSN record" },
  WAREHOUSE: { entityType: "CODE_WAREHOUSE", label: "Plant / storage location → warehouse", scoped: true, model: "Warehouse", dmsLabel: "warehouse" },
  BATCH: { entityType: "CODE_BATCH", label: "Batch", scoped: true, model: "Batch", dmsLabel: "batch" },
  PAYMENT_MODE: { entityType: "CODE_PAYMENT_MODE", label: "Payment mode", scoped: false, model: null, dmsLabel: "payment mode" },
};
const TYPE_KEYS = Object.keys(TYPES);
const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const scopeKeyOf = (type, distributorId) => (TYPES[type].scoped ? `distributor:${distributorId}` : "");
const intId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function typeOf(raw) {
  const k = String(raw || "").toUpperCase();
  if (!TYPES[k]) throw err(400, "VALIDATION_FAILED", `type must be one of: ${TYPE_KEYS.join(", ")}`, { field: "type" });
  return k;
}
function cleanCode(v) {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (!s) throw err(400, "VALIDATION_FAILED", "ERP code is required", { field: "externalCode" });
  if (s.length > 190) throw err(400, "VALIDATION_FAILED", "ERP code is longer than 190 characters", { field: "externalCode" });
  return s;
}

async function assertDmsRow(db, type, distributorId, id) {
  const def = TYPES[type];
  const row = await db[def.model].findOne({ where: { id, distributor_id: distributorId } });
  if (!row) throw err(400, "VALIDATION_FAILED", `The selected ${def.dmsLabel} does not exist for that distributor.`, { field: "dmsId" });
  return row;
}

const present = (r, type) => ({
  id: r.id, type, externalCode: r.external_id,
  distributorId: r.scope_key.startsWith("distributor:") ? Number(r.scope_key.slice(12)) : null,
  dmsId: type === "PAYMENT_MODE" ? null : r.dms_entity_id, dmsValue: r.dms_value || null, updatedAt: r.updatedAt,
});

async function list(db, tenantKey, conn, q = {}) {
  const type = typeOf(q.type);
  const where = { tenant_key: tenantKey, connection_id: conn.id, entity_type: TYPES[type].entityType };
  const did = V.posInt(q.distributorId, "distributorId");
  if (TYPES[type].scoped && did) where.scope_key = scopeKeyOf(type, did);
  const { page, pageSize, offset } = V.paging(q, { defaultSize: 50, maxSize: 200 });
  const { rows, count } = await db.ErpExternalLink.findAndCountAll({ where, order: [["id", "DESC"]], limit: pageSize, offset });
  return { type, label: TYPES[type].label, items: rows.map((r) => present(r, type)), page, pageSize, total: count };
}

async function upsert(db, tenantKey, adminId, conn, body = {}) {
  const type = typeOf(body.type);
  const def = TYPES[type];
  const code = cleanCode(body.externalCode);
  let did = null; let dmsId = 0; let dmsValue = null;
  if (def.scoped) {
    did = intId(body.distributorId);
    if (!did) throw err(400, "VALIDATION_FAILED", "Choose the distributor this mapping belongs to.", { field: "distributorId" });
    if (!(await db.Distributor.findByPk(did))) throw err(400, "VALIDATION_FAILED", "The selected distributor does not exist.", { field: "distributorId" });
    dmsId = intId(body.dmsId);
    if (!dmsId) throw err(400, "VALIDATION_FAILED", `Choose the DMS ${def.dmsLabel}.`, { field: "dmsId" });
    await assertDmsRow(db, type, did, dmsId);
  } else {
    dmsValue = String(body.dmsValue || "").trim().toUpperCase();
    if (!db.PAYMENT_MODES.includes(dmsValue)) throw err(400, "VALIDATION_FAILED", `dmsValue must be one of ${db.PAYMENT_MODES.join(", ")}`, { field: "dmsValue" });
  }
  const where = { connection_id: conn.id, entity_type: def.entityType, external_id: code, scope_key: scopeKeyOf(type, did) };
  const ex = await db.ErpExternalLink.findOne({ where });
  const fields = { dms_entity_id: dmsId, dms_value: dmsValue, content_hash: null, last_synced_at: new Date() };
  const row = ex ? await ex.update(fields) : await db.ErpExternalLink.create({ ...where, tenant_key: tenantKey, ...fields });
  audit.record(db, { event: "ERP_CODE_MAPPING_UPDATED", adminId, tenantKey, conn, entityType: def.entityType, entityId: row.id, metadata: { type, externalCode: code, distributorId: did, dmsId: dmsId || undefined, dmsValue: dmsValue || undefined, replaced: Boolean(ex) } });
  return present(row, type);
}

async function remove(db, tenantKey, adminId, conn, mappingId) {
  const row = await db.ErpExternalLink.findOne({ where: { id: intId(mappingId) || -1, tenant_key: tenantKey, connection_id: conn.id } });
  const type = row && TYPE_KEYS.find((k) => TYPES[k].entityType === row.entity_type);
  if (!row || !type) return null; // only code mappings can be removed here — never a synced record's identity link
  await row.destroy();
  audit.record(db, { event: "ERP_CODE_MAPPING_UPDATED", adminId, tenantKey, conn, entityType: row.entity_type, entityId: row.id, metadata: { type, externalCode: row.external_id, removed: true } });
  return { deleted: true };
}

/** For targets. ctx = { connectionId, tenantKey }. Returns { dmsId, dmsValue } or null. */
async function resolve(db, ctx, type, externalCode, distributorId, t) {
  const def = TYPES[type];
  const link = await db.ErpExternalLink.findOne({ where: { tenant_key: ctx.tenantKey, connection_id: ctx.connectionId, entity_type: def.entityType, external_id: String(externalCode), scope_key: scopeKeyOf(type, distributorId) }, transaction: t });
  return link ? { dmsId: link.dms_entity_id, dmsValue: link.dms_value || null } : null;
}
/** Like resolve, but a missing mapping is a BUSINESS_DECISION_REQUIRED per-record error (never a guess, never a default). */
async function require_(db, ctx, type, externalCode, distributorId, t) {
  const hit = await resolve(db, ctx, type, externalCode, distributorId, t);
  if (!hit) throw new ErpIntegrationError("BUSINESS_DECISION_REQUIRED", { message: `ERP ${TYPES[type].label.toLowerCase()} code "${externalCode}" has no DMS mapping. Add it under Code mappings; the DMS does not guess it.` });
  return hit;
}

const describe = () => TYPE_KEYS.map((k) => ({ type: k, label: TYPES[k].label, scoped: TYPES[k].scoped, dmsLabel: TYPES[k].dmsLabel }));
module.exports = { TYPES, TYPE_KEYS, list, upsert, remove, resolve, require: require_, describe };
