module.exports = (sequelize, DataTypes) => {
  const Batch = sequelize.define("Batch", {
    batch_no: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    mfg_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    exp_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    life_remaining: {
      type: DataTypes.INTEGER, // days remaining
      allowNull: true,
    },

    purchase_price: {   // 🔥 renamed from price
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },

    // Phase 5 (additive): printed Maximum Retail Price per unit. Nullable — legacy batches have none, and the
    // UI shows "—" rather than inventing a value.
    mrp: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },

    distributor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
  type: DataTypes.ENUM("active", "inactive"),
  allowNull: false,
  defaultValue: "active",
},

  }, {
    validate: {
      // Phase 5: Expiry > Manufacturing. Enforced only when a date is being set/changed, so legacy rows that already
      // violate it (or have no dates) can still be updated for unrelated reasons (status, price) — see docs.
      datesOrdered() {
        if (!(this.isNewRecord || this.changed("mfg_date") || this.changed("exp_date"))) return;
        if (this.mfg_date && this.exp_date && new Date(this.exp_date) <= new Date(this.mfg_date)) {
          throw new Error("Expiry date must be after the manufacturing date");
        }
      },
    },
  });

  // ✅ Auto calculate remaining shelf life
 Batch.beforeSave((batch) => {
  const today = new Date();

  if (batch.exp_date) {
    const diffTime = new Date(batch.exp_date) - today;

    batch.life_remaining = Math.max(
      Math.ceil(diffTime / (1000 * 60 * 60 * 24)),
      0
    );

    // 🔥 AUTO INACTIVE IF EXPIRED
    if (new Date(batch.exp_date) < today) {
      batch.status = "inactive";
    }
  }
});


  Batch.associate = (models) => {
    Batch.belongsTo(models.Product, {
      foreignKey: "productId",
      as: "product",
      onDelete: "CASCADE",
    });

    Batch.belongsTo(models.Distributor, {
      foreignKey: "distributor_id",
      as: "distributor",
    });
  };

  return Batch;
};
