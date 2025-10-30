const { Pool, types } = require("pg");

// 🧠 Keep DATE fields as text
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false, // Render certs aren't publicly trusted
  },
  max: 5,                     // keep it small for local dev
  idleTimeoutMillis: 30000,   // recycle idle after 30s
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("❌ Unexpected PG pool error:", err);
});

// 🧩 Optional: log which DB this backend is connected to
const safeUrl = (process.env.DATABASE_URL || "").replace(/:\/\/(.*:.*)@/, "://****:****@");
console.log("🗄️  Connected to PostgreSQL:", safeUrl);

module.exports = { pool };
