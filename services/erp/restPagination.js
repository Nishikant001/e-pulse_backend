// services/erp/restPagination.js — provider-neutral paging for REST-style ERPs. Each strategy turns the capability's pagination
// settings into a request, and the response into the generic { nextCursor, hasMore } the engine consumes. The engine never sees
// page numbers, offsets or URLs — only an opaque cursor it hands back to the provider.
const { getPath } = require("./providerConfig");
const asNumber = (v) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function buildPageRequest(pg, cursor, pageSize) {
  const p = pg || { type: "NONE" };
  const size = p.pageSize || pageSize;
  switch (p.type) {
    case "PAGE_NUMBER": return { query: { [p.pageParam || "page"]: cursor === null || cursor === undefined ? (p.startPage ?? 1) : cursor, [p.sizeParam || "pageSize"]: size } };
    case "OFFSET_LIMIT": return { query: { [p.offsetParam || "offset"]: cursor || 0, [p.limitParam || "limit"]: size } };
    case "NEXT_URL": return cursor ? { url: String(cursor), query: {} } : { query: p.sizeParam ? { [p.sizeParam]: size } : {} };
    case "CURSOR": return { query: { ...(cursor ? { [p.cursorParam || "cursor"]: cursor } : {}), ...(p.sizeParam ? { [p.sizeParam]: size } : {}) } };
    default: return { query: {} };
  }
}
function readPageResult(pg, json, records, cursor, pageSize) {
  const p = pg || { type: "NONE" };
  const size = p.pageSize || pageSize;
  const total = asNumber(getPath(json, p.totalPath));
  switch (p.type) {
    case "PAGE_NUMBER": {
      const page = cursor === null || cursor === undefined ? (p.startPage ?? 1) : Number(cursor);
      const more = records.length > 0 && (total !== null ? (page - (p.startPage ?? 1) + 1) * size < total : records.length >= size);
      return { nextCursor: more ? page + 1 : null, hasMore: more, total };
    }
    case "OFFSET_LIMIT": {
      const next = (Number(cursor) || 0) + records.length;
      const more = records.length > 0 && (total !== null ? next < total : records.length >= size);
      return { nextCursor: more ? next : null, hasMore: more, total };
    }
    case "NEXT_URL": { const n = getPath(json, p.nextPath || "next"); const ok = typeof n === "string" && n.length > 0; return { nextCursor: ok ? n : null, hasMore: ok, total }; }
    case "CURSOR": { const n = getPath(json, p.cursorPath || "nextCursor"); const ok = (typeof n === "string" || typeof n === "number") && String(n).length > 0; return { nextCursor: ok ? String(n) : null, hasMore: ok, total }; }
    default: return { nextCursor: null, hasMore: false, total };
  }
}
module.exports = { buildPageRequest, readPageResult };
