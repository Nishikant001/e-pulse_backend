module.exports = (sequelize, DataTypes) => {
  const HSNGroup = sequelize.define(
    "HSNGroup",
    {
      hsn_code: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      gst_rate: {
        type: DataTypes.FLOAT,
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
          fields: ["hsn_code", "distributor_id"],
        },
      ],
    }
  );

  return HSNGroup;
};
