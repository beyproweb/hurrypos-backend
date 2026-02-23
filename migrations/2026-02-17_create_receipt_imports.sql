CREATE TABLE IF NOT EXISTS receipt_imports (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  training_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  parsed_json_original JSONB,
  parsed_json_cleaned JSONB,
  ocr_raw_text_original TEXT,
  ocr_raw_text_edited TEXT,
  source_file_meta JSONB,
  corrections_meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_imports_transaction_unique
  ON receipt_imports (transaction_id);

CREATE INDEX IF NOT EXISTS receipt_imports_restaurant_supplier_idx
  ON receipt_imports (restaurant_id, supplier_id, created_at DESC);
