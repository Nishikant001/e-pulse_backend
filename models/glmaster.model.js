module.exports = (sequelize, DataTypes) => {
  const GLMaster = sequelize.define("GLMaster", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    gl_name: { type: DataTypes.STRING, allowNull: false },

    gl_type: {
      type: DataTypes.ENUM("asset", "liability", "equity", "income", "expense"),
      allowNull: false
    },

    opening_balance: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    closing_balance: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    distributor_code: {
  type: DataTypes.STRING,
  allowNull: false
}

  }, {
    tableName: "glmasters",
    indexes: [
      { unique: true, name: "uniq_glmaster_name_per_distributor", fields: ["distributor_code", "gl_name"] },
    ],
  });

  return GLMaster;
};
