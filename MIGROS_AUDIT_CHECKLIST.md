# Migros Integration - Test Checklist & cURL Commands

## Beypro Migros Yemek API v1.2.0 Compliance

---

## 🔑 Prerequisites

Before testing, ensure:

1. `.env` file has `MIGROS_SECRET_KEY` set
2. Database migration run: `2026-01-29_create_migros_restaurant_keys.sql`
3. Backend restarted after migration
4. Test restaurant created with `external_migros_remote_id` set

### Environment Setup

```bash
# .env configuration
MIGROS_SECRET_KEY=<your_secret_key_from_migros>
MIGROS_API_BASE=https://test.gourmet.migrosonline.com
```

---

## 📋 Test 1: Key Sync (Get & Store API Keys)

### 1.1 Manual Sync Endpoint

```bash
# POST /api/integrations/migros/admin/sync-keys
curl -X POST http://localhost:5000/api/integrations/migros/admin/sync-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -d '{}'

# Expected Response:
# {
#   "success": true,
#   "message": "Synced X API keys",
#   "synced": X,
#   "skipped": Y,
#   "errors": []
# }
```

### 1.2 Health Check Endpoint

```bash
# GET /api/integrations/migros/admin/health
curl -X GET http://localhost:5000/api/integrations/migros/admin/health \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>"

# Expected Response:
# {
#   "success": true,
#   "health": {
#     "secretKeyExists": true,
#     "lastSyncTime": "2026-01-29T10:00:00.000Z",
#     "activeKeyCount": 2,
#     "lastError": null
#   }
# }
```

### 1.3 Database Verification

```sql
-- Check that keys were synced correctly
SELECT restaurant_id, api_key, store_id, store_group_id, is_active
FROM migros_restaurant_keys
ORDER BY synced_at DESC;

-- Should show one row per synced restaurant
```

---

## 🍴 Test 2: Webhook - Order Created (Idempotent)

### 2.1 First Order Creation

```bash
# POST /api/integrations/migros/order/:remoteId
# Replace :remoteId with your restaurant's external_migros_remote_id

curl -X POST http://localhost:5000/api/integrations/migros/order/test-remote-id-123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <EXTERNAL_API_AUTH>" \
  -d '{
    "code": "MIGROS_ORDER_001",
    "token": "order-token-xyz",
    "orderId": 455221,
    "customer": {
      "name": "Ahmet Yilmaz",
      "phone": "+905551234567"
    },
    "address": "Beşiktaş, Istanbul, Turkey",
    "price": {
      "grandTotal": 150.50
    },
    "paymentType": "ONLINE",
    "items": [
      {
        "name": "Kebab Plate",
        "quantity": 2,
        "price": 75.25
      }
    ],
    "callbackUrls": {
      "orderAcceptedUrl": "https://your-migros-callback.com/accepted",
      "orderPreparedUrl": "https://your-migros-callback.com/prepared",
      "orderPickedUpUrl": "https://your-migros-callback.com/picked-up",
      "orderDeliveredUrl": "https://your-migros-callback.com/delivered"
    }
  }'

# Expected Response (Status 200):
# {
#   "success": true,
#   "orderId": 123,
#   "status": "confirmed"
# }
```

### 2.2 Duplicate Order (Idempotency Test)

```bash
# Send THE EXACT SAME request again (same orderId/code)
curl -X POST http://localhost:5000/api/integrations/migros/order/test-remote-id-123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <EXTERNAL_API_AUTH>" \
  -d '{
    "code": "MIGROS_ORDER_001",
    ...
  }'

# Expected Response (Status 200):
# {
#   "success": true,
#   "orderId": 123,  # ← SAME ORDER ID as before (not duplicated!)
#   "status": "confirmed"
# }

# Database Check:
# SELECT COUNT(*) FROM orders WHERE external_id = 'MIGROS_ORDER_001';
# Should return: 1 (not 2!)
```

---

## ✅ Test 3: Order Status Updates (v2 Endpoints with Encryption)

### 3.1 Mark as Prepared (Approved → Prepared)

