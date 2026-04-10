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
    `CREATE TABLE IF NOT EXISTS qr_customer_oauth_accounts (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      email TEXT,
      full_name TEXT,
      raw_profile JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_provider_user_idx ON qr_customer_oauth_accounts (restaurant_id, provider, provider_user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_customer_provider_idx ON qr_customer_oauth_accounts (restaurant_id, customer_id, provider)`,
    `CREATE TABLE IF NOT EXISTS marketplace_customers (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT,
      password_hash TEXT NOT NULL,
      language TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_phone_norm_idx ON marketplace_customers ((regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'))) WHERE COALESCE(phone, '') <> ''`,
    `CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_email_norm_idx ON marketplace_customers ((LOWER(TRIM(COALESCE(email, ''))))) WHERE COALESCE(email, '') <> ''`,
    `ALTER TABLE marketplace_customers ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE marketplace_customers ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS qr_customer_email_otps (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      marketplace_customer_id INTEGER REFERENCES marketplace_customers(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      resend_count INTEGER NOT NULL DEFAULT 0,
      request_ip TEXT,
      user_agent TEXT,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS qr_customer_email_otps_lookup_idx ON qr_customer_email_otps (restaurant_id, email, purpose, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS qr_customer_email_otps_active_idx ON qr_customer_email_otps (restaurant_id, email, consumed_at, expires_at)`,
    `CREATE TABLE IF NOT EXISTS qr_customer_phone_otps (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      marketplace_customer_id INTEGER REFERENCES marketplace_customers(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      normalized_phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'checkout_contact',
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      resend_count INTEGER NOT NULL DEFAULT 0,
      request_ip TEXT,
      user_agent TEXT,
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_lookup_idx ON qr_customer_phone_otps (restaurant_id, normalized_phone, purpose, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_active_idx ON qr_customer_phone_otps (restaurant_id, normalized_phone, consumed_at, expires_at)`,
    `CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_ip_idx ON qr_customer_phone_otps (restaurant_id, request_ip, created_at DESC)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketplace_customer_id INTEGER REFERENCES marketplace_customers(id) ON DELETE SET NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT`,
    `CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders (customer_id)`,
    `CREATE INDEX IF NOT EXISTS orders_marketplace_customer_id_idx ON orders (marketplace_customer_id)`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}

module.exports = { ensureMinimalSchema };
