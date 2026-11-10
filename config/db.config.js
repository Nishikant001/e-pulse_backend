require("dotenv").config();

const isTest = process.env.NODE_ENV === "test";

module.exports = isTest
  ? {
      HOST: undefined,
      USER: undefined,
      PASSWORD: undefined,
      DB: undefined,
      dialect: "sqlite",
      storage: ":memory:",
      pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
    }
  : {
      HOST: process.env.DB_HOST,
      PORT: Number(process.env.DB_PORT) > 0 ? Number(process.env.DB_PORT) : undefined, // Phase 24: optional (driver default 3306)
      USER: process.env.DB_USER,
      PASSWORD: process.env.DB_PASSWORD,
      DB: process.env.DB_NAME,
      dialect: process.env.DB_DIALECT,

      pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
    };