```bash
# POST /api/integrations/migros/:orderId/prepared
# (This manually triggers a prepared status update; in production, called via order status change)

curl -X POST http://localhost:5000/api/integrations/migros/123/prepared \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -d '{}'

# This calls Order/v2/UpdateOrderStatus internally with:
# {
#   "value": "<AES-256-ECB-ENCRYPTED-JSON>",
#   "XApiKey": "<restaurant_api_key>"
# }

# Expected Migros Response (decrypted):
# {
#   "success": true,
#   "data": { "result": "Order status updated" }
# }

# Expected Backend Response (Status 200):
# {
#   "success": true,
#   "result": {
#     "ok": true,
#     "status": 200,
#     "data": { ... }
#   }
# }
```

### 3.2 Mark as Picked Up (Prepared → Delivery)

```bash
# POST /api/integrations/migros/:orderId/picked-up

curl -X POST http://localhost:5000/api/integrations/migros/123/picked-up \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -d '{}'

# Internally calls Order/v2/UpdateOrderStatus with orderStatus: "Delivery"
```

### 3.3 Mark as Completed (Delivery → Completed)

```bash
# POST /api/integrations/migros/:orderId/accept
# (In practice, this would be called from your backend order status change logic)

curl -X POST http://localhost:5000/api/integrations/migros/123/accept \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -d '{}'

# Internally calls Order/v2/UpdateOrderStatus with orderStatus: "Completed"
```

### 3.4 Status Mapping Reference

| Beypro Status                 | Migros Status |
| ----------------------------- | ------------- |
| confirmed, accepted, pending  | Approved      |
| prepared, ready               | Prepared      |
| dispatched, on_road, delivery | Delivery      |
| delivered, completed          | Completed     |

---

## 🚫 Test 4: Order Cancellation (v2 Endpoint with Reason)

### 4.1 Get Available Cancel Reasons

```bash
# GET /Mapping/v2/GetCancelReasons (Migros API - unencrypted)
curl -X GET https://test.gourmet.migrosonline.com/Mapping/v2/GetCancelReasons \
  -H "XApiKey: <restaurant_api_key>"

# Expected Response:
# {
#   "success": true,
#   "data": [
#     { "reasonId": 1, "description": "Item not available" },
#     { "reasonId": 2, "description": "Restaurant too busy" },
#     { "reasonId": 3, "description": "Customer requested" },
#     ...
#   ]
# }
```

### 4.2 Cancel Order

```bash
# POST /api/integrations/migros/:orderId/reject
curl -X POST http://localhost:5000/api/integrations/migros/123/reject \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -d '{
    "reason": "Item not available"
  }'

# Expected Response (Status 200):
# {
#   "success": true,
#   "result": {
#     "ok": true,
#     "status": 200,
#     "data": { "result": "Order cancelled successfully" }
#   }
# }

# This internally calls Order/v2/CancelOrder with:
# {
#   "value": "<AES-256-ECB-ENCRYPTED>",
#   "XApiKey": "<restaurant_api_key>"
# }
# Request body (plain, then encrypted):
# {
#   "orderId": 455221,
#   "storeId": 230000214522,
#   "notifyUser": true,
#   "cancelReasonId": 1,
#   "userId": 0
# }
```

### 4.3 Verify Cancellation

```sql
-- Check order status in DB
SELECT id, status, created_at FROM orders WHERE id = 123;
-- Should show status as 'cancelled' or similar
```

---

## 🔐 Encryption Verification (Manual Testing)

### 4.1 Test Encryption Helper

```bash
# Test via Node REPL or script
node -e "
const { encryptMigrosBody } = require('./utils/migrosClient');
const plainBody = { orderId: 123, orderStatus: 'Prepared' };
const secretKey = process.env.MIGROS_SECRET_KEY;
const encrypted = encryptMigrosBody(plainBody, secretKey);
console.log('Encrypted:', encrypted);
console.log('Wrapped:', JSON.stringify({ value: encrypted }, null, 2));
"
```

### 4.2 Verify AES-256-ECB Encryption

- Mode: **ECB** (not CBC, not CTR)
- Padding: **PKCS7** (automatic in Node.js crypto)
- Key Size: **256-bit** (derived from secretKey via SHA-256)
- Block Size: **128-bit** (128-bit blocks for AES)

---

## 📊 Integration Testing Workflow

### Complete Happy Path Test

