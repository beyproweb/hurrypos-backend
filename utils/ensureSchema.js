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
    `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS custom_domain TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS restaurants_custom_domain_unique_idx ON restaurants (lower(custom_domain)) WHERE custom_domain IS NOT NULL AND btrim(custom_domain) <> ''`,
    `CREATE TABLE IF NOT EXISTS qr_customer_auth (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      language TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_restaurant_phone_idx ON qr_customer_auth (restaurant_id, phone)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_customer_idx ON qr_customer_auth (customer_id)`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}

module.exports = { ensureMinimalSchema };
