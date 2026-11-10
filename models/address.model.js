module.exports = (sequelize, DataTypes) => {
  const Address = sequelize.define('Address', {
    type: { // sold_to_party, ship_to_party, bill_to_party, payer
      type: DataTypes.ENUM('sold_to_party', 'ship_to_party', 'bill_to_party', 'payer'),
      allowNull: false
    },
    street1: DataTypes.STRING,
    street2: DataTypes.STRING,
    street3: DataTypes.STRING,
    street4: DataTypes.STRING,
    city: DataTypes.STRING,
    pincode: DataTypes.STRING,
    postalCode: DataTypes.STRING,
    region: DataTypes.STRING,
    country: DataTypes.STRING
  });

  Address.associate = (models) => {
    Address.belongsTo(models.Customer, { foreignKey: 'customer_id', as: 'customer',onDelete: "CASCADE",  });
    // Vendor association → adds vendor_id column
    Address.belongsTo(models.Vendor, {
      foreignKey: 'vendor_id',
      as: 'vendor',
      onDelete: "CASCADE",
    });
  };
  

  return Address;
};
