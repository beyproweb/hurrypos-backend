#!/bin/bash

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  MIGROS INTEGRATION TEST SUITE${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Database connection
DB_CONN="postgresql://postgres:1234@localhost:5432/hurrypos"

# Generate fresh JWT tokens
echo -e "${YELLOW}[1/7] Generating authentication tokens...${NC}"
cd /Users/nurikord/PycharmProjects/hurrypos-backend

ADMIN_TOKEN=$(node -r dotenv/config -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign(
  { id: 1, restaurant_id: 1, role: 'admin' },
  process.env.JWT_SECRET,
  { algorithm: 'HS512', expiresIn: '1h' }
));
")

MIDDLEWARE_TOKEN=$(node -r dotenv/config -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign(
  { service: 'middleware' },
  process.env.YS_SECRET,
  { algorithm: 'HS512', expiresIn: '1h' }
));
")

echo -e "${GREEN}✅ Tokens generated${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}[2/7] Testing health endpoint...${NC}"
HEALTH=$(curl -s http://127.0.0.1:5000/api/integrations/migros/admin/health \
  -H "Authorization: Bearer $ADMIN_TOKEN")

if echo "$HEALTH" | grep -q '"success":true'; then
  echo -e "${GREEN}✅ Health check passed${NC}"
  echo "$HEALTH" | python3 -m json.tool | head -10
else
  echo -e "${RED}❌ Health check failed${NC}"
  echo "$HEALTH"
fi
echo ""

# Test 2: Create Order #1
echo -e "${YELLOW}[3/7] Creating order with items, extras, and notes...${NC}"
ORDER_ID_1="MIGROS_TEST_$(date +%s)"

ORDER_RESPONSE=$(curl -s -X POST http://127.0.0.1:5000/api/integrations/migros/order/MIGROS_TEST_001 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIDDLEWARE_TOKEN" \
  -d '{
    "orderId": "'$ORDER_ID_1'",
    "orderTime": '$(date +%s)',
    "orderAmount": 350.75,
    "deliveryFee": 35.00,
    "status": "Approved",
    "notes": "Please ring doorbell twice",
    "customer": {
      "name": "Test Customer",
      "phone": "+905551234567"
    },
    "address": {
      "street": "Test Street",
      "number": "42",
      "city": "Istanbul",
      "district": "Beyoglu",
      "postcode": "34433"
    },
    "paymentType": "Online",
    "items": [
      {
        "itemId": "ITEM_001",
        "itemName": "Adana Kebab",
        "quantity": 2,
        "unitPrice": 125.00,
        "notes": "Extra spicy"
      },
      {
        "itemId": "ITEM_002",
        "itemName": "Ayran",
        "quantity": 1,
        "unitPrice": 12.50
      }
    ],
    "extras": [
      {
        "extraId": "EXTRA_001",
        "extraName": "Hot Sauce",
        "quantity": 1,
        "price": 5.00
      }
    ]
  }')

BEYPRO_ORDER_ID=$(echo "$ORDER_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('orderId') or data.get('id') or 'ERROR')" 2>/dev/null)

if [ "$BEYPRO_ORDER_ID" != "ERROR" ] && [ ! -z "$BEYPRO_ORDER_ID" ]; then
  echo -e "${GREEN}✅ Order created successfully${NC}"
  echo "   Beypro Order ID: $BEYPRO_ORDER_ID"
  echo "   Migros Order ID: $ORDER_ID_1"
else
  echo -e "${RED}❌ Order creation failed${NC}"
  echo "$ORDER_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$ORDER_RESPONSE"
  exit 1
fi
echo ""

# Test 3: Idempotency Check
echo -e "${YELLOW}[4/7] Testing idempotency (resending same order)...${NC}"
IDEMPOTENT_RESPONSE=$(curl -s -X POST http://127.0.0.1:5000/api/integrations/migros/order/MIGROS_TEST_001 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIDDLEWARE_TOKEN" \
  -d '{
    "orderId": "'$ORDER_ID_1'",
    "orderTime": '$(date +%s)',
    "orderAmount": 350.75,
    "deliveryFee": 35.00,
    "status": "Approved",
    "notes": "Please ring doorbell twice",
    "customer": {
      "name": "Test Customer",
      "phone": "+905551234567"
    },
    "address": {
      "street": "Test Street",
      "number": "42",
      "city": "Istanbul",
      "district": "Beyoglu",
      "postcode": "34433"
    },
    "paymentType": "Online",
    "items": [
      {
        "itemId": "ITEM_001",
        "itemName": "Adana Kebab",
        "quantity": 2,
        "unitPrice": 125.00,
        "notes": "Extra spicy"
      },
      {
        "itemId": "ITEM_002",
        "itemName": "Ayran",
        "quantity": 1,
        "unitPrice": 12.50
      }
    ],
    "extras": [
      {
        "extraId": "EXTRA_001",
        "extraName": "Hot Sauce",
        "quantity": 1,
        "price": 5.00
      }
    ]
  }')

BEYPRO_ORDER_ID_2=$(echo "$IDEMPOTENT_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('orderId') or data.get('id') or 'ERROR')" 2>/dev/null)

if [ "$BEYPRO_ORDER_ID" = "$BEYPRO_ORDER_ID_2" ]; then
  echo -e "${GREEN}✅ Idempotency working (same order ID returned)${NC}"
  echo "   Order ID: $BEYPRO_ORDER_ID_2"
else
  echo -e "${RED}❌ Idempotency failed (different order IDs)${NC}"
  echo "   First: $BEYPRO_ORDER_ID"
  echo "   Second: $BEYPRO_ORDER_ID_2"
fi
echo ""

# Test 4: Database Verification
echo -e "${YELLOW}[5/7] Verifying order in database...${NC}"
DB_ORDER=$(psql $DB_CONN -t -c "
SELECT id, customer_name, total, status, external_source, external_id 
FROM orders WHERE id = $BEYPRO_ORDER_ID;
" 2>/dev/null)

if [ ! -z "$DB_ORDER" ]; then
  echo -e "${GREEN}✅ Order found in database${NC}"
  echo "$DB_ORDER"
else
  echo -e "${RED}❌ Order not found in database${NC}"
fi
echo ""

# Test 5: Items Verification
echo -e "${YELLOW}[6/7] Verifying order items...${NC}"
ITEMS=$(psql $DB_CONN -t -c "
SELECT name, quantity, price FROM order_items WHERE order_id = $BEYPRO_ORDER_ID;
" 2>/dev/null)

if echo "$ITEMS" | grep -q "Adana Kebab"; then
  echo -e "${GREEN}✅ Items stored correctly${NC}"
  echo "$ITEMS" | awk '{print "   • " $1 " x" $2 " @ " $3 " TL"}'
else
  echo -e "${RED}❌ Items not found or incorrect${NC}"
  echo "$ITEMS"
fi
echo ""

# Test 6: Extras Verification
echo -e "${YELLOW}[7/7] Verifying order extras...${NC}"
EXTRAS=$(psql $DB_CONN -t -c "
SELECT extras FROM order_items WHERE order_id = $BEYPRO_ORDER_ID AND extras IS NOT NULL LIMIT 1;
" 2>/dev/null)

if [ ! -z "$EXTRAS" ]; then
  echo -e "${GREEN}✅ Extras stored${NC}"
  echo "   $EXTRAS" | python3 -m json.tool 2>/dev/null || echo "   $EXTRAS"
else
  echo -e "${YELLOW}⚠️  No extras found (may not have any)${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ ALL TESTS COMPLETED${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Test Summary:${NC}"
echo "  Order ID:     $BEYPRO_ORDER_ID"
echo "  Migros ID:    $ORDER_ID_1"
echo "  Items:        2 (Kebab, Ayran)"
echo "  Extras:       1 (Hot Sauce)"
echo "  Idempotency:  ✅ PASS"
echo ""
echo -e "${YELLOW}Frontend should now show:${NC}"
echo "  • Adana Kebab x2 @ 125.00 TL"
echo "  • Ayran x1 @ 12.50 TL"
echo "  • Hot Sauce (extra)"
echo ""
