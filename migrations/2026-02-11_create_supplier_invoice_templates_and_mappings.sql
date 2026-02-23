CREATE TABLE IF NOT EXISTS supplier_invoice_templates (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_templates_unique
  ON supplier_invoice_templates (restaurant_id, supplier_id);

CREATE INDEX IF NOT EXISTS supplier_invoice_templates_restaurant_idx
  ON supplier_invoice_templates (restaurant_id);

CREATE TABLE IF NOT EXISTS supplier_product_mappings (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  supplier_product_code TEXT NOT NULL DEFAULT '',
  supplier_product_name_normalized TEXT NOT NULL DEFAULT '',
  supplier_product_name_raw TEXT,
  ingredient_id INTEGER,
  ingredient_name TEXT NOT NULL,
  ingredient_unit TEXT NOT NULL,
  units_per_case NUMERIC,
  mapped_unit TEXT,
  conversion_multiplier NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_product_mappings_unique
  ON supplier_product_mappings (
    restaurant_id,
    supplier_id,
    supplier_product_code,
    supplier_product_name_normalized
  );

CREATE INDEX IF NOT EXISTS supplier_product_mappings_lookup_idx
  ON supplier_product_mappings (
    restaurant_id,
    supplier_id,
    supplier_product_code,
    supplier_product_name_normalized
  );
