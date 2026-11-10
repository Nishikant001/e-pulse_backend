// utils/erpValidate.js — Phase 17. Small, dependency-free request validators shared by the ERP services. Every failure is an
// ErpApiError(400, VALIDATION_FAILED) with the offending field, so the controller answers with the standard error shape.
const { ErpApiError } = require("../services/erp/erpApiError");

const bad = (message, field) => new ErpApiError(400, "VALIDATION_FAILED", message, field ? { field } : undefined);
const MAX_WINDOW = 50000; // page × pageSize may never reach deeper than this many rows (deep OFFSETs scan and discard rows)

/** Positive integer from a query/body value; undefined/empty → fallback (or error when required). */
function posInt(v, name, { required = false, max = 2147483647 } = {}) {
  if (v === undefined || v === null || v === "") { if (required) throw bad(`${name} is required`, name); return undefined; }
  const n = Number(v);
  if (typeof v === "object" || !Number.isInteger(n) || n <= 0 || n > max) throw bad(`${name} must be a positive whole number`, name);
  return n;
}
/** Value must be one of `allowed` (case-insensitive when upper = true). Returns the canonical value or undefined. */
function oneOf(v, allowed, name, { upper = true } = {}) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad(`${name} is not valid`, name);
  const s = upper ? v.toUpperCase() : v;
  if (!allowed.includes(s)) throw bad(`${name} is not valid`, name);
  return s;
}
function text(v, name, { max = 100 } = {}) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad(`${name} must be text`, name);
  const s = v.trim();
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`, name);
  return s || undefined;
}
function bool(v, name) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).toLowerCase();
  if (!["true", "false"].includes(s)) throw bad(`${name} must be true or false`, name);
  return s === "true";
}
/** YYYY-MM-DD → Date at local start of day (end = true → last millisecond). */
function day(v, name, end = false) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0) : null;
  if (!d || Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) throw bad(`${name} must be a date (YYYY-MM-DD)`, name);
  return d;
}
/** Paging with a hard page-size cap and a bounded result window. */
function paging(query = {}, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = posInt(query.page, "page") || 1;
  const pageSize = Math.min(posInt(query.pageSize, "pageSize") || defaultSize, maxSize);
  if (page * pageSize > MAX_WINDOW + pageSize) throw bad("That page is too far into the result set. Narrow the filters instead.", "page");
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

module.exports = { posInt, oneOf, text, bool, day, paging, bad, MAX_WINDOW };
