-- Optimize hot order routes for multi-tenant workloads.
-- Safe to run multiple times.

-- Orders hot-path indexes
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_updated_at_desc
  ON orders (restaurant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status
  ON orders (restaurant_id, status);

-- Some deployments use table_number instead of table_id.
-- Create table_id index only when the column exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'table_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_restaurant_table_id ON orders (restaurant_id, table_id)';
  ELSE
    RAISE NOTICE 'Skipping idx_orders_restaurant_table_id: orders.table_id column not found';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_orders_driver_delivered_at_desc
  ON orders (driver_id, delivered_at DESC);

-- Partial index for "open" order scans used by kitchen/packet views
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_open_status_updated_at_desc
  ON orders (restaurant_id, updated_at DESC)
  WHERE LOWER(COALESCE(status, '')) NOT IN ('closed', 'cancelled', 'canceled');

-- Join acceleration for order item aggregation
CREATE INDEX IF NOT EXISTS idx_order_items_order_id
  ON order_items (order_id);

-- Cash register state lookup per tenant
CREATE INDEX IF NOT EXISTS idx_cash_register_logs_restaurant_created_at_desc
  ON cash_register_logs (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_register_logs_restaurant_type_created_at_desc
  ON cash_register_logs (restaurant_id, type, created_at DESC)
  WHERE type IN ('open', 'close');
