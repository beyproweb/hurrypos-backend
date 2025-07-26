const { Pool, types } = require("pg");

// 🧠 OID for PostgreSQL DATE type
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

module.exports = { pool };
