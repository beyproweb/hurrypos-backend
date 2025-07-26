const { Pool, types } = require("pg");

// 🧠 OID for PostgreSQL DATE type
const DATE_OID = 1082;

// ✋ Prevent auto-conversion of DATE to JS Date object (UTC)
types.setTypeParser(DATE_OID, (val) => val); // Return raw 'YYYY-MM-DD' string

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "hurrypos",
  password: "1234",
  port: 5432, // default PostgreSQL port
});

module.exports = { pool };
