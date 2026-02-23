-- Migration: Add Migros Remote ID column to restaurants table
-- Date: 2026-01-21
-- Purpose: Enable Migros webhook mapping via external_migros_remote_id

-- Add column for Migros remote ID mapping
ALTER TABLE restaurants 
ADD COLUMN IF NOT EXISTS external_migros_remote_id TEXT;

-- Add unique index to prevent duplicate Migros remote IDs
-- Uses WHERE clause to allow NULL values (only enforces uniqueness on non-null, non-empty values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_external_migros_remote_id
ON restaurants (external_migros_remote_id)
WHERE external_migros_remote_id IS NOT NULL AND external_migros_remote_id <> '';

-- Add comment for documentation
COMMENT ON COLUMN restaurants.external_migros_remote_id IS 'Migros Yemek remote ID used for webhook mapping: /api/integrations/migros/order/:remoteId';
