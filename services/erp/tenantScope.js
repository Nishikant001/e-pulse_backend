// services/erp/tenantScope.js — the ONE place that decides which tenant an ERP request belongs to.
//
// The tenant comes from the AUTHENTICATED Admin session — never from req.body, req.query, req.params or a header, so a client
// cannot ask for another tenant's connections. Today the Admin portal is a single company-side identity (admin_users has no
// tenant column), so every admin resolves to the one configured company key (ERP_TENANT_KEY, default "DEFAULT"). When admin
// users gain a tenant/company, set `tenantKey` on the session object in middleware/adminAuth.js — nothing else changes:
// every ERP query already filters on this value.
const KEY = /^[A-Za-z0-9_-]{1,40}$/;

function resolveTenantKey(req) {
  const fromSession = req && req.admin && req.admin.tenantKey;
  const key = String(fromSession || process.env.ERP_TENANT_KEY || "DEFAULT");
  if (!KEY.test(key)) throw new Error("Invalid ERP tenant key");
  return key;
}

module.exports = { resolveTenantKey };
