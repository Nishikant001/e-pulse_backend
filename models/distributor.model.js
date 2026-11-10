// models/distributor.model.js
module.exports = (sequelize, DataTypes) => {
  const Distributor = sequelize.define('Distributor', {
    distributor_code: {
      type: DataTypes.STRING(6),
      unique: true
    },
    name: DataTypes.STRING,
    email: { type: DataTypes.STRING, unique: true },
    password: DataTypes.STRING,
    tax_no: DataTypes.STRING,
    city: DataTypes.STRING,
    street1: DataTypes.STRING,
    street2: DataTypes.STRING,
    street3: DataTypes.STRING,
    street4: DataTypes.STRING,
    postal_code: DataTypes.STRING,
    phone_number: DataTypes.STRING,
    pan: DataTypes.STRING,
    address: DataTypes.TEXT,
    country: DataTypes.STRING,
    region: DataTypes.STRING,
    // ── Phase 8 (Distributor Management) — added by migration 20261001090000-distributor-management-phase8 ──
    contact_person: DataTypes.STRING(150),
    territory: DataTypes.STRING(100), // explicit territory; when empty, reports fall back to city / region
    credit_limit: DataTypes.DECIMAL(14, 2), // informational master data — not enforced anywhere yet
    payment_terms: DataTypes.STRING(50),
    status: { type: DataTypes.ENUM("active", "inactive", "pending"), allowNull: false, defaultValue: "active" },
    status_reason: DataTypes.STRING(255),
    status_changed_at: DataTypes.DATE,
    // ── Phase 25 (Super Admin dashboard) — migration 20261012090000-super-admin-phase25. NULL = self-signup / pre-existing ──
    created_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
       reset_otp: {
  type: DataTypes.STRING,
  allowNull: true,
},
reset_otp_expiry: {
  type: DataTypes.DATE,
  allowNull: true,
},
  });

    // 🔹 Hook to auto-generate distributor_code
  Distributor.beforeCreate(async (distributor, options) => {
    const lastDistributor = await Distributor.findOne({
      order: [['createdAt', 'DESC'], ['id', 'DESC']] // Phase 22: id tie-breaker (MySQL createdAt is 1-second precision)
    });

    let nextCode = "DTC001"; // default first code

    if (lastDistributor && lastDistributor.distributor_code) {
      const lastCode = lastDistributor.distributor_code;
      const numPart = parseInt(lastCode.replace("DTC", ""), 10) || 0;
      const newNum = numPart + 1;
      nextCode = "DTC" + String(newNum).padStart(3, "0");
    }

    distributor.distributor_code = nextCode;
  });
  return Distributor;
};
