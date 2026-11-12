// services/superAdmin.service.js — Phase 25. Read-only overview for Super Admins: the company's admins, how many
// distributors each created (Distributors.created_by_admin_id), and network totals. password_hash is never selected.
const q = require("./salesQuery");

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const iso = (v) => (v ? new Date(v).toISOString() : null);
const runner = (db) => (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
const tbl = (m) => `\`${m.getTableName()}\``;


async function getOverview(db) {
  const run = runner(db);
  const D = tbl(db.Distributor);
  const C = tbl(db.Customer);

  const admins = await db.AdminUser.findAll({
    attributes: ["id", "name", "email", "role", "is_active", "last_login_at", "createdAt"],
    order: [["name", "ASC"], ["id", "ASC"]],
  });
  const perAdmin = await run(
    `SELECT created_by_admin_id AS adminId,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM ${D} WHERE created_by_admin_id IS NOT NULL GROUP BY created_by_admin_id`
  );
  const byAdmin = new Map(perAdmin.map((r) => [Number(r.adminId), r]));

  const [dist] = await run(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN created_by_admin_id IS NULL THEN 1 ELSE 0 END) AS unassigned
       FROM ${D}`
  );
  const [ret] = await run(`SELECT COUNT(*) AS total FROM ${C}`);

  const rows = admins.map((a) => {
    const s = byAdmin.get(Number(a.id)) || {};
    return {
      id: Number(a.id), name: a.name, email: a.email, role: a.role, isActive: !!a.is_active,
      lastLoginAt: iso(a.last_login_at), createdAt: iso(a.createdAt),
      distributorsCreated: num(s.total), activeDistributors: num(s.active), inactiveDistributors: num(s.inactive), pendingDistributors: num(s.pending),
    };
  });
  const activeAdmins = rows.filter((r) => r.isActive).length;
  return {
    totals: {
      admins: { total: rows.length, active: activeAdmins, inactive: rows.length - activeAdmins },
      distributors: { total: num(dist.total), active: num(dist.active), inactive: num(dist.inactive), pending: num(dist.pending), unassigned: num(dist.unassigned) },
      retailers: num(ret.total),
    },
    admins: rows,
    generatedAt: new Date().toISOString(),
  };
}

// → { admin: {id,name,email}, distributors: [...] } or null when the admin does not exist
async function listAdminDistributors(db, rawId) {
  const id = q.intId(rawId, "id");
  if (!id) throw new q.QueryError("id must be a positive integer");
  const admin = await db.AdminUser.findByPk(id, { attributes: ["id", "name", "email"] });
  if (!admin) return null;
  const rows = await db.Distributor.findAll({
    where: { created_by_admin_id: id },
    attributes: ["id", "distributor_code", "name", "city", "status", "createdAt"],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit: 1000,
  });
  return {
    admin: { id: Number(admin.id), name: admin.name, email: admin.email },
    distributors: rows.map((d) => ({ id: Number(d.id), code: d.distributor_code, name: d.name, city: d.city, status: d.status, createdAt: iso(d.createdAt) })),
  };
}


async function listNetworkDistributors(db) {
  const rows = await db.Distributor.findAll({
    attributes: ["id", "distributor_code", "name", "city", "region", "status", "created_by_admin_id", "createdAt"],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
  });
  const adminIds = [...new Set(rows.map((r) => Number(r.created_by_admin_id)).filter(Boolean))];
  const admins = adminIds.length
    ? await db.AdminUser.findAll({ where: { id: adminIds }, attributes: ["id", "name", "email"] })
    : [];
  const byId = new Map(admins.map((a) => [Number(a.id), a]));
  const customerCounts = rows.length
    ? await db.Customer.findAll({
        attributes: ["distributor_id", [db.sequelize.fn("COUNT", db.sequelize.col("id")), "count"]],
        where: { distributor_id: rows.map((r) => Number(r.id)) },
        group: ["distributor_id"],
        raw: true,
      })
    : [];
  const countByDistributor = new Map(customerCounts.map((r) => [Number(r.distributor_id), num(r.count)]));
  return rows.map((d) => {
    const owner = byId.get(Number(d.created_by_admin_id));
    return {
      id: Number(d.id),
      code: d.distributor_code || null,
      name: d.name || "",
      city: d.city || null,
      region: d.region || null,
      owner: owner ? owner.name : null,
      ownerEmail: owner ? owner.email : null,
      retailers: countByDistributor.get(Number(d.id)) || 0,
      status: d.status || "pending",
      createdAt: iso(d.createdAt),
    };
  });
}

async function listOnboardingRequests(db) {
  const rows = await db.Distributor.findAll({
    where: { status: "pending" },
    attributes: ["id", "distributor_code", "name", "contact_person", "email", "city", "region", "tax_no", "createdAt"],
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    limit: 1000,
  });
  return rows.map((d) => ({
    id: Number(d.id),
    code: d.distributor_code || null,
    business: d.name || "",
    contact: d.contact_person || null,
    email: d.email || null,
    city: d.city || null,
    region: d.region || null,
    taxNumber: d.tax_no || null,
    submittedAt: iso(d.createdAt),
    status: "pending",
  }));
}

module.exports = { getOverview, listAdminDistributors, listNetworkDistributors, listOnboardingRequests };

