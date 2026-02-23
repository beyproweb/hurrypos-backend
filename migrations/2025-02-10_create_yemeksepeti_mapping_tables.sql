CREATE TABLE IF NOT EXISTS platform_product_map (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_product_id TEXT NOT NULL,
  beypro_product_id INTEGER NOT NULL,
  remote_code_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_product_map_unique
  ON platform_product_map (restaurant_id, platform, platform_product_id);

CREATE TABLE IF NOT EXISTS platform_extra_map (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_extra_id TEXT NOT NULL,
  beypro_extra_id INTEGER NOT NULL,
  remote_code_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_extra_map_unique
  ON platform_extra_map (restaurant_id, platform, platform_extra_id);

CREATE TABLE IF NOT EXISTS unmatched_platform_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  item_type TEXT NOT NULL,
  platform_item_id TEXT NOT NULL,
  platform_item_name TEXT,
  remote_code TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER,
  mapped_beypro_id INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS unmatched_platform_items_unique
  ON unmatched_platform_items (restaurant_id, platform, item_type, platform_item_id);

CREATE INDEX IF NOT EXISTS unmatched_platform_items_unresolved
  ON unmatched_platform_items (restaurant_id, platform)
  WHERE resolved_at IS NULL;
