-- Multi-Stop Driver Routes - Database Optimization Script
-- Run this to add recommended indexes for the new endpoint

-- 1. Index for common driver query filter (driver_id + status)
CREATE INDEX IF NOT EXISTS idx_orders_driver_status 
ON orders(driver_id, status, driver_status)
WHERE status NOT IN ('closed', 'cancelled') 
  AND (driver_status IS NULL OR driver_status != 'delivered');

-- 2. Index for restaurant + driver combination (for filtering by restaurant)
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_driver 
ON orders(restaurant_id, driver_id);

-- 3. Index on estimated_delivery_time for sorting/filtering by ETA
CREATE INDEX IF NOT EXISTS idx_orders_estimated_delivery 
ON orders(estimated_delivery_time)
WHERE driver_id IS NOT NULL;

-- 4. Ensure point_of_sale has proper indexes
CREATE INDEX IF NOT EXISTS idx_point_of_sale_restaurant 
ON point_of_sale(restaurant_id);

-- Verify the indexes were created
\di
SELECT indexname, tablename FROM pg_indexes 
WHERE indexname LIKE 'idx_orders_%' OR indexname LIKE 'idx_point_of_sale_%';

-- Test query performance (EXPLAIN ANALYZE)
-- This shows how the database executes the active-orders query
EXPLAIN ANALYZE
SELECT 
  o.id,
  o.order_number,
  o.customer_name,
  o.customer_address,
  o.delivery_address,
  o.delivery_lat,
  o.delivery_lng,
  o.driver_id,
  o.driver_status,
  o.status,
  o.estimated_delivery_time,
  o.created_at,
  p.name as pos_name,
  p.latitude as pos_location_lat,
  p.longitude as pos_location_lng,
  p.address as pos_location
FROM orders o
LEFT JOIN point_of_sale p ON o.restaurant_id = p.id
WHERE o.restaurant_id = 1
  AND o.driver_id = 89
  AND o.status NOT IN ('closed', 'cancelled')
  AND (o.driver_status IS NULL OR o.driver_status NOT IN ('delivered'))
ORDER BY o.created_at ASC;
