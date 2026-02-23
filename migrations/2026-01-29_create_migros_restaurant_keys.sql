-- Migration: Create Migros restaurant API keys table
-- Date: 2026-01-29
-- Purpose: Store API keys and store mappings for Migros integration

-- Create table to store restaurant-level Migros API keys and store mappings
CREATE TABLE IF NOT EXISTS migros_restaurant_keys (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  api_key VARCHAR(255) NOT NULL,
  store_id BIGINT NOT NULL,
  store_group_id BIGINT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Add unique index on api_key to prevent duplicates across restaurants
  UNIQUE(api_key)
);

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_migros_keys_restaurant_id ON migros_restaurant_keys(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_migros_keys_store_id ON migros_restaurant_keys(store_id);
CREATE INDEX IF NOT EXISTS idx_migros_keys_active ON migros_restaurant_keys(is_active);

-- Add comment for documentation
COMMENT ON TABLE migros_restaurant_keys IS 'Stores Migros API keys and store/store_group mappings for each restaurant. Used for server-side API calls to Migros.';
COMMENT ON COLUMN migros_restaurant_keys.restaurant_id IS 'Beypro internal restaurant ID';
COMMENT ON COLUMN migros_restaurant_keys.api_key IS 'Migros API key (XApiKey header value)';
COMMENT ON COLUMN migros_restaurant_keys.store_id IS 'Migros store ID (used in API calls)';
COMMENT ON COLUMN migros_restaurant_keys.store_group_id IS 'Migros store group ID (chain/brand ID)';
COMMENT ON COLUMN migros_restaurant_keys.is_active IS 'Whether this key is currently active';
COMMENT ON COLUMN migros_restaurant_keys.synced_at IS 'Timestamp of last successful sync from Migros';
