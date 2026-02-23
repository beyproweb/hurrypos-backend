#!/bin/bash

# Generate fresh middleware token
TOKEN=$(cd /Users/nurikord/PycharmProjects/hurrypos-backend && node -r dotenv/config -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({ service: 'middleware' }, process.env.YS_SECRET, { algorithm: 'HS512', expiresIn: '1h' }));
")

echo "Generated Token: $TOKEN"
echo ""
echo "=== Sending Full Migros Order Test ==="
echo ""

curl -X POST http://127.0.0.1:5000/api/integrations/migros/order/MIGROS_TEST_001 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "orderId": "MIGROS_FULL_TEST_'$(date +%s)'",
    "orderTime": '$(date +%s)',
    "orderAmount": 350.75,
    "deliveryFee": 35.00,
    "status": "Approved",
    "notes": "Please ring doorbell twice, leave at front door",
    "customer": {
      "name": "Ahmet Yilmaz",
      "phone": "+905551234567",
      "mobilePhone": "+905551234567"
    },
    "address": {
      "street": "Istiklal Caddesi",
      "number": "42",
      "city": "Istanbul",
      "district": "Beyoglu",
      "postcode": "34433"
    },
    "delivery": {
      "address": {
        "street": "Istiklal Caddesi",
        "number": "42",
        "city": "Istanbul",
        "district": "Beyoglu",
        "postcode": "34433"
      },
      "deliveryInstructions": "Ring doorbell twice, use side entrance"
    },
    "paymentType": "Online",
    "items": [
      {
        "itemId": "ITEM_KEBAB_001",
        "itemName": "Adana Kebab",
        "quantity": 2,
        "unitPrice": 125.00,
        "notes": "Extra spicy, no onion"
      },
      {
        "itemId": "ITEM_SALAD_001",
        "itemName": "Shepherd Salad",
        "quantity": 1,
        "unitPrice": 35.75,
        "notes": "Dressing on the side"
      },
      {
        "itemId": "ITEM_DRINK_001",
        "itemName": "Ayran (Large)",
        "quantity": 2,
        "unitPrice": 12.50
      }
    ],
    "extras": [
      {
        "extraId": "EXTRA_SAUCE_001",
        "extraName": "Hot Sauce",
        "quantity": 1,
        "price": 5.00
      },
      {
        "extraId": "EXTRA_BREAD_001",
        "extraName": "Extra Pita Bread",
        "quantity": 2,
        "price": 3.00
      }
    ],
    "comments": {
      "customerComment": "Please make it fresh!",
      "vendorComment": "Standard preparation"
    }
  }'
