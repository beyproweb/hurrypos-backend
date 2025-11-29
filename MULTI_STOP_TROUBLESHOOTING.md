# Multi-Stop Driver Route - Debugging Checklist

## Problem: Driver route not showing for multiple stops

Let's diagnose this step by step.

---

## ✅ STEP 1: Check Database Schema

Your database might be missing key columns or data. Run these queries:

```sql
-- Check if orders table has all required columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'orders'
ORDER BY column_name;

-- Check if point_of_sale table exists and has location data
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'point_of_sale'
ORDER BY column_name;
```

---

## ⚠️ POTENTIAL ISSUES & FIXES

### Issue 1: Missing `point_of_sale` Table

**Symptom**: JOIN fails, endpoint returns empty or error

**Fix**: Create the table if missing

```sql
CREATE TABLE IF NOT EXISTS point_of_sale (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  restaurant_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### Issue 2: orders Table Missing Coordinates

**Symptom**: `delivery_lat` and `delivery_lng` are NULL

**Fix**: Add columns if missing

```sql
-- Check if columns exist
SELECT * FROM information_schema.columns
WHERE table_name = 'orders'
AND column_name IN ('delivery_lat', 'delivery_lng');

-- If they don't exist, add them
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS delivery_lat DECIMAL(10, 8);

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS delivery_lng DECIMAL(11, 8);

-- Add sample data if needed (for testing)
UPDATE orders
SET
  delivery_lat = 40.7128,
  delivery_lng = -74.0060
WHERE delivery_lat IS NULL AND id <= 5;
```

---

### Issue 3: Missing Restaurant Location Data

**Symptom**: `pos_location_lat` and `pos_location_lng` return NULL in API response

**Fix**: Populate the `point_of_sale` table

```sql
-- Check if point_of_sale has data
SELECT COUNT(*) FROM point_of_sale;

-- If empty, insert sample restaurants
INSERT INTO point_of_sale (name, address, latitude, longitude) VALUES
  ('Main Restaurant', '123 Main St, New York', 40.7100, -74.0050),
  ('Downtown Café', '456 Broadway, New York', 40.7505, -73.9972),
  ('Uptown Bistro', '789 Park Ave, New York', 40.7750, -73.9730)
ON CONFLICT (id) DO NOTHING;
```

---

### Issue 4: No Orders Assigned to Driver

**Symptom**: Endpoint returns empty array `[]`

**Fix**: Assign orders to driver 89

```sql
-- Check current assignments
SELECT COUNT(*) FROM orders WHERE driver_id = 89;

-- Assign some test orders to driver 89
UPDATE orders
SET driver_id = 89, driver_status = NULL
WHERE driver_id IS NULL
AND status NOT IN ('closed', 'cancelled')
LIMIT 5;

-- Verify
SELECT id, order_number, driver_id, delivery_address
FROM orders
WHERE driver_id = 89
LIMIT 5;
```

---

### Issue 5: Orders Filtered Out (Status Issue)

**Symptom**: Orders exist but endpoint still returns `[]`

**Fix**: Check order status filtering

```sql
-- Check what statuses exist
SELECT DISTINCT status FROM orders ORDER BY status;

-- Check driver_status values
SELECT DISTINCT driver_status FROM orders ORDER BY driver_status;

-- Find orders that WILL be returned (matching endpoint filter)
SELECT COUNT(*) as matching_orders
FROM orders
WHERE driver_id = 89
  AND status NOT IN ('closed', 'cancelled')
  AND (driver_status IS NULL OR driver_status NOT IN ('delivered'));

