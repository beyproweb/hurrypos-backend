# Multi-Stop Driver Routes - Complete Deployment Checklist

## Pre-Deployment (Verification)

- [ ] Backend code added to `routes/drivers.js` (lines 85-154)

  ```bash
  grep -n "active-orders" routes/drivers.js
  ```

  Should show: `GET /:id/active-orders` endpoint exists

- [ ] Database schema verified using `verify_multi_stop_schema.sql`

  ```bash
  psql -U youruser -d yourdatabase -f migrations/verify_multi_stop_schema.sql
  ```

- [ ] Required orders table columns exist:

  - `id`, `order_number`, `driver_id`, `restaurant_id`
  - `customer_name`, `delivery_address`
  - `delivery_lat`, `delivery_lng`
  - `driver_status`, `status`, `estimated_delivery_time`

- [ ] Required point_of_sale table columns exist:

  - `id`, `name`, `address`
  - `latitude`, `longitude`

- [ ] Frontend code updated (should already be done):
  - `src/components/MapModal.tsx` - multi-stop rendering support
  - `src/utils/deliveryRouteService.ts` - graceful error handling

## Step 1: Backend Server Restart

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend

# Option A: If using npm
npm start

# Option B: If using pm2
pm2 restart hurrypos-backend

# Option C: If using Docker
docker restart hurrypos-backend
```

**Verification:**

```bash
# Check if backend is running (adjust port if needed)
curl http://localhost:3000/api/health

# Should return something like: {"status":"ok"}
```

## Step 2: Test Endpoint Directly

```bash
# Get a valid JWT token for testing
# Replace YOUR_TOKEN with actual token from login or test user

curl -X GET \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/api/drivers/89/active-orders

# Should return JSON array of orders like:
# [
#   {
#     "id": 123,
#     "order_number": "ORD-001",
#     "customer_name": "John Doe",
#     "delivery_address": "123 Main St",
#     "delivery_lat": 40.7128,
#     "delivery_lng": -74.0060,
#     "estimated_delivery_time": "2024-01-15T14:30:00Z",
#     "pos_location": {
#       "name": "Restaurant Name",
#       "address": "456 Restaurant Ave",
#       "latitude": 40.7100,
#       "longitude": -74.0050
#     }
#   }
# ]
```

## Step 3: Run Database Optimization (Optional but Recommended)

```bash
# Run indexes migration
psql -U youruser -d yourdatabase -f migrations/add_multi_stop_indexes.sql

# Verify indexes were created
psql -U youruser -d yourdatabase -c \
  "SELECT * FROM pg_indexes WHERE tablename IN ('orders', 'point_of_sale') ORDER BY tablename;"
```

## Step 4: Mobile App Frontend Testing

### Test 1: Single Driver with Multiple Orders

1. Assign multiple orders to driver ID 89 (or test driver ID)
2. Open mobile app as driver
3. Navigate to map screen
4. Verify:
   - ✅ All assigned orders appear as stops
   - ✅ Pickup location shown with yellow marker
   - ✅ Each delivery shown as green marker
   - ✅ Polyline connects all stops
   - ✅ Driver name appears in popup
   - ✅ ETA calculated for each stop

### Test 2: Error Handling

1. Stop backend server temporarily
2. Open map in mobile app
3. Verify:
   - ✅ Map still shows with single-stop route (graceful fallback)
   - ✅ No crash or error overlay
4. Restart backend server
5. Refresh map
6. Verify multi-stop route appears

### Test 3: Route Optimization

1. Assign 5+ orders to single driver
2. Check map performance:
   - ✅ Renders within 2 seconds
   - ✅ No lag when panning/zooming
   - ✅ Polyline calculates reasonable route

## Step 5: Monitoring & Validation

### Backend Logs

```bash
# Check for errors in backend logs
tail -100f logs/backend.log | grep -i "error\|active-orders"

# Look for:
# - No errors in active-orders queries
# - No authentication failures
# - No database connection issues
```

### Database Performance

```bash
# Check query performance
psql -U youruser -d yourdatabase -c \
  "EXPLAIN ANALYZE
   SELECT COUNT(*) FROM orders
   WHERE driver_id = 89
   AND status NOT IN ('closed', 'cancelled');"

# Should return <50ms for typical restaurant database
```

### Mobile App Analytics

- Monitor for crashes on map screen
- Track API response times
- Log any 404 or 500 errors from multi-stop endpoint

## Troubleshooting

### Issue: 404 Error on `/api/drivers/:id/active-orders`

**Solution:**

- Verify backend restarted: `curl http://localhost:3000/api/health`
- Check route exists: `grep -n "active-orders" routes/drivers.js`
- Restart backend again if needed

### Issue: Empty array returned (no orders)

**Solution:**

- Verify orders exist: `psql -c "SELECT COUNT(*) FROM orders WHERE driver_id = 89;"`
- Check status filtering: `SELECT DISTINCT status FROM orders;`
- Ensure orders have `driver_status != 'delivered'`

### Issue: "deliveries" or "pos_location" is undefined

**Solution:**

- Verify point_of_sale table has data: `SELECT COUNT(*) FROM point_of_sale;`
- Check JOIN is working: `psql -f migrations/verify_multi_stop_schema.sql`
- Ensure `restaurant_id` foreign key is valid

### Issue: Map renders but no stops show

**Solution:**

- Check browser console for JavaScript errors
- Verify `delivery_lat` and `delivery_lng` are valid numbers
- Ensure `pos_location.latitude` and `pos_location.longitude` exist

### Issue: Slow map rendering (>3 seconds)

**Solution:**

- Run database indexes: `psql -f migrations/add_multi_stop_indexes.sql`
- Check indexes exist: `psql -c "SELECT * FROM pg_indexes WHERE tablename='orders';"`
- Monitor database query time: `EXPLAIN ANALYZE` on test query

## Rollback Plan

If multi-stop causes issues:

1. **Immediate**: Stop using multi-stop by setting `multiStopMode={false}` in MapModal props
2. **Quick Fix**: Restart backend to clear any cached connections
3. **Full Rollback**:
   - Comment out GET /:id/active-orders in routes/drivers.js
   - Remove database indexes (optional): `DROP INDEX idx_orders_driver_status;`
   - Restart backend

## Success Criteria

✅ Multi-Stop Deployment is COMPLETE when:

- [ ] Backend endpoint responds with valid JSON
- [ ] Mobile app displays multiple order stops on map
- [ ] Driver name visible in map popups
- [ ] Map performance acceptable (<2s render time)
- [ ] Error handling works (graceful fallback if backend down)
- [ ] No crashes or console errors
- [ ] Database queries complete <100ms with indexes

## Post-Deployment

1. **Monitor in Production**: Watch for 404/500 errors for 24 hours
2. **Collect Metrics**: Track average response times, error rates
3. **Driver Feedback**: Get feedback on UX from actual drivers
4. **Iterate**: Fix bugs, optimize performance based on data

---

**Need Help?**

- Check `MULTI_STOP_DRIVER_ROUTES.md` for technical details
- Review `verify_multi_stop_schema.sql` for database diagnostics
- See `MULTI_STOP_QUICKSTART.md` for quick reference
