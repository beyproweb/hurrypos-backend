const { Pool, types } = require("pg");

// 🧠 Keep DATE fields as text
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (val) => val);

const isRender = process.env.DATABASE_URL?.includes("render.com");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : undefined,
  max: 10,                  // safe connection pool size
  idleTimeoutMillis: 30000, // recycle idle after 30s
  connectionTimeoutMillis: 5000, // fail fast if DB down
});

// 🛑 log unexpected errors
pool.on("error", (err) => {
  console.error("❌ Unexpected PG pool error:", err);
});

module.exports = { pool };
