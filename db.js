const { Pool, types } = require("pg");
const fs = require("fs");
const path = require("path");

// DATE as text
types.setTypeParser(1082, (val) => val);

const pemPath = path.join(process.cwd(), "certs", "global-bundle.pem");

function parseOptionalBool(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

// Always print so we know what EB is running
console.log("🧾 DBJS VERSION: 2025-12-15-EB-FIX");
console.log("🧾 CWD:", process.cwd());
console.log("🧾 PEM path:", pemPath);
console.log("🧾 PEM exists:", fs.existsSync(pemPath));

const sslRejectUnauthorizedOverride = parseOptionalBool(process.env.PG_SSL_REJECT_UNAUTHORIZED);
let ssl;
if (fs.existsSync(pemPath)) {
  const ca = fs.readFileSync(pemPath, "utf8");
  console.log("🧾 PEM first line:", ca.split("\n")[0]);
  ssl = {
    ca,
    rejectUnauthorized:
      sslRejectUnauthorizedOverride === null ? true : sslRejectUnauthorizedOverride,
  };
} else {
  console.log("🧾 PEM missing -> TEMP insecure mode");
  ssl = {
    rejectUnauthorized:
      sslRejectUnauthorizedOverride === null ? false : sslRejectUnauthorizedOverride,
  };
}
console.log("🧾 PG_SSL_REJECT_UNAUTHORIZED override:", sslRejectUnauthorizedOverride);
console.log("🧾 Effective ssl.rejectUnauthorized:", ssl?.rejectUnauthorized);


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
