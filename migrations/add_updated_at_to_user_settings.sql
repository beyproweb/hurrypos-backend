-- Migration: Add updated_at column to user_settings table
-- Purpose: Track when printer settings were last updated
-- Date: 2025-12-04

ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create index for faster queries on updated_at
CREATE INDEX IF NOT EXISTS user_settings_updated_at_idx ON user_settings(updated_at DESC);

-- Update existing rows to have updated_at set to current time
UPDATE user_settings 
SET updated_at = NOW() 
WHERE updated_at IS NULL;

-- Make the column NOT NULL going forward
ALTER TABLE user_settings
ALTER COLUMN updated_at SET NOT NULL;

SELECT 'Migration completed: added updated_at column to user_settings' as result;
