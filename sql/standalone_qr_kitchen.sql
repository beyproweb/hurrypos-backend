-- Standalone QR Menu + Kitchen module
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS allowed_modules JSONB;