-- If count is 0, check why
SELECT DISTINCT status, driver_status, COUNT(*)
FROM orders
WHERE driver_id = 89
GROUP BY status, driver_status;
```

---

## 🔧 COMPLETE SETUP QUERY

If your database is brand new or needs complete setup, run this:

```sql
-- 1. Ensure point_of_sale exists with proper data
CREATE TABLE IF NOT EXISTS point_of_sale (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Add delivery coordinates to orders if missing
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS delivery_lat DECIMAL(10, 8),
ADD COLUMN IF NOT EXISTS delivery_lng DECIMAL(11, 8);

-- 3. Populate point_of_sale with sample restaurants
INSERT INTO point_of_sale (name, address, latitude, longitude)
VALUES
  ('Main Branch', '123 Main Street', 40.7128, -74.0060),
  ('Downtown Location', '456 Broadway', 40.7505, -73.9972),
  ('Uptown Hub', '789 Park Avenue', 40.7750, -73.9730)
ON CONFLICT (id) DO NOTHING;

-- 4. Create/update sample orders with proper data
-- First, ensure orders have valid delivery coordinates
UPDATE orders
SET
  delivery_lat = CASE
    WHEN MOD(id, 3) = 0 THEN 40.7260
    WHEN MOD(id, 3) = 1 THEN 40.7489
    ELSE 40.7614
  END,
  delivery_lng = CASE
    WHEN MOD(id, 3) = 0 THEN -73.9897
    WHEN MOD(id, 3) = 1 THEN -73.9680
    ELSE -73.9776
  END,
  driver_status = NULL,
  status = 'pending'
WHERE delivery_lat IS NULL
  AND id <= 20;

-- 5. Assign some orders to driver 89 for testing
UPDATE orders
SET driver_id = 89
WHERE id IN (1, 2, 3, 4, 5)
  AND status = 'pending';

-- 6. Verify setup
SELECT
  (SELECT COUNT(*) FROM orders) as total_orders,
  (SELECT COUNT(*) FROM orders WHERE driver_id = 89) as driver_89_orders,
  (SELECT COUNT(*) FROM point_of_sale) as restaurants,
  (SELECT COUNT(*) FROM orders WHERE delivery_lat IS NOT NULL) as orders_with_coords;
```

---

## 🧪 TESTING

### Test 1: Verify Backend Endpoint

```bash
# Get a JWT token first (login or use test token)
curl -X GET \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/api/drivers/89/active-orders
```

**Expected Response** (example):

```json
[
  {
    "id": 1,
    "order_number": "ORD-001",
    "customer_name": "John",
    "delivery_address": "123 Delivery St",
    "delivery_lat": 40.726,
    "delivery_lng": -73.9897,
    "driver_id": 89,
    "driver_status": null,
    "status": "pending",
    "pos_name": "Main Branch",
    "pos_location": "123 Main Street",
    "pos_location_lat": 40.7128,
    "pos_location_lng": -74.006
  }
]
```

### Test 2: Check Frontend Logs

Open the mobile app map in DevTools and check:

```
- "✅ Found X active orders for driver 89" → data is being fetched
- "🔍 DEBUG: First order from backend:" → shows the structure
- No "⚠️ Primary endpoint not available" → endpoint exists
```

---

## 📋 Quick Checklist

- [ ] Backend server is running (`npm start`)
- [ ] Database credentials are correct in `.env`
- [ ] `point_of_sale` table exists with sample data
- [ ] `orders` table has `delivery_lat` and `delivery_lng` columns
- [ ] At least 2+ orders assigned to driver 89
- [ ] Orders have status NOT IN ('closed', 'cancelled')
- [ ] Orders have driver_status IS NULL or != 'delivered'
- [ ] API endpoint `/api/drivers/89/active-orders` returns JSON array
- [ ] Frontend receives the orders and logs "✅ Found X active orders"
- [ ] Map renders multiple stops with polyline

---

## 🚨 If Still Not Working

1. **Check Backend Logs**: Look for errors in `npm start` output
2. **Run Debug SQL**: Execute `DEBUG_MULTI_STOP.sql` to inspect data
3. **Test with Postman/Curl**: Call endpoint directly to verify response
4. **Check Frontend Console**: Open DevTools in expo and search for "active-orders"
