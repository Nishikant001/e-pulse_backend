const db = require("../models");

const syncDB = async () => {
  const isDev = process.env.NODE_ENV === "development";
  const enableSync = process.env.DB_SYNC === "true";
  const enableAlter = process.env.DB_ALTER === "true";
  const enableForce = process.env.DB_FORCE === "true";

  if (!isDev) {
    console.log("🔒 Production: DB sync disabled");
    return;
  }

  if (!enableSync) {
    console.log("ℹ️ DB sync skipped");
    return;
  }

  if (enableForce) {
    console.log("⚠️ DB FORCE SYNC ENABLED — ALL TABLES WILL BE DROPPED");
    await db.sequelize.sync({ force: true });
    console.log("💥 DB force synced (fresh tables created)");
    return;
  }

  if (enableAlter) {
    await db.sequelize.sync({ alter: true });
    console.log("🔁 DB altered safely");
    return;
  }

  await db.sequelize.sync();
  console.log("✅ DB synced (no alter, no force)");
};

module.exports = syncDB;
