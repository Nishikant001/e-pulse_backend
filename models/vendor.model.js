// models/vendor.model.js
module.exports = (sequelize, DataTypes) => {
  const Vendor = sequelize.define(
    "Vendor",
    {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      vendor_code: {
        type: DataTypes.STRING(6),
        unique: true,
      },
      vendor_group: {
  type: DataTypes.STRING,
  allowNull: false,
},

      taxNumber: DataTypes.STRING,
      city: DataTypes.STRING,
      phone: DataTypes.STRING,
      email: DataTypes.STRING,
      region: DataTypes.STRING,
      country: DataTypes.STRING,
      street1: DataTypes.STRING,
      street2: DataTypes.STRING,
      postalCode: DataTypes.STRING,
      distributor_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      hooks: {
        async beforeCreate(vendor) {
          // Auto-generate vendor_code like VDR001
          const lastVendor = await Vendor.findOne({
            order: [["createdAt", "DESC"], ["id", "DESC"]], // Phase 22: id tie-breaker (MySQL createdAt is 1-second precision)
          });

          let nextNumber = 1;
          if (lastVendor && lastVendor.vendor_code) {
            const lastCode = lastVendor.vendor_code;
            const numPart = parseInt(lastCode.replace("VDR", ""), 10) || 0;
            nextNumber = numPart + 1;
          }

          vendor.vendor_code = "VDR" + String(nextNumber).padStart(3, "0");
        },
      },
    }
  );

  Vendor.associate = (models) => {
    Vendor.belongsTo(models.Distributor, {
      foreignKey: "distributor_id",
      as: "distributor",
      onDelete: "CASCADE",
    });
    Vendor.hasMany(models.Address, {
    foreignKey: "vendor_id",
    as: "addresses",
    onDelete: "CASCADE",
  });
  };

  return Vendor;
};
