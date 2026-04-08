CREATE TABLE IF NOT EXISTS qr_customer_email_otps (
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
);

CREATE INDEX IF NOT EXISTS qr_customer_email_otps_lookup_idx
  ON qr_customer_email_otps (restaurant_id, email, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS qr_customer_email_otps_active_idx
  ON qr_customer_email_otps (restaurant_id, email, consumed_at, expires_at);
