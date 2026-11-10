// Phase 10 — Scheme Engine. A scheme is an ADMIN-configured commercial rule. Products / distributors / retailers are
// referenced by ID only (no names are copied); applicability lives in three small link tables.
module.exports = (sequelize, DataTypes) => {
  const Scheme = sequelize.define(
    "Scheme",
    {
      scheme_code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(150), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      scheme_type: { type: DataTypes.ENUM("QUANTITY_FREE", "PERCENT_DISCOUNT", "FIXED_DISCOUNT"), allowNull: false },

      // Applicability. product_scope PRODUCTS → SchemeProducts rows; CATEGORY → `category` (matches Product.category).
      product_scope: { type: DataTypes.ENUM("PRODUCTS", "CATEGORY"), allowNull: false, defaultValue: "PRODUCTS" },
      category: { type: DataTypes.STRING(100), allowNull: true },
      distributor_scope: { type: DataTypes.ENUM("ALL", "SPECIFIC"), allowNull: false, defaultValue: "ALL" },
      retailer_scope: { type: DataTypes.ENUM("ALL", "SPECIFIC"), allowNull: false, defaultValue: "ALL" },

      // Rule. min/max_quantity bound the quantity considered; buy/free apply to QUANTITY_FREE only.
      min_quantity: { type: DataTypes.INTEGER, allowNull: true },
      max_quantity: { type: DataTypes.INTEGER, allowNull: true },
      buy_quantity: { type: DataTypes.INTEGER, allowNull: true },
      free_quantity: { type: DataTypes.INTEGER, allowNull: true },
      discount_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      max_discount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },

      valid_from: { type: DataTypes.DATEONLY, allowNull: false },
      valid_to: { type: DataTypes.DATEONLY, allowNull: true },
      status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" },
      // Lower number = higher precedence. Equal priority on the same product is a CONFLICT (nothing applied).
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },

      created_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      updated_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      status_changed_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "Schemes",
      indexes: [{ fields: ["status", "valid_from", "valid_to"] }, { fields: ["scheme_type"] }, { fields: ["category"] }],
    }
  );

  const SchemeProduct = sequelize.define(
    "SchemeProduct",
    { scheme_id: { type: DataTypes.INTEGER, allowNull: false }, product_id: { type: DataTypes.INTEGER, allowNull: false } },
    { tableName: "SchemeProducts", timestamps: false, indexes: [{ unique: true, fields: ["scheme_id", "product_id"] }, { fields: ["product_id"] }] }
  );
  const SchemeDistributor = sequelize.define(
    "SchemeDistributor",
    { scheme_id: { type: DataTypes.INTEGER, allowNull: false }, distributor_id: { type: DataTypes.INTEGER, allowNull: false } },
    { tableName: "SchemeDistributors", timestamps: false, indexes: [{ unique: true, fields: ["scheme_id", "distributor_id"] }, { fields: ["distributor_id"] }] }
  );
  const SchemeRetailer = sequelize.define(
    "SchemeRetailer",
    { scheme_id: { type: DataTypes.INTEGER, allowNull: false }, customer_id: { type: DataTypes.INTEGER, allowNull: false } },
    { tableName: "SchemeRetailers", timestamps: false, indexes: [{ unique: true, fields: ["scheme_id", "customer_id"] }, { fields: ["customer_id"] }] }
  );

  Scheme.hasMany(SchemeProduct, { foreignKey: "scheme_id", as: "products", onDelete: "CASCADE" });
  Scheme.hasMany(SchemeDistributor, { foreignKey: "scheme_id", as: "distributors", onDelete: "CASCADE" });
  Scheme.hasMany(SchemeRetailer, { foreignKey: "scheme_id", as: "retailers", onDelete: "CASCADE" });

  return { Scheme, SchemeProduct, SchemeDistributor, SchemeRetailer };
};
