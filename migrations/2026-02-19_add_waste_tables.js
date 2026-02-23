/**
 * Migration: Create stock_batches and stock_movements (idempotent)
 * Run: node migrations/2026-02-19_add_waste_tables.js
 */

const { pool } = require("../db");

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("🚀 Creating waste tables (stock_batches, stock_movements)...");
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_batches (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        stock_id INTEGER REFERENCES stock(id) ON DELETE SET NULL,
        supplier_id INTEGER,
        supplier_name TEXT,
        batch_ref TEXT,
        expiry_date DATE,
        quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
        remaining_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
        cost_price NUMERIC(14,4),
        total_cost NUMERIC(14,2),
        source_transaction_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        stock_id INTEGER REFERENCES stock(id) ON DELETE SET NULL,
        batch_id INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
        movement_type TEXT NOT NULL DEFAULT 'waste',
        qty NUMERIC(14,3) NOT NULL,
        unit TEXT,
        cost_price NUMERIC(14,4),
        total_value NUMERIC(14,2),
        reason TEXT,
        notes TEXT,
        image_url TEXT,
        user_id INTEGER,
        manager_id INTEGER,
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_batches_restaurant ON stock_batches(restaurant_id);
      CREATE INDEX IF NOT EXISTS idx_stock_batches_stock ON stock_batches(stock_id);
      CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches(restaurant_id, expiry_date, remaining_quantity);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_restaurant ON stock_movements(restaurant_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_type_date ON stock_movements(restaurant_id, movement_type, created_at DESC);
    `);

    await client.query("COMMIT");
    console.log("✅ Waste tables ready.");
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
