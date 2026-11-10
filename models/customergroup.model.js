module.exports = (sequelize, DataTypes) => {
  const CustomerGroup = sequelize.define(
    "CustomerGroup",
    {
      code: {
        type: DataTypes.STRING,
        allowNull: false, // RETAIL, WHOLESALE
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
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
          fields: ["code", "distributor_id"], // 🔥 IMPORTANT
        },
      ],
    }
  );

  return CustomerGroup;
};
