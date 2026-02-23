/**
 * Migration: Customer traffic + cleaning supply flags
 * Run: node migrations/2026-02-19_add_customer_traffic.js
 */

const { pool } = require("../db");

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("🚀 Creating customer traffic tables and flags...");
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_traffic_daily (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        date DATE NOT NULL,
        customer_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(restaurant_id, date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_traffic_events (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delta INTEGER NOT NULL,
        table_id INTEGER NULL,
        order_id INTEGER NULL,
        source TEXT NULL,
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_traffic_daily_restaurant ON customer_traffic_daily(restaurant_id);
      CREATE INDEX IF NOT EXISTS idx_customer_traffic_daily_date ON customer_traffic_daily(date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_traffic_events_order_unique
        ON customer_traffic_events(restaurant_id, order_id)
        WHERE order_id IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS traffic_logged_at TIMESTAMPTZ NULL;
    `);

    await client.query(`
      ALTER TABLE products
        ADD COLUMN IF NOT EXISTS is_cleaning_supply BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Stock movements link to stock rows, so mark cleaning supplies at stock level too.
    await client.query(`
      ALTER TABLE stock
        ADD COLUMN IF NOT EXISTS is_cleaning_supply BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query("COMMIT");
    console.log("✅ Customer traffic + cleaning flags migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
