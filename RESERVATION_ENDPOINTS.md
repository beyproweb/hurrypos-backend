# 🎫 Reservation System Endpoints

All reservation endpoints are integrated into `/routes/orders.js`

---

## 📋 Database Columns

The `orders` table now includes the following reservation columns:

| Column                | Type    | Default | Nullable | Description                       |
| --------------------- | ------- | ------- | -------- | --------------------------------- |
| `reservation_date`    | DATE    | NULL    | YES      | Reservation date (YYYY-MM-DD)     |
| `reservation_time`    | TIME    | NULL    | YES      | Reservation time (HH:MM:SS)       |
| `reservation_clients` | INTEGER | 0       | NO       | Number of clients for reservation |
| `reservation_notes`   | TEXT    | NULL    | YES      | Special notes/requests            |

---

## 🔌 API Endpoints

### 1. POST /orders/reservations

**Create a new reservation**

**Request Body:**

```json
{
  "reservation_date": "2025-12-15",
  "reservation_time": "19:30",
  "reservation_clients": 4,
  "reservation_notes": "Window seat preferred",
  "order_id": 123, // Option A: Update existing order
  "table_number": 5 // Option B: Create new reservation
}
```

**Response:**

```json
{
  "success": true,
  "message": "✅ Reservation created and order updated",
  "reservation": {
    "id": 123,
    "table_number": 5,
    "reservation_date": "2025-12-15",
    "reservation_time": "19:30",
    "reservation_clients": 4,
    "reservation_notes": "Window seat preferred",
    "status": "reserved",
    "order_type": "reservation",
    "total": 0,
    "created_at": "2025-12-06T10:00:00Z",
    "updated_at": "2025-12-06T10:00:00Z"
  }
}
```

**Required Fields:**

- `reservation_date` (YYYY-MM-DD format)
- `reservation_time` (HH:MM:SS format)
- Either `order_id` OR `table_number`

**Notes:**

- If `order_id` provided: Updates existing order with reservation fields
- If `table_number` provided: Creates new reservation order
- Emits `reservation_created` event to WebSocket

---

### 2. GET /orders/reservations

**List all reservations for a restaurant**

**Query Parameters:**

```
GET /orders/reservations?start_date=2025-12-01&end_date=2025-12-31&table_number=5
```

**Response:**

