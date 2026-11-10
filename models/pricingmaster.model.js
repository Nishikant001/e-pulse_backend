module.exports = (sequelize, DataTypes) => {
  const PricingMaster = sequelize.define(
    "PricingMaster",
    {
      productId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      customer_group_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      base_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },

      discount_percent: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0,
      },

      valid_from: {
        type: DataTypes.DATE,
        allowNull: false,
      },

      valid_to: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      distributor_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      indexes: [
        {
          unique: true,
          fields: [
            "productId",
            "customer_group_id",
            "distributor_id",
          ],
        },
      ],
    }
  );

  return PricingMaster;
};
