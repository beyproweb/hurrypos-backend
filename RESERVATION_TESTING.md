# 🧪 Reservation Endpoints - Testing Guide

## Quick Test Commands

### Prerequisites

```bash
# Set your API URL and token
API_URL="http://localhost:3000"
RESTAURANT_ID=1
TOKEN="your_jwt_token_here"
```

---

## 1. CREATE RESERVATION (POST)

### Test with curl

```bash
curl -X POST "$API_URL/api/orders/reservations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reservation_date": "2025-12-20",
    "reservation_time": "19:30",
    "reservation_clients": 4,
    "reservation_notes": "Window seat preferred",
    "table_number": 5
  }'
```

### Expected Response (201/200)

```json
{
  "success": true,
  "message": "✅ Reservation created for table",
  "reservation": {
    "id": 125,
    "table_number": 5,
    "reservation_date": "2025-12-20",
    "reservation_time": "19:30",
    "reservation_clients": 4,
    "reservation_notes": "Window seat preferred",
    "status": "reserved",
    "order_type": "reservation",
    "total": 0,
    "created_at": "2025-12-06T12:00:00Z"
  }
}
```

### Alternative: Update existing order

```bash
curl -X POST "$API_URL/api/orders/reservations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reservation_date": "2025-12-20",
    "reservation_time": "19:30",
    "reservation_clients": 4,
    "reservation_notes": "Window seat preferred",
    "order_id": 123
  }'
```

---

## 2. LIST ALL RESERVATIONS (GET)

### Test basic list

```bash
curl -X GET "$API_URL/api/orders/reservations" \
  -H "Authorization: Bearer $TOKEN"
```

### Test with date filter

```bash
curl -X GET "$API_URL/api/orders/reservations?start_date=2025-12-01&end_date=2025-12-31" \
  -H "Authorization: Bearer $TOKEN"
```

### Test with table filter

```bash
curl -X GET "$API_URL/api/orders/reservations?table_number=5" \
  -H "Authorization: Bearer $TOKEN"
```

### Expected Response

```json
{
  "success": true,
  "count": 3,
  "reservations": [
    {
      "id": 123,
      "table_number": 5,
      "reservation_date": "2025-12-20",
      "reservation_time": "19:30",
      "reservation_clients": 4,
      "reservation_notes": "Window seat preferred",
      "status": "reserved",
      "order_type": "reservation",
      "total": 0,
      "customer_name": "John Doe",
      "customer_phone": "+1234567890",
      "created_at": "2025-12-06T10:00:00Z",
      "updated_at": "2025-12-06T10:00:00Z"
    }
  ]
}
```

---

## 3. GET SINGLE RESERVATION (GET)

### Test fetch

```bash
curl -X GET "$API_URL/api/orders/reservations/123" \
  -H "Authorization: Bearer $TOKEN"
```

### Expected Response

```json
{
  "success": true,
  "reservation": {
    "id": 123,
    "table_number": 5,
    "reservation_date": "2025-12-20",
    "reservation_time": "19:30",
    "reservation_clients": 4,
    "reservation_notes": "Window seat preferred",
    "status": "reserved",
    "order_type": "reservation",
    "total": 0,
    "customer_name": "John Doe",
    "customer_phone": "+1234567890",
    "created_at": "2025-12-06T10:00:00Z",
    "updated_at": "2025-12-06T10:00:00Z"
  }
}
```

---

## 4. UPDATE RESERVATION (PUT)

### Test update

```bash
curl -X PUT "$API_URL/api/orders/reservations/123" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reservation_date": "2025-12-21",
    "reservation_time": "20:00",
    "reservation_clients": 6,
    "reservation_notes": "Birthday party - need 2 adjacent tables"
  }'
```

### Test partial update (only clients)

```bash
curl -X PUT "$API_URL/api/orders/reservations/123" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reservation_clients": 5
  }'
```

### Expected Response

```json
{
  "success": true,
  "message": "✅ Reservation updated",
  "reservation": {
    "id": 123,
    "table_number": 5,
    "reservation_date": "2025-12-21",
    "reservation_time": "20:00",
    "reservation_clients": 6,
    "reservation_notes": "Birthday party - need 2 adjacent tables",
    "status": "reserved",
    "order_type": "reservation",
    "total": 0,
    "updated_at": "2025-12-06T12:30:00Z"
  }
}
```

---

## 5. DELETE/CANCEL RESERVATION (DELETE)

### Test cancellation

```bash
curl -X DELETE "$API_URL/api/orders/reservations/123" \
  -H "Authorization: Bearer $TOKEN"
```

### Expected Response

```json
{
  "success": true,
  "message": "✅ Reservation cancelled",
  "reservation_id": 123
}
```

