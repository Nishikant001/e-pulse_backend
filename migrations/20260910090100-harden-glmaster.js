"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add "equity" as a valid account type — the ENUM previously only
    // covered asset/liability/income/expense. Equity itself is derived
    // (Assets - Liabilities) in this phase rather than tracked via its
    // own posted entries, but the account type should still be
    // selectable in GL Master for when that's needed.
    await queryInterface.changeColumn("glmasters", "gl_type", {
      type: Sequelize.ENUM("asset", "liability", "equity", "income", "expense"),
      allowNull: false,
    });

    await queryInterface.addIndex("glmasters", ["distributor_code", "gl_name"], {
      name: "uniq_glmaster_name_per_distributor",
      unique: true,
    });
    await queryInterface.addIndex("glmasters", ["distributor_code", "gl_type"], {
      name: "idx_glmaster_distributor_type",
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex("glmasters", "idx_glmaster_distributor_type");
    await queryInterface.removeIndex("glmasters", "uniq_glmaster_name_per_distributor");
    await queryInterface.changeColumn("glmasters", "gl_type", {
      type: Sequelize.ENUM("asset", "liability", "income", "expense"),
      allowNull: false,
    });
  },
};
