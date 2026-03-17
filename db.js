const { Pool, types } = require("pg");

// DATE as text
types.setTypeParser(1082, (val) => val);

// Always print so we know what EB is running
console.log("🧾 DBJS VERSION: 2025-12-15-EB-FIX");
console.log("🧾 CWD:", process.cwd());
const ssl = { rejectUnauthorized: false };
console.log("🧾 Effective ssl config:", ssl);


const NODE_ENV = process.env.NODE_ENV || 'development';
const connectionString =
  NODE_ENV === 'production'
    ? process.env.DATABASE_URL
    : process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;

const useSSL = NODE_ENV === 'production' ? ssl : false;

const pool = new Pool({
  connectionString,
  ssl: useSSL,
  max: Number(process.env.PGPOOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 30000),
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INITIAL_DELAY_MS || 10000),
});

pool.on("error", (err) => console.error("❌ PG pool error:", err));

module.exports = { pool };
