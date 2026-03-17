const { Pool, types } = require("pg");

// DATE as text
types.setTypeParser(1082, (val) => val);

// Always print so we know what EB is running
console.log("🧾 DBJS VERSION: 2025-12-15-EB-FIX");
console.log("🧾 CWD:", process.cwd());
const NODE_ENV = process.env.NODE_ENV || "development";
const connectionString =
  NODE_ENV === "production"
    ? process.env.DATABASE_URL
    : process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;

function isLocalHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

let sanitizedConnectionString = connectionString;
let dbHost = "";
try {
  const parsed = new URL(connectionString);
  dbHost = parsed.hostname;
  // Prevent URL-level SSL params from overriding explicit TLS config below.
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("sslcert");
  parsed.searchParams.delete("sslkey");
  parsed.searchParams.delete("sslrootcert");
  parsed.searchParams.delete("ssl");
  sanitizedConnectionString = parsed.toString();
} catch (err) {
  console.warn("⚠️ Failed to parse DATABASE_URL, using raw connection string");
}

const useSSL = !isLocalHostname(dbHost) ? { rejectUnauthorized: false } : false;
console.log("🧾 DB host:", dbHost || "(unknown)");
console.log("🧾 Effective ssl config:", useSSL);

const pool = new Pool({
  connectionString: sanitizedConnectionString,
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
