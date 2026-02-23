#!/bin/bash

# Test all report endpoints
# This script tests every section shown in the Reports page

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="${BASE_URL:-http://localhost:5000}"
TOKEN="${TOKEN:-}"
RESTAURANT_ID="${RESTAURANT_ID:-1}"

# Date range for testing
TODAY=$(date +%Y-%m-%d)
WEEK_AGO=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  HURRYPOS REPORTS TEST SUITE${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo -e "  Base URL: ${BASE_URL}"
echo -e "  Date Range: ${WEEK_AGO} to ${TODAY}"
echo ""

# Check if server is running
echo -e "${YELLOW}[1/15] Checking server health...${NC}"
if curl -s "${BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Server is running${NC}"
else
    echo -e "${RED}✗ Server is not running at ${BASE_URL}${NC}"
    echo -e "${YELLOW}Please start the server with: node server.js${NC}"
    exit 1
fi

# Get auth token if not provided
if [ -z "$TOKEN" ]; then
    echo -e "${YELLOW}[INFO] No TOKEN provided. Generating JWT token...${NC}"
    
    # Try to generate token using Node.js with JWT
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
    TOKEN=$(cd "$SCRIPT_DIR" && node -r dotenv/config -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { user_id: 1, restaurant_id: 1, username: 'admin', role: 'admin' },
  process.env.JWT_SECRET || 'dev_jwt_secret_change_me',
  { expiresIn: '1h' }
);
console.log(token);
" 2>/dev/null)
    
    if [ -z "$TOKEN" ]; then
        echo -e "${RED}✗ Failed to generate auth token${NC}"
        echo -e "${YELLOW}Please set TOKEN environment variable or ensure Node.js and dependencies are installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Generated JWT token successfully${NC}"
fi

PASSED=0
FAILED=0
TOTAL=14

# Test function
test_endpoint() {
    local name=$1
    local endpoint=$2
    local method=${3:-GET}
    local data=${4:-}
    
    echo ""
    echo -e "${YELLOW}Testing: ${name}${NC}"
    echo -e "  Endpoint: ${method} ${endpoint}"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${data}" "${BASE_URL}${endpoint}")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "200" ]; then
        echo -e "${GREEN}✓ Status: 200 OK${NC}"
        
        # Save body to temp file and validate JSON
        echo "$body" > /tmp/test_response.json
        if python3 -c "import json; json.loads(open('/tmp/test_response.json').read())" 2>/dev/null; then
            echo -e "${GREEN}✓ Valid JSON response${NC}"
            
            # Show sample of data
            if [ "$method" = "GET" ]; then
                record_count=$(python3 -c "import json; data=json.loads(open('/tmp/test_response.json').read()); print(len(data) if isinstance(data, list) else (len(data.get('data', [])) if isinstance(data, dict) and 'data' in data else 1))" 2>/dev/null || echo "1")
                echo -e "  Records/Fields: ${record_count}"
            fi
            
            PASSED=$((PASSED + 1))
        else
            echo -e "${RED}✗ Invalid JSON response${NC}"
            echo -e "${RED}  Body preview: ${body:0:100}...${NC}"
            FAILED=$((FAILED + 1))
        fi
    else
        echo -e "${RED}✗ Status: ${http_code}${NC}"
        echo -e "${RED}  Error: ${body}${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Run all tests
echo ""
echo -e "${BLUE}Running tests...${NC}"

# 1. Summary/KPIs
test_endpoint "[2/15] Summary (KPIs)" "/api/reports/summary?from=${WEEK_AGO}&to=${TODAY}"

# 2. Sales by Payment Method
test_endpoint "[3/15] Sales by Payment Method" "/api/reports/sales-by-payment-method?from=${WEEK_AGO}&to=${TODAY}"

# 3. Sales by Payment Method Detailed
test_endpoint "[4/15] Sales by Payment Method (Detailed)" "/api/reports/sales-by-payment-method-detailed?from=${WEEK_AGO}&to=${TODAY}"

# 4. Cash Register History
test_endpoint "[5/15] Cash Register History" "/api/reports/cash-register-history?from=${WEEK_AGO}&to=${TODAY}"

# 5. Cash Register Events
test_endpoint "[6/15] Cash Register Events" "/api/reports/cash-register-events?from=${WEEK_AGO}&to=${TODAY}"

# 6. Cash Register Trends
test_endpoint "[7/15] Cash Register Trends" "/api/reports/cash-register-trends?from=${WEEK_AGO}&to=${TODAY}"

# 7. Staff Performance
test_endpoint "[8/15] Staff Performance" "/api/reports/staff-performance?from=${WEEK_AGO}&to=${TODAY}"

# 8. Sales by Category
test_endpoint "[9/15] Sales by Category" "/api/reports/sales-by-category?from=${WEEK_AGO}&to=${TODAY}"

# 9. Sales by Category Detailed
test_endpoint "[10/15] Sales by Category (Detailed)" "/api/reports/sales-by-category-detailed?from=${WEEK_AGO}&to=${TODAY}"

# 10. Category Trends
test_endpoint "[11/15] Category Trends" "/api/reports/category-trends?from=${WEEK_AGO}&to=${TODAY}"

# 11. Sales Trends
test_endpoint "[12/15] Sales Trends (Daily)" "/api/reports/sales-trends?view=daily"
test_endpoint "[12/15] Sales Trends (Weekly)" "/api/reports/sales-trends?view=weekly"

# 12. Profit & Loss
test_endpoint "[13/15] Profit & Loss (Daily)" "/api/reports/profit-loss?timeframe=daily"
test_endpoint "[13/15] Profit & Loss (Weekly)" "/api/reports/profit-loss?timeframe=weekly"
test_endpoint "[13/15] Profit & Loss (Monthly)" "/api/reports/profit-loss?timeframe=monthly"

# 13. Expenses
test_endpoint "[14/15] Expenses List" "/api/reports/expenses?from=${WEEK_AGO}&to=${TODAY}"

# 14. Order Items
test_endpoint "[15/15] Order Items" "/api/reports/order-items?from=${WEEK_AGO}&to=${TODAY}"

# Summary
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  TEST RESULTS${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Passed: ${PASSED}/${TOTAL}${NC}"
echo -e "${RED}Failed: ${FAILED}/${TOTAL}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed!${NC}"
    exit 1
fi
