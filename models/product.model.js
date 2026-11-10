// models/Product.js
module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define('Product', {
    material_code: {
      type: DataTypes.STRING(6),
      unique: true
    },
    name: DataTypes.STRING,
    description: DataTypes.STRING,
    unit: DataTypes.STRING,               // UoM - e.g. PCS, BOX, TAB
    category: DataTypes.STRING, 
    mfg_by: DataTypes.STRING,
    plant: DataTypes.STRING,
    weight: DataTypes.STRING,
    drug_licence_number: DataTypes.STRING,
    country_of_origin: DataTypes.STRING,
   hsn_id: {
  type: DataTypes.INTEGER,
  allowNull: false
}
,
    // GST rates (%). These columns already exist in the database via a
    // prior migration (20250814113459-add-tax-fields-to-products.js) but
    // were never exposed on the Sequelize model, so nothing could ever
    // read/write them — restoring them here so tax.service.js has a real
    // authoritative source instead of the various ad-hoc/undefined
    // `product.cgst` references that existed before Phase 3.
    gst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    cgst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    sgst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    igst: { type: DataTypes.DECIMAL(5, 2), allowNull: true },

    // Threshold below which the product is flagged as "low stock" on
    // inventory screens. Does not affect stock movement validation.
    reorder_level: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 10,
    },

    // Phase 7 (Product Master) — additive. `material_code` already serves as both the internal product code and
    // SKU (unique, auto-generated above), so no separate `sku` column is introduced here.
    generic_name: { type: DataTypes.STRING(150), allowNull: true },
    brand: { type: DataTypes.STRING(150), allowNull: true },
    dosage_form: { type: DataTypes.STRING(50), allowNull: true }, // e.g. Tablet, Capsule, Syrup, Injection
    strength: { type: DataTypes.STRING(50), allowNull: true },    // e.g. "500mg", "10mg/ml"
    pack_size: { type: DataTypes.STRING(50), allowNull: true },   // e.g. "10x10", "100ml bottle"
    mrp: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    sale_price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    status: {
      type: DataTypes.ENUM("active", "inactive"),
      allowNull: false,
      defaultValue: "active",
    },

    distributor_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    }
  });

    // Auto-generate material_code before creating
  Product.beforeCreate(async (product, options) => {
    const lastProduct = await Product.findOne({
      order: [["id", "DESC"]],
    });

    let newNumber = 1;
    if (lastProduct && lastProduct.material_code) {
      const lastNumber = parseInt(lastProduct.material_code.replace("MTC", ""), 10);
      newNumber = lastNumber + 1;
    }

    product.material_code = "MTC" + newNumber.toString().padStart(3, "0");
  });

  Product.associate = (models) => {
    Product.hasMany(models.Batch, { foreignKey: "productId",as: "batches" ,onDelete: "CASCADE", });
  };



  return Product;
};
