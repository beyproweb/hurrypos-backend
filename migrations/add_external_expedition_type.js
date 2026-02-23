const { pool } = require("../db");

async function migrate() {
  console.log("🚀 Adding orders.external_expedition_type column (if missing)...");
  try {
    await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS external_expedition_type TEXT
    `);
    console.log("✅ Migration complete.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

