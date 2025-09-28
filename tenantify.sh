#!/bin/bash
# tenantify.sh - add restaurant_id filters to Beypro routes
# Run from project root: bash tenantify.sh

ROUTES_DIR="routes"

echo "🔎 Backing up $ROUTES_DIR/ folder..."
cp -r $ROUTES_DIR ${ROUTES_DIR}_backup_$(date +%s)

echo "⚡ Adding tenant filters to queries in $ROUTES_DIR ..."

# -----------------
# SELECT statements
# -----------------
# Settings
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/FROM settings LIMIT 1/FROM settings WHERE restaurant_id = \$1 LIMIT 1/g' \
  -e 's/FROM settings;/FROM settings WHERE restaurant_id = \$1;/g' \
  {} +

# Staff
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/FROM staff /FROM staff WHERE restaurant_id = \$1 /g' \
  {} +

# Orders
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/FROM orders /FROM orders WHERE restaurant_id = \$1 /g' \
  {} +

# Stock
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/FROM stock /FROM stock WHERE restaurant_id = \$1 /g' \
  {} +

# Transactions
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/FROM transactions /FROM transactions WHERE restaurant_id = \$1 /g' \
  {} +

# -----------------
# UPDATE statements
# -----------------
# Settings updates
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/UPDATE settings SET /UPDATE settings SET /g' \
  -e 's/WHERE key =/WHERE restaurant_id = \$1 AND key =/g' \
  {} +

# Generic updates without key (fallback)
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/UPDATE settings SET /UPDATE settings SET /g' \
  -e 's/WHERE id =/WHERE restaurant_id = \$1 AND id =/g' \
  {} +

# -----------------
# INSERT statements
# -----------------
# Ensure restaurant_id is present in inserts
find $ROUTES_DIR -type f -name "*.js" -exec sed -i '' \
  -e 's/INSERT INTO settings (/INSERT INTO settings (restaurant_id, /g' \
  {} +

echo "✅ Tenant filters injected (SELECT, UPDATE, INSERT)."
echo "📂 Backup saved in ${ROUTES_DIR}_backup_*"
