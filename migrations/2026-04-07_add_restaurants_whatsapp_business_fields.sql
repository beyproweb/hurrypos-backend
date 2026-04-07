ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS whatsapp_connected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_business_account_id TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_display_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_verified_name TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_token_type TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_connected_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_last_sync_at TIMESTAMP NULL;
