require("dotenv").config();

module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) > 0 ? Number(process.env.DB_PORT) : undefined,
    dialect: process.env.DB_DIALECT,
  },

  test: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) > 0 ? Number(process.env.DB_PORT) : undefined,
    dialect: process.env.DB_DIALECT,
  },

  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) > 0 ? Number(process.env.DB_PORT) : undefined,
    dialect: process.env.DB_DIALECT,
  },
};
