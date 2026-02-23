#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: $0 <order_id>"
  echo "Example: $0 10060"
  exit 1
fi

ORDER_ID=$1

echo "=== Order Details ==="
psql postgresql://postgres:1234@localhost:5432/hurrypos -c "
SELECT id, customer_name, customer_phone, total, status, external_source, external_id, created_at
FROM orders WHERE id = $ORDER_ID;
"

echo ""
echo "=== Order Items ==="
psql postgresql://postgres:1234@localhost:5432/hurrypos -c "
SELECT id, name, quantity, price, extras, created_at
FROM order_items WHERE order_id = $ORDER_ID;
"

echo ""
echo "=== Order Item Details (Pretty) ==="
psql postgresql://postgres:1234@localhost:5432/hurrypos -c "
SELECT 
  '• ' || name || ' x' || quantity || ' @ ' || COALESCE(price::text, '0') || ' TL' as item_summary,
  CASE WHEN extras IS NOT NULL THEN '  Extras: ' || extras ELSE '' END as extras_info
FROM order_items WHERE order_id = $ORDER_ID;
"
