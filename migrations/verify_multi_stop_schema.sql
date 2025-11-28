-- Database Schema Verification for Multi-Stop Routes
-- Run these queries to verify your database structure

-- 1. Check if orders table exists and has required columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'orders' 
ORDER BY ordinal_position;

-- 2. Check if point_of_sale table exists and has location data
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'point_of_sale' 
ORDER BY ordinal_position;

-- 3. Verify data: Count active orders per driver
SELECT 
  driver_id,
  COUNT(*) as active_orders,
  MIN(created_at) as first_order,
  MAX(created_at) as latest_order
FROM orders
WHERE status NOT IN ('closed', 'cancelled')
  AND (driver_status IS NULL OR driver_status != 'delivered')
  AND driver_id IS NOT NULL
GROUP BY driver_id
ORDER BY active_orders DESC;

-- 4. Check a specific driver's orders (update driver_id = 89)
SELECT 
  o.id,
  o.order_number,
  o.customer_name,
  o.delivery_address,
  o.delivery_lat,
  o.delivery_lng,
  o.driver_status,
  o.status,
  o.estimated_delivery_time,
  p.name as restaurant_name,
  p.address as restaurant_address,
  p.latitude as restaurant_lat,
  p.longitude as restaurant_lng
FROM orders o
LEFT JOIN point_of_sale p ON o.restaurant_id = p.id
WHERE o.driver_id = 89
  AND o.status NOT IN ('closed', 'cancelled')
LIMIT 5;

-- 5. Verify indexes exist
SELECT 
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('orders', 'point_of_sale')
ORDER BY tablename, indexname;

-- 6. Check point_of_sale records (restaurants)
SELECT 
  id,
  name,
  address,
  latitude,
  longitude
FROM point_of_sale
LIMIT 5;

-- 7. Sample query that the endpoint uses (for testing)
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

-- 8. Check if all required columns exist for the endpoint
WITH column_check AS (
  SELECT 
    'orders' as table_name,
    CASE 
      WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='id') THEN 'OK'
      ELSE 'MISSING'
    END as id_col,
    CASE 
      WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='driver_id') THEN 'OK'
      ELSE 'MISSING'
    END as driver_id_col,
    CASE 
      WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_lat') THEN 'OK'
      ELSE 'MISSING'
    END as delivery_lat_col,
    CASE 
      WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_lng') THEN 'OK'
      ELSE 'MISSING'
    END as delivery_lng_col
)
SELECT * FROM column_check;
