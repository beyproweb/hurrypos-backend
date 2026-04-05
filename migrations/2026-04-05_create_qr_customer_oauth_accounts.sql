CREATE TABLE IF NOT EXISTS qr_customer_oauth_accounts (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_provider_user_idx
ON qr_customer_oauth_accounts (restaurant_id, provider, provider_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_customer_provider_idx
ON qr_customer_oauth_accounts (restaurant_id, customer_id, provider);
