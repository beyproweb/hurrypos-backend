# Multi-Stop Driver Routes - Backend Implementation Guide

## Overview

This document describes the backend endpoint for multi-stop delivery routes, which enables drivers to view and manage multiple deliveries in a single route on the mobile map.

## New Endpoint

### GET `/api/drivers/:id/active-orders`

Fetches all active and pending orders assigned to a specific driver, formatted for multi-stop route display on the mobile map.

**Authentication:** Required (via AuthMiddleware)
**Method:** GET
**Path Parameter:** `:id` - Driver ID

#### Response Format

```json
[
  {
    "id": 12345,
    "order_number": "ORD-2025-001",
    "customer_name": "John Doe",
    "customer_address": "123 Main St, Istanbul",
    "delivery_address": "456 Oak Ave, Istanbul",
    "delivery_lat": 41.0082,
    "delivery_lng": 28.9784,
    "driver_id": 89,
    "driver_status": null,
    "status": "pending",
    "estimated_arrival": 15,
    "pos_name": "Main Restaurant",
    "pos_location": "Restaurant Address, Istanbul",
    "pos_location_lat": 41.0150,
    "pos_location_lng": 28.9700,
    "restaurant_id": 1,
    "created_at": "2025-01-15T10:30:00Z"
  },
  {
    "id": 12346,
    "order_number": "ORD-2025-002",
    "customer_name": "Jane Smith",
    "customer_address": "789 Park Rd, Istanbul",
    "delivery_address": "999 River St, Istanbul",
    "delivery_lat": 41.0200,
    "delivery_lng": 28.9850,
    "driver_id": 89,
    "driver_status": null,
    "status": "pending",
    "estimated_arrival": 22,
    "pos_name": "Main Restaurant",
    "pos_location": "Restaurant Address, Istanbul",
    "pos_location_lat": 41.0150,
    "pos_location_lng": 28.9700,
    "restaurant_id": 1,
    "created_at": "2025-01-15T10:35:00Z"
  }
]
```

#### Query Logic

The endpoint:

1. **Fetches all orders** assigned to the specified driver
2. **Filters out**:
   - Closed orders
   - Cancelled orders
   - Orders already marked as delivered
3. **Includes pickup info** from the `point_of_sale` table
4. **Calculates ETA** based on `estimated_delivery_time`
5. **Orders results** by creation time (earliest first)

#### Error Responses

- **400**: Missing driver_id parameter
- **401**: Missing authentication/restaurant context
- **500**: Database or server error

## Frontend Integration

### MapModal Component

The `MapModal` component in `src/components/MapModal.tsx` automatically uses this endpoint:

```typescript
// MapModal detects multi-stop mode and fetches the route
useEffect(() => {
  if (!visible || !driverId || multiStopMode === false) return;

  const loadRoute = async () => {
    try {
      const routeData = await fetchDriverRoute(Number(driverId));
      if (isMounted && routeData) {
        setFetchedRoute(routeData);
      }
    } catch (error) {
      // Falls back to route prop if endpoint unavailable
      console.log("⚠️ Multi-stop route endpoint not available, using prop");
    }
  };

  loadRoute();
}, [visible, driverId, multiStopMode]);
```

### Usage Example

```tsx
import { MapModal, MapModalRef } from './src/components/MapModal';

// In your driver screen component
const mapRef = useRef<MapModalRef>(null);

<MapModal
  ref={mapRef}
  visible={showMap}
  onDismiss={() => setShowMap(false)}
  multiStopMode={true}
  driverId={currentDriver.id}
  driverName={currentDriver.name}
  orderId={null}
  // Route will be fetched automatically from backend
/>
```

## Data Flow Diagram

```
Mobile App (MapModal)
    ↓
fetchDriverRoute(driverId)
    ↓
GET /api/drivers/:id/active-orders
    ↓
Backend (drivers.js)
    ↓
Query orders table (JOIN with point_of_sale)
    ↓
Return formatted order array
    ↓
Frontend processes:
  - Creates pickup stop (common for all orders)
  - Creates delivery stops (one per order)
  - Generates map markers (A=driver, B=pickup, C-Z=deliveries)
  - Draws polylines connecting all stops
    ↓
Displays multi-stop route on map
```

## Database Requirements

The endpoint assumes the following table structure:

### orders table
- `id` - Order ID
- `restaurant_id` - Foreign key to restaurant
- `driver_id` - Assigned driver
- `order_number` - Order reference
- `customer_name` - Delivery recipient
- `customer_address` - Pickup address
- `delivery_address` - Delivery address
- `delivery_lat` - Delivery latitude
- `delivery_lng` - Delivery longitude
- `driver_status` - Status (null, 'picked_up', 'delivered')
- `status` - Order status (pending, confirmed, closed, cancelled)
- `estimated_delivery_time` - ETA timestamp
- `created_at` - Order creation time

### point_of_sale table
- `id` - POS ID
- `name` - Restaurant name
- `latitude` - Restaurant latitude
- `longitude` - Restaurant longitude
- `address` - Restaurant address

## Testing

### Test the endpoint manually

```bash
# Using curl
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/api/drivers/89/active-orders"

# Response should return JSON array of active orders
```

### Test with frontend

1. Open driver mobile app
2. Enable multi-stop mode on a driver with multiple assigned orders
3. Open map view
4. Should see:
   - Pickup marker (A - yellow)
   - Multiple delivery markers (B, C, D... - green)
   - Polyline connecting all stops
   - Footer showing all stops in order

## Performance Considerations

### Optimization

For high-volume scenarios:

1. **Add database indexes**:
   ```sql
   CREATE INDEX idx_driver_id_status ON orders(driver_id, status, driver_status);
   CREATE INDEX idx_restaurant_driver ON orders(restaurant_id, driver_id);
   ```

2. **Cache active routes** (optional):
   ```javascript
   // Use Redis to cache active routes per driver
   const cacheKey = `driver:${driverId}:active-orders`;
   // Cache for 5 minutes
   ```

3. **Paginate results** if many orders per driver:
   ```javascript
   // Add limit/offset parameters
   const ORDERS_PER_PAGE = 50;
   const offset = (page - 1) * ORDERS_PER_PAGE;
   ```

## Troubleshooting

### Issue: Empty orders returned

**Check:**
1. Orders exist in database for the driver
2. Orders are not marked as `closed` or `cancelled`
3. Orders don't have `driver_status = 'delivered'`
4. `driver_id` matches the requested driver

### Issue: 404 Not Found

**Check:**
1. Endpoint is registered in `routes/drivers.js`
2. Path parameter `:id` is correctly formatted
3. Backend server is running and accessible

### Issue: Missing pickup location info

**Check:**
1. `point_of_sale` table is populated
2. Orders have valid `restaurant_id`
3. Point of sale records exist for the restaurant

## Future Enhancements

- Add real-time order updates via WebSocket
- Implement route optimization (reorder stops for efficiency)
- Add delivery time estimation
- Track driver progress through multi-stop route
- Add route deviation alerts

## Related Files

- **Frontend**: `/src/utils/deliveryRouteService.ts` - Handles API calls
- **Frontend**: `/src/components/MapModal.tsx` - Displays multi-stop routes
- **Backend**: `/routes/drivers.js` - Endpoint implementation
- **Types**: `/src/types/delivery.ts` - TypeScript interfaces

