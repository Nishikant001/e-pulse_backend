// services/erp/sync/transforms.js — the FIXED allow-list of value transformations a mapping may use. Mapping config can only
// NAME one of these; nothing from an ERP or from configuration is ever evaluated as code. Not implemented (document-only):
// currency conversion (needs rates) and arbitrary scripting.
const { ErpIntegrationError } = require("../erpErrors");

const fail = (name, why) => new ErpIntegrationError("MAPPING_ERROR", { message: `Transformation "${name}" failed: ${why}` });
const isEmpty = (v) => v === null || v === undefined || v === "";

const TRANSFORMS = {
  trim: (v) => String(v).trim(),
  uppercase: (v) => String(v).toUpperCase(),
  lowercase: (v) => String(v).toLowerCase(),
  strip_leading_zeros: (v) => { const s = String(v).trim(); return /^0+$/.test(s) ? "0" : s.replace(/^0+/, ""); },
  to_number: (v) => {
    const s = typeof v === "number" ? v : String(v).trim().replace(/,/g, "");
    const n = Number(s);
    if (s === "" || !Number.isFinite(n)) throw fail("to_number", "not a number");
    return n;
  },
  to_date: (v) => { // → YYYY-MM-DD
    const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v).trim());
    if (Number.isNaN(d.getTime())) throw fail("to_date", "not a valid date");
    return d.toISOString().slice(0, 10);
  },
  to_boolean: (v) => {
    const s = String(v).trim().toLowerCase();
    if (["true", "1", "yes", "y", "x"].includes(s)) return true;
    if (["false", "0", "no", "n", ""].includes(s)) return false;
    throw fail("to_boolean", "not a boolean");
  },
};
const TRANSFORM_NAMES = Object.keys(TRANSFORMS);

// "trim,uppercase" → ["trim","uppercase"], validated against the allow-list. Throws MAPPING_ERROR on an unknown name.
function parseTransformList(spec) {
  if (spec === undefined || spec === null || spec === "") return [];
  const list = (Array.isArray(spec) ? spec : String(spec).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (list.length > 5) throw new ErpIntegrationError("MAPPING_ERROR", { message: "At most 5 transformations per field." });
  list.forEach((n) => { if (!Object.prototype.hasOwnProperty.call(TRANSFORMS, n)) throw new ErpIntegrationError("MAPPING_ERROR", { message: `Unknown transformation "${n}". Allowed: ${TRANSFORM_NAMES.join(", ")}.` }); });
  return list;
}
// Empty values stay null (required-field validation decides what that means); otherwise transforms run in order.
function applyTransforms(value, names) {
  if (isEmpty(value)) return null;
  return names.reduce((v, n) => TRANSFORMS[n](v), value);
}

module.exports = { TRANSFORMS, TRANSFORM_NAMES, parseTransformList, applyTransforms };