---

## Error Scenarios

### Missing authentication

```bash
curl -X GET "$API_URL/api/orders/reservations"
```

**Response (401):**

```json
{
  "error": "Unauthorized"
}
```

### Invalid reservation ID

```bash
curl -X GET "$API_URL/api/orders/reservations/99999" \
  -H "Authorization: Bearer $TOKEN"
```

**Response (404):**

```json
{
  "error": "Reservation not found"
}
```

### Missing required fields

```bash
curl -X POST "$API_URL/api/orders/reservations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reservation_clients": 4
  }'
```

**Response (400):**

```json
{
  "error": "Reservation date and time are required"
}
```

### No update fields provided

```bash
curl -X PUT "$API_URL/api/orders/reservations/123" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'
```

**Response (400):**

```json
{
  "error": "No fields to update"
}
```

---

## Database Verification

### Check reservations in database

```sql
SELECT
  id,
  table_number,
  reservation_date,
  reservation_time,
  reservation_clients,
  reservation_notes,
  status,
  order_type
FROM orders
WHERE reservation_date IS NOT NULL
ORDER BY reservation_date, reservation_time;
```

### Check recent reservations

```sql
SELECT
  id,
  table_number,
  reservation_date,
  reservation_time,
  reservation_clients,
  created_at,
  updated_at
FROM orders
WHERE status = 'reserved'
ORDER BY created_at DESC
LIMIT 10;
```

### Count reservations by date

```sql
SELECT
  reservation_date,
  COUNT(*) as count
FROM orders
WHERE reservation_date IS NOT NULL
GROUP BY reservation_date
ORDER BY reservation_date;
```

---

## WebSocket Event Testing

### Listen for events (using socket.io-client)

```javascript
import io from "socket.io-client";

const socket = io("http://localhost:3000", {
  auth: {
    token: "your_jwt_token_here",
  },
});

// Listen for reservation events
socket.on("reservation_created", (data) => {
  console.log("Reservation created:", data);
});

socket.on("reservation_updated", (data) => {
  console.log("Reservation updated:", data);
});

socket.on("reservation_cancelled", (data) => {
  console.log("Reservation cancelled:", data);
});

socket.on("orders_updated", () => {
  console.log("Orders updated (includes reservations)");
});
```

---

## Postman Collection

### Import this into Postman

```json
{
  "info": {
    "name": "Reservation Endpoints",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Create Reservation",
      "request": {
        "method": "POST",
        "url": "{{base_url}}/api/orders/reservations",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{token}}"
          },
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"reservation_date\": \"2025-12-20\",\n  \"reservation_time\": \"19:30\",\n  \"reservation_clients\": 4,\n  \"reservation_notes\": \"Window seat preferred\",\n  \"table_number\": 5\n}"
        }
      }
    },
    {
      "name": "List Reservations",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/api/orders/reservations",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{token}}"
          }
        ]
      }
    },
    {
      "name": "Get Reservation",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/api/orders/reservations/123",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{token}}"
          }
        ]
      }
    },
    {
      "name": "Update Reservation",
      "request": {
        "method": "PUT",
        "url": "{{base_url}}/api/orders/reservations/123",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{token}}"
          },
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"reservation_clients\": 5,\n  \"reservation_notes\": \"Updated notes\"\n}"
        }
      }
    },
    {
      "name": "Cancel Reservation",
      "request": {
        "method": "DELETE",
        "url": "{{base_url}}/api/orders/reservations/123",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{token}}"
          }
        ]
      }
    }
  ]
}
```

---

## Checklist for Deployment

- [ ] All endpoints return correct response format
- [ ] WebSocket events are emitted successfully
- [ ] Database records are saved correctly
- [ ] Date/time formats are consistent (YYYY-MM-DD, HH:MM:SS)
- [ ] Authentication is enforced on all endpoints
- [ ] Error handling returns appropriate status codes
- [ ] Restaurant isolation is working (can't see other restaurant's reservations)
- [ ] Timestamps are correctly recorded

---

## Common Issues & Fixes

| Issue                | Cause                      | Fix                                                       |
| -------------------- | -------------------------- | --------------------------------------------------------- |
| 401 Unauthorized     | Missing or invalid token   | Include valid Bearer token in Authorization header        |
| 400 Bad Request      | Missing required fields    | Ensure reservation_date and reservation_time are provided |
| 404 Not Found        | Reservation doesn't exist  | Verify reservation_id exists in database                  |
| Database error       | Syntax or connection issue | Check database connection and column names                |
| WebSocket not firing | Socket not connected       | Check WebSocket connection and event names                |
| Dates not saving     | Format mismatch            | Use YYYY-MM-DD for dates, HH:MM:SS for times              |
