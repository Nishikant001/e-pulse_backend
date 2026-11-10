// Phase 24 — read-only inventory of the REAL mounted routers (no DB, no network). Usage: node scripts/route-inventory.js [--json]
// For every route: method, full path, and the names of its middleware. Classifies Admin write routes by the guard in front of them.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "inventory-only";
const adminRouter = require("../routes/adminRoutes");
const distRouter = require("../routes/allRoutes");
const authMw = require("../middleware/auth.middleware");

function walk(router, prefix, out) {
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase());
      const mws = layer.route.stack.map((s) => (s.handle === authMw ? "authMiddleware" : s.name || "<anonymous>"));
      for (const m of methods) out.push({ method: m, path: prefix + layer.route.path, middleware: mws.slice(0, -1), handler: mws[mws.length - 1] });
    } else if (layer.name === "router" && layer.handle.stack) walk(layer.handle, prefix, out);
  }
  return out;
}
const admin = walk(adminRouter, "/api/admin", []);
const dist = walk(distRouter, "/api", []);
const isWrite = (r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method);
const hasRequireAdmin = (r) => r.middleware.includes("requireAdmin") || r.middleware.some((n) => /requireAdmin/.test(n));
const hasRoleGuard = (r) => r.middleware.some((n) => /erp|permission|role/i.test(n) && n !== "requireAdmin");
const adminWrites = admin.filter(isWrite);
const publicAdmin = admin.filter((r) => !hasRequireAdmin(r));
const sum = {
  adminRoutes: admin.length, adminWrites: adminWrites.length,
  adminPublic: publicAdmin.map((r) => `${r.method} ${r.path}`),
  adminWritesWithRoleGuard: adminWrites.filter((r) => hasRequireAdmin(r) && hasRoleGuard(r)).length,
  adminWritesWithoutRoleGuard: adminWrites.filter((r) => hasRequireAdmin(r) && !hasRoleGuard(r)).map((r) => `${r.method} ${r.path}`),
  distributorRoutes: dist.length,
  distributorUnauthenticated: dist.filter((r) => !r.middleware.includes("authMiddleware")).map((r) => `${r.method} ${r.path}`),
};
if (process.argv.includes("--json")) console.log(JSON.stringify({ sum, admin, dist }, null, 1));
else console.log(JSON.stringify(sum, null, 1));
