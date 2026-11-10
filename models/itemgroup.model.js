module.exports = (sequelize, DataTypes) => {
  const ItemGroup = sequelize.define(
    "ItemGroup",
    {
      code: {
        type: DataTypes.STRING,
        allowNull: false,
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
          fields: ["code", "distributor_id"],
        },
      ],
    }
  );

  return ItemGroup;
};
