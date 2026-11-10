// services/salesQuery.js — strict parsing of list/filter query strings for the Admin sales endpoints.
// Everything returned is validated; unknown sort keys, bad dates and oversize values never reach SQL.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueryError";
    this.statusCode = 400;
  }
}

function day(v, name) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!ISO_DAY.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new QueryError(`${name} must be a valid date (YYYY-MM-DD)`);
  return s;
}

function intId(v, name) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new QueryError(`${name} must be a positive integer`);
  return n;
}

function text(v, name, max = 100) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new QueryError(`${name} is too long`);
  return s;
}

function oneOf(v, allowed, name, transform = (x) => x) {
  if (v === undefined || v === null || v === "") return null;
  const s = transform(String(v));
  if (!allowed.includes(s)) throw new QueryError(`${name} is not a valid value`);
  return s;
}

// Escape LIKE wildcards so a user typing "%" or "_" searches literally. "!" is the escape character
// (portable: SQL uses  LIKE :q ESCAPE '!'  on both MySQL and SQLite).
const likeTerm = (s) => `%${String(s).toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;

function paging(query, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? defaultSize : Number(query.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new QueryError("page must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxSize) throw new QueryError(`pageSize must be between 1 and ${maxSize}`);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function sorting(query, allowed, fallback) {
  const key = query.sort === undefined || query.sort === "" ? fallback.key : String(query.sort);
  if (!Object.prototype.hasOwnProperty.call(allowed, key)) throw new QueryError("sort is not a valid column");
  const dir = query.dir === undefined || query.dir === "" ? fallback.dir : String(query.dir).toLowerCase();
  if (dir !== "asc" && dir !== "desc") throw new QueryError("dir must be asc or desc");
  return { key, column: allowed[key], dir: dir.toUpperCase() };
}

module.exports = { QueryError, day, intId, text, oneOf, likeTerm, paging, sorting };
