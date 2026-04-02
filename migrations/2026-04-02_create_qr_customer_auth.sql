CREATE TABLE IF NOT EXISTS qr_customer_auth (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_restaurant_phone_idx
ON qr_customer_auth (restaurant_id, phone);

CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_customer_idx
ON qr_customer_auth (customer_id);
