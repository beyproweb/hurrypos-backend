-- Migration: Create internal_settings table (global JSON config for dev panel)
-- Purpose: Store plan→modules mapping (and other internal configs) outside tenant settings
-- Date: 2025-12-22

CREATE TABLE IF NOT EXISTS internal_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS internal_settings_updated_at_idx
  ON internal_settings (updated_at DESC);

SELECT 'Migration completed: created internal_settings' AS result;

