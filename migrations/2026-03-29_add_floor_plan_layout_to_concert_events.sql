ALTER TABLE concert_events
ADD COLUMN IF NOT EXISTS floor_plan_layout JSONB;
