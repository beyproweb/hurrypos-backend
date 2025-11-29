-- 🔍 DIAGNOSTIC QUERIES FOR MULTI-STOP ROUTE ISSUE

-- 1. Check if orders table has required columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'orders' 
AND column_name IN ('id', 'driver_id', 'restaurant_id', 'status', 'driver_status', 
                     'delivery_lat', 'delivery_lng', 'delivery_address', 'pos_location_lat', 'pos_location_lng')
ORDER BY ordinal_position;

-- 2. Check if point_of_sale table exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'point_of_sale'
LIMIT 10;

-- 3. Count all orders (check if data exists)
SELECT COUNT(*) as total_orders FROM orders;

-- 4. Count orders with assigned drivers
SELECT COUNT(*) as orders_with_driver FROM orders WHERE driver_id IS NOT NULL;

-- 5. Check orders assigned to driver 89 (your test driver)
SELECT 
  id, 
  order_number, 
  driver_id, 
  status, 
  driver_status,
  delivery_address,
  delivery_lat,
  delivery_lng,
  restaurant_id
FROM orders 
WHERE driver_id = 89 
LIMIT 10;

-- 6. Check the exact query the endpoint uses (simulating for driver 89, restaurant 1)
SELECT 
  o.id,
  o.order_number,
  o.customer_name,
  o.delivery_address,
  o.delivery_lat,
  o.delivery_lng,
  o.driver_id,
  o.driver_status,
  o.status,
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

-- 7. Check if point_of_sale has data
SELECT id, name, address, latitude, longitude 
FROM point_of_sale 
LIMIT 5;

-- 8. Check relationships: which restaurants have orders?
SELECT DISTINCT restaurant_id, COUNT(*) as order_count 
FROM orders 
GROUP BY restaurant_id 
ORDER BY order_count DESC;

-- 9. Check if orders table has 'pos_location_lat' and 'pos_location_lng' columns (might need migration)
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'orders' 
AND column_name LIKE '%location%'
ORDER BY column_name;

-- 10. Check orders with NULL delivery coordinates
SELECT COUNT(*) as null_delivery_coords 
FROM orders 
WHERE delivery_lat IS NULL OR delivery_lng IS NULL;

-- 11. Verify authentication: check users/restaurants
SELECT id, name, email, restaurant_id FROM users LIMIT 5;

-- 12. Check if a specific restaurant exists
SELECT id, name FROM point_of_sale WHERE id = 1;

-- 13. Full order details for a single order (to see actual structure)
SELECT * FROM orders WHERE id = 1 LIMIT 1;

-- 14. Check if there are orders in last 7 days
SELECT COUNT(*) as recent_orders 
FROM orders 
WHERE created_at >= NOW() - INTERVAL '7 days';
