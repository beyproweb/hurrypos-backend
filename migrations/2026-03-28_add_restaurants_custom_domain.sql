ALTER TABLE restaurants
ADD COLUMN IF NOT EXISTS custom_domain TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_custom_domain_unique_idx
ON restaurants (lower(custom_domain))
WHERE custom_domain IS NOT NULL AND btrim(custom_domain) <> '';