```bash
# 1. Sync keys
curl -X POST http://localhost:5000/api/integrations/migros/admin/sync-keys \
  -H "Authorization: Bearer <JWT>" ...

# 2. Check health
curl -X GET http://localhost:5000/api/integrations/migros/admin/health \
  -H "Authorization: Bearer <JWT>" ...

# 3. Create order via webhook
curl -X POST http://localhost:5000/api/integrations/migros/order/test-id \
  -H "Authorization: Bearer <EXT_AUTH>" ...

# 4. Verify idempotency (send same order again)
curl -X POST http://localhost:5000/api/integrations/migros/order/test-id \
  -H "Authorization: Bearer <EXT_AUTH>" ...

# 5. Mark prepared
curl -X POST http://localhost:5000/api/integrations/migros/123/prepared \
  -H "Authorization: Bearer <JWT>" ...

# 6. Mark picked up
curl -X POST http://localhost:5000/api/integrations/migros/123/picked-up \
  -H "Authorization: Bearer <JWT>" ...

# 7. Accept (mark completed)
curl -X POST http://localhost:5000/api/integrations/migros/123/accept \
  -H "Authorization: Bearer <JWT>" ...
```

---

## 🐛 Debugging Checklist

### Enable Debug Logging

```bash
# In .env or runtime:
DEBUG=migros-*
NODE_DEBUG_EXTENSION=.js

# Or grep backend logs:
tail -f backend.log | grep '\[migros'
```

### Common Issues & Fixes

| Issue                           | Cause                              | Fix                                                 |
| ------------------------------- | ---------------------------------- | --------------------------------------------------- |
| "Missing MIGROS_SECRET_KEY"     | Env var not set                    | Add `MIGROS_SECRET_KEY=<key>` to `.env` and restart |
| "No API key for restaurant"     | No row in `migros_restaurant_keys` | Run admin sync or manually insert mapping           |
| "Invalid response format"       | Migros returned unexpected JSON    | Check Migros API docs; verify secretKey             |
| "409 Conflict" on status update | Order already in that state        | Treat as success; log as idempotent                 |
| "401 Unauthorized"              | Wrong apiKey or expired            | Sync keys again; verify restaurant config           |
| Duplicate orders on webhook     | Idempotency check failed           | Verify `external_id` uniqueness in DB               |

### Database Queries for Debugging

```sql
-- Check migros keys sync
SELECT * FROM migros_restaurant_keys ORDER BY synced_at DESC;

-- Check orders created from Migros
SELECT id, external_id, external_source, status, created_at
FROM orders
WHERE external_source = 'migros'
ORDER BY created_at DESC;

-- Check for duplicate orders (should be 0)
SELECT external_id, COUNT(*) as count
FROM orders
WHERE external_source = 'migros'
GROUP BY external_id
HAVING COUNT(*) > 1;

-- Check last API errors
SELECT integrations->'migros'->'lastApiError' as last_error
FROM settings
WHERE key = 'global';
```

---

## ✨ Success Criteria

- [ ] Keys sync successfully from Migros
- [ ] Health endpoint shows active keys and last sync time
- [ ] Webhook receives orders and creates them in DB
- [ ] Duplicate webhooks don't create duplicate orders (idempotent)
- [ ] Order status updates sent with AES-256-ECB encryption
- [ ] All requests include `XApiKey` header
- [ ] Cancel reason ID mapped correctly
- [ ] v2 endpoints used (not deprecated v1)
- [ ] Timeout and retry logic works (test by simulating network delay)
- [ ] Errors logged and recorded in settings table

---

## 📝 Notes

- **Production Secrets**: Do NOT commit `.env` with real `MIGROS_SECRET_KEY` to git
- **Logging**: Prod logs minimal; set `NODE_DEBUG=` empty in production
- **Rate Limiting**: Migros may rate-limit; retry strategy uses exponential backoff
- **Webhook Signing**: Verify external API auth middleware is correctly configured
- **Timeout**: Set to 30s for Migros requests; adjust if needed per SLA

---

## 🚀 Deployment Checklist

- [ ] Migration file applied to production DB
- [ ] `.env` updated with production `MIGROS_SECRET_KEY`
- [ ] Admin endpoint protected (requires admin JWT)
- [ ] Webhook endpoint protected (requires external API auth)
- [ ] Error monitoring in place (Sentry, DataDog, etc.)
- [ ] Keys synced on deployment
- [ ] Logging level appropriate for production
- [ ] Database backups before running migration
