async function ensureMinimalSchema(pool) {
  // Keep this intentionally small: only columns that are referenced by routes
  // and are safe to add as nullable.
  const statements = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_token TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_callback_urls JSONB`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_source TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_origin TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_sync_error TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_expedition_type TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`,
    `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS allowed_modules JSONB`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}

module.exports = { ensureMinimalSchema };