```json
{
  "success": true,
  "count": 5,
  "reservations": [
    {
      "id": 123,
      "table_number": 5,
      "reservation_date": "2025-12-15",
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

**Query Options:**

- `start_date` - Filter from date (YYYY-MM-DD)
- `end_date` - Filter to date (YYYY-MM-DD)
- `table_number` - Filter by specific table

**Notes:**

- Returns all reservations and reserved orders for the restaurant
- Results sorted by date and time
- Requires authentication

---

### 3. GET /orders/reservations/:id

**Get single reservation details**

**Request:**

```
GET /orders/reservations/123
```

**Response:**

```json
{
  "success": true,
  "reservation": {
    "id": 123,
    "table_number": 5,
    "reservation_date": "2025-12-15",
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

**Error Responses:**

- `404` - Reservation not found
- `400` - Missing restaurant ID

---

### 4. PUT /orders/reservations/:id

**Update an existing reservation**

**Request Body:**

```json
{
  "reservation_date": "2025-12-16",
  "reservation_time": "20:00",
  "reservation_clients": 5,
  "reservation_notes": "Birthday party - need larger table"
}
```

**Response:**

```json
{
  "success": true,
  "message": "✅ Reservation updated",
  "reservation": {
    "id": 123,
    "table_number": 5,
    "reservation_date": "2025-12-16",
    "reservation_time": "20:00",
    "reservation_clients": 5,
    "reservation_notes": "Birthday party - need larger table",
    "status": "reserved",
    "order_type": "reservation",
    "total": 0,
    "updated_at": "2025-12-06T10:30:00Z"
  }
}
```

**Notes:**

- All fields are optional
- Updates automatically include `updated_at` timestamp
- Emits `reservation_updated` event to WebSocket
- Partial updates supported

**Error Responses:**

- `404` - Reservation not found
- `400` - No fields to update

---

### 5. DELETE /orders/reservations/:id

**Cancel a reservation**

**Request:**

```
DELETE /orders/reservations/123
```

**Response:**

```json
{
  "success": true,
  "message": "✅ Reservation cancelled",
  "reservation_id": 123
}
```

**Notes:**

- Sets order status to `cancelled`
- Clears all reservation fields (date, time, clients, notes)
- Only cancels orders with `status = 'reserved'` or `order_type = 'reservation'`
- Emits `reservation_cancelled` event to WebSocket

**Error Responses:**

- `404` - Reservation not found or cannot be cancelled

---

## 🔌 WebSocket Events

The system emits real-time events for reservation changes:

### Event: `reservation_created`

```json
{
  "reservation_id": 123,
  "order_id": 123,
  "table_number": 5,
  "reservation_date": "2025-12-15",
  "reservation_time": "19:30",
  "reservation_clients": 4
}
```

### Event: `reservation_updated`

```json
{
  "reservation_id": 123,
  "changes": {
    "reservation_clients": 5,
    "reservation_notes": "Updated notes"
  }
}
```

### Event: `reservation_cancelled`

```json
{
  "reservation_id": 123
}
```

### Event: `orders_updated`

Emitted whenever a reservation is modified

---

## 📱 Frontend Integration Examples

### Web (React - TransactionScreen.jsx)

```javascript
// Create reservation
const handleReservationSave = async () => {
  try {
    const response = await fetch("/api/orders/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: currentOrderId,
        reservation_date: reservationDate,
        reservation_time: reservationTime,
        reservation_clients: reservationClients,
        reservation_notes: reservationNotes,
      }),
    });

    const data = await response.json();
    if (data.success) {
      Alert.alert("Success", "Reservation confirmed!");
      setShowReservationModal(false);
    }
  } catch (err) {
    console.error("Failed to create reservation:", err);
  }
};
```

### Mobile (React Native - [tableNumber].tsx)

```javascript
// Create reservation
const handleReservationSave = async () => {
  try {
    const response = await fetch("/api/orders/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table_number: tableNumber,
        reservation_date: dateString,
        reservation_time: timeString,
        reservation_clients: parseInt(reservationClients) || 0,
        reservation_notes: reservationNotes,
      }),
    });

    const data = await response.json();
    if (data.success) {
      Alert.alert(t("Success"), t("Reservation Confirmed"));
      setShowReservationModal(false);
    }
  } catch (err) {
    console.error("Failed to create reservation:", err);
  }
};
```

---

## 🔒 Authentication & Authorization

All reservation endpoints require:

- **Valid JWT token** with `restaurant_id`
- **Restaurant context** (either authenticated user or `?identifier=` query param for public endpoints)

---

## ✅ Implementation Checklist

- [x] Database columns added (`reservation_date`, `reservation_time`, `reservation_clients`, `reservation_notes`)
- [x] Migration executed successfully
- [x] POST /reservations endpoint created
- [x] GET /reservations endpoint created
- [x] GET /reservations/:id endpoint created
- [x] PUT /reservations/:id endpoint created
- [x] DELETE /reservations/:id endpoint created
- [ ] Frontend API integration (ready for next step)
- [ ] Reservation calendar view (future enhancement)
- [ ] Reservation notifications (future enhancement)

---

## 🐛 Troubleshooting

**Reservation not appearing in list:**

- Check if `reservation_date` is populated (not NULL)
- Verify restaurant_id matches
- Ensure order status is 'reserved' or order_type is 'reservation'

**Update not reflecting:**

- Check WebSocket connection (should see `reservation_updated` event)
- Verify authentication token includes correct `restaurant_id`
- Confirm database contains the reservation

**Dates/times incorrect format:**

- Use YYYY-MM-DD for dates
- Use HH:MM:SS for times
- Ensure client-side formatting matches database requirements

---

## 📝 Notes

- All timestamps are in ISO 8601 format in responses
- Reservation fields are preserved when order status changes
- Deleting/cancelling a reservation clears all related fields but keeps order record
- WebSocket events emitted to `restaurant_{restaurantId}` room
