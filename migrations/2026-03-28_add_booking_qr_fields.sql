ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_token TEXT;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_url TEXT;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_image TEXT;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_status TEXT;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_last_error TEXT;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_ready_at TIMESTAMPTZ;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_qr_token_unique
ON orders (qr_token)
WHERE qr_token IS NOT NULL AND btrim(qr_token) <> '';

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_token TEXT;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_url TEXT;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_image TEXT;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_status TEXT;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_last_error TEXT;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_ready_at TIMESTAMPTZ;

ALTER TABLE concert_bookings
ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_concert_bookings_qr_token_unique
ON concert_bookings (qr_token)
WHERE qr_token IS NOT NULL AND btrim(qr_token) <> '';
