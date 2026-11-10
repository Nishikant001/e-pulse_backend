// services/erp/sync/mapper.js — ERP-agnostic record mapping: normalized ERP record + this connection's mappings → { externalId, values }.
// No ERP field name is known here; everything comes from erp_entity_mappings rows (per connection + capability).
const crypto = require("crypto");
const { ErpIntegrationError } = require("../erpErrors");
const { getPath } = require("../providerConfig");
const { parseTransformList, applyTransforms } = require("./transforms");

const KEY_FIELD = "external_id"; // pseudo DMS field: the mapping row that identifies the record across systems

function mapRecord(record, mappings) {
  let externalId = null;
  for (const m of mappings) { // pre-pass: identify the record by its key even when another field fails to map
    if (m.is_key || m.dms_field === KEY_FIELD) { try { const v = applyTransforms(getPath(record, m.source_field), parseTransformList(m.transform)); if (v !== null && String(v).trim() !== "") externalId = String(v).trim().slice(0, 190); } catch (_) { /* reported by the main pass */ } }
  }
  try { return mapInner(record, mappings, (id) => { externalId = id; }); } catch (e) { if (e && externalId !== null && e.externalId === undefined) e.externalId = externalId; throw e; }
}

function mapInner(record, mappings, setId) {
  let externalId = null;
  const values = {};
  for (const m of mappings) {
    // Phase 16: LINE mapping for documents (e.g. sales orders). dms_field "lines.quantity" + source "Items.results[].Qty" → values.lines = [{ quantity }, …].
    // Generic: no document knowledge here; the target decides which line fields exist.
    const arr = /^(.+?)\[\]\.(.+)$/.exec(String(m.source_field || ""));
    if (arr && /^[a-z_]+\.[a-z_]+$/i.test(m.dms_field || "")) {
      const [group, sub] = m.dms_field.split(".");
      const items = getPath(record, arr[1]);
      const list = Array.isArray(items) ? items : [];
      values[group] = values[group] || list.map(() => ({}));
      list.forEach((it, i) => { values[group][i] = values[group][i] || {}; values[group][i][sub] = applyTransforms(getPath(it, arr[2]), parseTransformList(m.transform)); });
      continue;
    }
    const raw = getPath(record, m.source_field);
    const v = applyTransforms(raw, parseTransformList(m.transform));
    if (m.is_key || m.dms_field === KEY_FIELD) {
      if (v === null || String(v).trim() === "") throw new ErpIntegrationError("MAPPING_ERROR", { message: `The key field "${m.source_field}" is empty in this record.` });
      externalId = String(v).trim(); setId(externalId);
      if (externalId.length > 190) throw new ErpIntegrationError("MAPPING_ERROR", { message: "The external id is too long." });
    } else values[m.dms_field] = v;
  }
  if (externalId === null) throw new ErpIntegrationError("MAPPING_NOT_CONFIGURED", { message: "The mapping has no key field (external id)." });
  return { externalId, values };
}

// Stable hash of the mapped values → unchanged records are SKIPPED on the next run.
function contentHash(values) {
  const sorted = Object.keys(values).sort().reduce((o, k) => { o[k] = values[k]; return o; }, {});
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

module.exports = { mapRecord, contentHash, KEY_FIELD };
