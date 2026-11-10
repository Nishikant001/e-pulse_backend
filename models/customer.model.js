module.exports = (sequelize, DataTypes) => {
  const Customer = sequelize.define(
    "Customer",
    {
      name: DataTypes.STRING,
      taxNumber: DataTypes.STRING,
      city: DataTypes.STRING,
      alternatePhone: DataTypes.STRING,
      pincode: DataTypes.STRING,
      postalCode: DataTypes.STRING,
      region: DataTypes.STRING,
      resignDescription: DataTypes.TEXT,
      street1: DataTypes.STRING,
      street2: DataTypes.STRING,
      street3: DataTypes.STRING,
      street4: DataTypes.STRING,
      distributor_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    customer_group_id: {
  type: DataTypes.INTEGER,
  allowNull: false,
}
,
      customer_code: {
        type: DataTypes.STRING(6),
        unique: true,
      },
      // ── Phase 9 (Retailer Management) — added by migration 20261002090000-retailer-management-phase9 ──
      contact_person: DataTypes.STRING(150),
      phone_number: DataTypes.STRING(20),
      email: DataTypes.STRING(255),
      pan: DataTypes.STRING(10),
      territory: DataTypes.STRING(100),
      status: { type: DataTypes.ENUM("active", "inactive", "pending"), allowNull: false, defaultValue: "active" },
      status_reason: DataTypes.STRING(255),
      status_changed_at: DataTypes.DATE,
      // ── Phase 12 (Accounts) — added by migration 20261005090000-accounts-phase12. Retailers had no credit limit before; visibility only, not enforced.
      credit_limit: DataTypes.DECIMAL(14, 2),
    },
    {
      hooks: {
        async beforeCreate(customer) {
          // Find last customer
          const lastCustomer = await Customer.findOne({
            order: [["createdAt", "DESC"], ["id", "DESC"]], // Phase 22: id tie-breaker (MySQL createdAt is 1-second precision)
          });

          let nextNumber = 1;

          if (lastCustomer && lastCustomer.customer_code) {
            // Extract numeric part (after "CTR")
            const lastCode = lastCustomer.customer_code;
            const numPart = parseInt(lastCode.replace("CTR", ""), 10) || 0;
            nextNumber = numPart + 1;
          }

          // Format as CTR000001
          customer.customer_code = "CTR" + String(nextNumber).padStart(3, "0");
        },
      },
    },
  );

  Customer.associate = (models) => {
    Customer.hasMany(models.Address, {
      foreignKey: "customer_id",
      as: "addresses",
      onDelete: "CASCADE",
    });
    Customer.hasOne(models.Address, {
      foreignKey: "customer_id",
      as: "soldToParty",
      scope: { type: "sold_to_party" },
    });

    Customer.hasOne(models.Address, {
      foreignKey: "customer_id",
      as: "shipToParty",
      scope: { type: "ship_to_party" },
    });

    Customer.hasOne(models.Address, {
      foreignKey: "customer_id",
      as: "billToParty",
      scope: { type: "bill_to_party" },
    });

    Customer.hasOne(models.Address, {
      foreignKey: "customer_id",
      as: "payer",
      scope: { type: "payer" },
    });
  };

  return Customer;
};
