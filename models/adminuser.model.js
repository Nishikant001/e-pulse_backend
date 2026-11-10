// models/adminuser.model.js
//
// Company-side (Admin portal) identity. Deliberately SEPARATE from Distributor:
//  - own table, own password hash, own JWT secret and cookie (see config/adminAuth.config.js)
//  - a Distributor login can never satisfy Admin authentication and vice-versa.
//
// Phase 3 scope: the minimum needed to protect the Admin dashboard. The `role` column is only a label for now;
// role-based permissions (RBAC) are a later phase and are NOT enforced from this column yet.
module.exports = (sequelize, DataTypes) => {
  const AdminUser = sequelize.define(
    "AdminUser",
    {
      name: { type: DataTypes.STRING(120), allowNull: false },
      email: { type: DataTypes.STRING(190), allowNull: false, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      role: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "ADMIN" },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: "admin_users" }
  );

  return AdminUser;
};
