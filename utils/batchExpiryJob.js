const db = require("../models");

async function updateExpiredBatches() {
  await db.Batch.update(
    { status: "inactive" },
    {
      where: {
        exp_date: {
          [db.Sequelize.Op.lt]: new Date(),
        },
      },
    }
  );
}

module.exports = updateExpiredBatches;
