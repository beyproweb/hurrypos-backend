# Multi-Stop Driver Routes - Quick Start Guide

## What Was Added

A new backend endpoint that enables the mobile app to display and manage multiple deliveries for a driver on a single map view.

## Changes Made

### Backend

1. **New endpoint**: `GET /api/drivers/:id/active-orders` in `/routes/drivers.js`
   - Fetches all active orders assigned to a driver
   - Returns pickup location (restaurant) + delivery addresses
   - Includes estimated arrival times
   - Automatically filters out completed/cancelled orders

2. **Database optimization**: Added indexes in `migrations/add_multi_stop_indexes.sql`
   - Improves query performance for large order volumes
   - Recommended indexes for common filters

### Frontend

Already supports multi-stop routes via:
- `src/components/MapModal.tsx` - Displays multi-stop routes
- `src/utils/deliveryRouteService.ts` - Handles API calls

## How to Deploy

### Step 1: Update Backend Code

The endpoint has been added to `/routes/drivers.js`. Just restart your backend server:

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm install  # if needed
npm start
# or if using PM2
pm2 restart hurrypos-backend
```

### Step 2: Run Database Optimization (Optional but Recommended)

Connect to your PostgreSQL database and run the migration:

```bash
# Using psql directly
psql -U your_user -d your_database -f /Users/nurikord/PycharmProjects/hurrypos-backend/migrations/add_multi_stop_indexes.sql

# Or if using a migration tool, add it to your migrations queue
```

### Step 3: Test the Endpoint

```bash
# Test with a real driver ID (replace 89 with an actual driver ID)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  "http://localhost:3000/api/drivers/89/active-orders"

# Should return JSON array like:
# [
#   {
#     "id": 12345,
#     "customer_name": "John Doe",
#     "delivery_address": "456 Oak Ave, Istanbul",
#     ...
#   },
#   ...
# ]
```

### Step 4: Test in Mobile App

1. Open the driver mobile app
2. Assign multiple orders to a single driver
3. Open map view with `multiStopMode={true}`
4. Should see:
   - Yellow marker: Restaurant/Pickup location
   - Green markers: Delivery locations
   - Polylines connecting all stops
   - Footer showing all stops with ETAs

## Features

### ✅ What Works Now

- Display multiple deliveries on a single map
- Show pickup (restaurant) and delivery locations
- Estimated arrival times for each delivery
- Visual route with polylines
- Footer list of all stops in order
- Mark individual deliveries as completed
- Real-time driver location tracking

### 📋 Coming Soon

- Route optimization (reorder stops for efficiency)
- Live ETA updates
- Route deviation alerts
- Multi-driver route views

## Database Requirements

Make sure your `orders` and `point_of_sale` tables have:

**orders table:**
```
- id, restaurant_id, driver_id
- customer_name, customer_address
- delivery_address, delivery_lat, delivery_lng
- driver_status, status
- estimated_delivery_time, created_at
```

**point_of_sale table:**
```
- id, restaurant_id, name
- latitude, longitude, address
```

## Troubleshooting

### No orders showing

1. Check that orders exist for the driver in database
2. Verify orders are not marked as `closed` or `cancelled`
3. Check driver_status is not `delivered`
4. Confirm `point_of_sale` has location data

### 404 Error on endpoint

1. Restart backend server after code changes
2. Check route path: `/api/drivers/:id/active-orders`
3. Verify authentication token is valid

### Map shows single-stop instead of multi-stop

1. Enable `multiStopMode={true}` when opening MapModal
2. Assign multiple orders to the driver
3. Make sure `driverId` prop is set

## Code Example

### Using Multi-Stop Routes in Your Screen

```tsx
import { MapModal, MapModalRef } from './src/components/MapModal';

export function DriverMapScreen({ driverId, driverName }) {
  const mapRef = useRef<MapModalRef>(null);
  const [showMap, setShowMap] = useState(false);

  return (
    <>
      <TouchableOpacity onPress={() => setShowMap(true)}>
        <Text>View Multi-Stop Route</Text>
      </TouchableOpacity>

      <MapModal
        ref={mapRef}
        visible={showMap}
        onDismiss={() => setShowMap(false)}
        multiStopMode={true}
        driverId={driverId}
        driverName={driverName}
        orderId={null}
        // Orders will be fetched automatically from backend
        onOrderDelivered={(orderId) => {
          console.log(`Order ${orderId} delivered`);
          // Refresh orders list
        }}
      />
    </>
  );
}
```

## File Locations

| File | Purpose |
|------|---------|
| `/routes/drivers.js` | Backend endpoint |
| `/migrations/add_multi_stop_indexes.sql` | Database optimization |
| `MULTI_STOP_DRIVER_ROUTES.md` | Complete documentation |
| `src/components/MapModal.tsx` | Frontend map display |
| `src/utils/deliveryRouteService.ts` | API integration |

## Support

For issues or questions:

1. Check the comprehensive guide: `MULTI_STOP_DRIVER_ROUTES.md`
2. Review endpoint response format
3. Verify database query with `EXPLAIN ANALYZE`
4. Check mobile app console logs for errors

