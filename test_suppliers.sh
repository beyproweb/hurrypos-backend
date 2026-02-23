#!/bin/bash

# Test Suppliers Page Functionality
# This script tests all supplier-related endpoints and operations

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BASE_URL="${BASE_URL:-http://localhost:5000}"
TOKEN="${TOKEN:-}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  SUPPLIERS PAGE TEST SUITE${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check server
echo -e "${YELLOW}[1/12] Checking server health...${NC}"
if ! curl -s "${BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}✗ Server not running${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Server is running${NC}"

# Generate token
if [ -z "$TOKEN" ]; then
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
    TOKEN=$(cd "$SCRIPT_DIR" && node -r dotenv/config -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({ user_id: 1, restaurant_id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'dev_jwt_secret_change_me', { expiresIn: '1h' }));
" 2>/dev/null)
    
    if [ -z "$TOKEN" ]; then
        echo -e "${RED}✗ Failed to generate token${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Generated JWT token${NC}"
fi

PASSED=0
FAILED=0
ISSUES=()

test_endpoint() {
    local name=$1
    local endpoint=$2
    local method=${3:-GET}
    local data=${4:-}
    
    echo ""
    echo -e "${YELLOW}Testing: ${name}${NC}"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" -X $method -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${data}" "${BASE_URL}${endpoint}")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        echo -e "${GREEN}✓ Status: ${http_code}${NC}"
        echo "$body" > /tmp/test_response.json
        if python3 -c "import json; json.loads(open('/tmp/test_response.json').read())" 2>/dev/null; then
            echo -e "${GREEN}✓ Valid JSON${NC}"
            PASSED=$((PASSED + 1))
            return 0
        else
            echo -e "${RED}✗ Invalid JSON${NC}"
            FAILED=$((FAILED + 1))
            return 1
        fi
    else
        echo -e "${RED}✗ Status: ${http_code}${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PART 1: Core Supplier Tests${NC}"
echo -e "${BLUE}========================================${NC}"

# Test 1: Get all suppliers
echo -e "${YELLOW}[2/12] Testing GET /suppliers...${NC}"
test_endpoint "Get Suppliers" "/api/suppliers"
SUPPLIERS=$(cat /tmp/test_response.json)
SUPPLIER_COUNT=$(echo "$SUPPLIERS" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")
echo -e "  Found ${SUPPLIER_COUNT} suppliers"

if [ "$SUPPLIER_COUNT" -gt 0 ]; then
    FIRST_SUPPLIER_ID=$(echo "$SUPPLIERS" | python3 -c "import json,sys; data=json.loads(sys.stdin.read()); print(data[0]['id'] if len(data) > 0 else '')")
    echo -e "  First supplier ID: ${FIRST_SUPPLIER_ID}"
fi

# Test 2: Get supplier ingredients
echo -e "${YELLOW}[3/12] Testing GET /suppliers/ingredients...${NC}"
test_endpoint "Get All Ingredients" "/api/suppliers/ingredients"

# Test 3: Get supplier by ID (if exists)
if [ -n "$FIRST_SUPPLIER_ID" ]; then
    echo -e "${YELLOW}[4/12] Testing GET /suppliers/:id...${NC}"
    test_endpoint "Get Supplier Details" "/api/suppliers/${FIRST_SUPPLIER_ID}"
    
    # Test 4: Get supplier transactions
    echo -e "${YELLOW}[5/12] Testing GET /suppliers/:id/transactions...${NC}"
    test_endpoint "Get Supplier Transactions" "/api/suppliers/${FIRST_SUPPLIER_ID}/transactions"
    
    # Test 5: Get supplier ingredients
    echo -e "${YELLOW}[6/12] Testing GET /suppliers/:id/ingredients...${NC}"
    test_endpoint "Get Supplier Ingredients" "/api/suppliers/${FIRST_SUPPLIER_ID}/ingredients"
else
    echo -e "${YELLOW}[4-6/12] Skipping supplier-specific tests (no suppliers found)${NC}"
    FAILED=$((FAILED + 3))
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PART 2: Supplier Cart Tests${NC}"
echo -e "${BLUE}========================================${NC}"

# Test 6: Get pending carts (if supplier exists)
if [ -n "$FIRST_SUPPLIER_ID" ]; then
    echo -e "${YELLOW}[7/12] Testing GET /supplier-carts/pending...${NC}"
    test_endpoint "Get Pending Carts" "/api/supplier-carts/pending?supplier_id=${FIRST_SUPPLIER_ID}"
else
    echo -e "${YELLOW}[7/12] Skipping pending carts test${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 7: Get cart history (if supplier exists)
if [ -n "$FIRST_SUPPLIER_ID" ]; then
    echo -e "${YELLOW}[8/12] Testing GET /supplier-carts/history...${NC}"
    test_endpoint "Get Cart History" "/api/supplier-carts/history?supplier_id=${FIRST_SUPPLIER_ID}"
else
    echo -e "${YELLOW}[8/12] Skipping cart history test${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 8: Get scheduled cart (if supplier exists)
if [ -n "$FIRST_SUPPLIER_ID" ]; then
    echo -e "${YELLOW}[9/12] Testing GET /supplier-carts/scheduled...${NC}"
    test_endpoint "Get Scheduled Cart" "/api/supplier-carts/scheduled?supplier_id=${FIRST_SUPPLIER_ID}"
else
    echo -e "${YELLOW}[9/12] Skipping scheduled cart test${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PART 3: Code Quality Checks${NC}"
echo -e "${BLUE}========================================${NC}"

echo -e "${YELLOW}[10/12] Checking for code discrepancies...${NC}"

# Check for promise chains vs async/await inconsistency
PROMISE_CHAINS=$(grep -n "\.then(" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$PROMISE_CHAINS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found ${PROMISE_CHAINS} promise chain(s) - should use async/await${NC}"
    ISSUES+=("Code Style: Promise chains found (line 389-393) - inconsistent with async/await pattern")
else
    echo -e "${GREEN}✓ Consistent async/await usage${NC}"
fi

# Check for alert() usage
ALERT_COUNT=$(grep -n "alert(" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$ALERT_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found ${ALERT_COUNT} alert() call(s) - should use toast${NC}"
    ISSUES+=("UX: ${ALERT_COUNT} alert() calls found (lines 1198, 1228) - should use toast notifications")
else
    echo -e "${GREEN}✓ No alert() usage${NC}"
fi

# Check for window.confirm() usage
CONFIRM_COUNT=$(grep -n "window.confirm(" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$CONFIRM_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Found ${CONFIRM_COUNT} window.confirm() call(s) - should use modal${NC}"
    ISSUES+=("UX: ${CONFIRM_COUNT} window.confirm() calls (lines 1244, 1496) - should use confirmation modal")
else
    echo -e "${GREEN}✓ No window.confirm() usage${NC}"
fi

echo -e "${YELLOW}[11/12] Checking for duplicate functions...${NC}"

# Check if inline secureFetch still exists in useEffect
if grep -A 5 "useEffect(() =>" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx | grep -q "secureFetch(\"/suppliers\")"; then
    echo -e "${YELLOW}⚠ Duplicate supplier fetching logic detected${NC}"
    ISSUES+=("Duplication: useEffect uses inline fetch instead of calling fetchSuppliers()")
else
    echo -e "${GREEN}✓ No duplicate fetching logic${NC}"
fi

echo -e "${YELLOW}[12/12] Checking error handling patterns...${NC}"

# Check for proper error handling
ERROR_HANDLING=$(grep -c "catch (err)" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx 2>/dev/null || echo "0")
TOTAL_ASYNC=$(grep -c "const.*= async" /Users/nurikord/PycharmProjects/hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx 2>/dev/null || echo "0")

if [ "$ERROR_HANDLING" -lt "$TOTAL_ASYNC" ]; then
    echo -e "${YELLOW}⚠ Not all async functions have error handling${NC}"
    echo -e "  Async functions: ${TOTAL_ASYNC}, Error handlers: ${ERROR_HANDLING}"
else
    echo -e "${GREEN}✓ Good error handling coverage${NC}"
fi

# Summary
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  TEST RESULTS${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Passed: ${PASSED}${NC}"
echo -e "${RED}Failed: ${FAILED}${NC}"

if [ ${#ISSUES[@]} -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}⚠ Issues Found:${NC}"
    for issue in "${ISSUES[@]}"; do
        echo -e "${YELLOW}  • ${issue}${NC}"
    done
fi

echo ""

if [ $FAILED -eq 0 ] && [ ${#ISSUES[@]} -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed with no issues!${NC}"
    exit 0
else
    if [ ${#ISSUES[@]} -gt 0 ]; then
        echo -e "${YELLOW}⚠ Tests completed but code quality issues detected${NC}"
    else
        echo -e "${RED}✗ Some tests failed${NC}"
    fi
    exit 1
fi
