module.exports = (sequelize, DataTypes) => {
  const Invoice = sequelize.define(
    "Invoice",
    {
      invoiceNumber: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: "Unique invoice number for tracking",
      },

      invoiceDate: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: "Invoice creation date",
      },

      // Payment details
      total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: "Total invoice amount",
      },
      paymentAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
        comment: "Total payment made by the customer",
      },
      restAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
        comment: "Remaining balance to be paid",
      },
      restPaymentDueDate: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Due date for remaining payment",
      },

      // Additional invoice info
      placeOfSupply: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      vehicleNumber: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      receiverDetails: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      consigneeBilledTo: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      consigneeShippedTo: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // Foreign keys (handled via central associations)
      distributor_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      customer_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      salesOrderHeader_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      tableName: "invoices",
      timestamps: true,
      hooks: {
        beforeSave: (invoice) => {
          // Automatically calculate remaining amount before save
          if (invoice.total && invoice.paymentAmount != null) {
            invoice.restAmount = parseFloat(
              (invoice.total - invoice.paymentAmount).toFixed(2)
            );
          }
        },
      },
    }
  );

  return Invoice;
};
