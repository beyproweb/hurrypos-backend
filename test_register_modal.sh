#!/bin/bash

# Test Cash Register Modal Functionality
# This script tests all register-related endpoints and operations

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

# Date for testing
TODAY=$(date +%Y-%m-%d)

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  CASH REGISTER MODAL TEST SUITE${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo -e "  Base URL: ${BASE_URL}"
echo -e "  Today: ${TODAY}"
echo ""

# Check if server is running
echo -e "${YELLOW}[1/10] Checking server health...${NC}"
if curl -s "${BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Server is running${NC}"
else
    echo -e "${RED}✗ Server is not running at ${BASE_URL}${NC}"
    exit 1
fi

# Generate auth token
if [ -z "$TOKEN" ]; then
    echo -e "${YELLOW}[INFO] Generating JWT token...${NC}"
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
        exit 1
    fi
    echo -e "${GREEN}✓ Generated JWT token${NC}"
fi

PASSED=0
FAILED=0
ISSUES=()

# Test function
test_endpoint() {
    local name=$1
    local endpoint=$2
    local method=${3:-GET}
    local data=${4:-}
    local silent=${5:-false}
    
    if [ "$silent" != "true" ]; then
        echo ""
        echo -e "${YELLOW}Testing: ${name}${NC}"
    fi
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d "${data}" "${BASE_URL}${endpoint}")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "200" ]; then
        if [ "$silent" != "true" ]; then
            echo -e "${GREEN}✓ Status: 200 OK${NC}"
        fi
        echo "$body" > /tmp/test_response.json
        if python3 -c "import json; json.loads(open('/tmp/test_response.json').read())" 2>/dev/null; then
            if [ "$silent" != "true" ]; then
                echo -e "${GREEN}✓ Valid JSON response${NC}"
            fi
            PASSED=$((PASSED + 1))
            echo "$body"
            return 0
        else
            if [ "$silent" != "true" ]; then
                echo -e "${RED}✗ Invalid JSON response${NC}"
            fi
            FAILED=$((FAILED + 1))
            ISSUES+=("$name: Invalid JSON")
            return 1
        fi
    else
        if [ "$silent" != "true" ]; then
            echo -e "${RED}✗ Status: ${http_code}${NC}"
            echo -e "${RED}  Error: ${body}${NC}"
        fi
        FAILED=$((FAILED + 1))
        ISSUES+=("$name: HTTP $http_code")
        return 1
    fi
}

# Store initial state
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PART 1: Data Fetching Tests${NC}"
echo -e "${BLUE}========================================${NC}"

# Test 1: Get Register Status
echo -e "${YELLOW}[2/10] Testing register status endpoint...${NC}"
test_endpoint "Register Status" "/api/reports/cash-register-status" > /tmp/register_status.json 2>&1
STATUS_CODE=$?

if [ $STATUS_CODE -eq 0 ]; then
    # Extract only JSON from the response
    CURRENT_STATE=$(grep -o '{"status".*}' /tmp/register_status.json | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('status', 'unknown'))")
    echo -e "  Current State: ${CURRENT_STATE}"
    
    # Check for discrepancies
    if grep -q '"yesterday_close"' /tmp/register_status.json; then
        echo -e "${GREEN}✓ yesterday_close field present${NC}"
    else
        echo -e "${YELLOW}⚠ yesterday_close field missing${NC}"
        ISSUES+=("Register Status: Missing yesterday_close field")
    fi
    
    if grep -q '"opening_cash"' /tmp/register_status.json; then
        echo -e "${GREEN}✓ opening_cash field present${NC}"
    else
        echo -e "${YELLOW}⚠ opening_cash field missing${NC}"
        ISSUES+=("Register Status: Missing opening_cash field")
    fi
fi

# Test 2: Get Register Snapshot
echo -e "${YELLOW}[3/10] Testing register snapshot endpoint...${NC}"
test_endpoint "Register Snapshot" "/api/reports/cash-register-snapshot" > /tmp/register_snapshot.json 2>&1
if [ $? -eq 0 ]; then
    SNAPSHOT_STATUS=$(grep -o '{"status".*}' /tmp/register_snapshot.json | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('status', 'unknown'))")
    echo -e "  Snapshot State: ${SNAPSHOT_STATUS}"
    
    # Check consistency
    if [ "$CURRENT_STATE" != "$SNAPSHOT_STATUS" ]; then
        echo -e "${YELLOW}⚠ State mismatch: status=$CURRENT_STATE vs snapshot=$SNAPSHOT_STATUS${NC}"
        ISSUES+=("State Inconsistency: Register status and snapshot don't match")
    else
        echo -e "${GREEN}✓ States are consistent${NC}"
    fi
fi

# Test 3: Get Cash Register History
echo -e "${YELLOW}[4/10] Testing cash register history...${NC}"
test_endpoint "Cash Register History" "/api/reports/cash-register-history?from=${TODAY}&to=${TODAY}"

# Test 4: Get Cash Register Events
echo -e "${YELLOW}[5/10] Testing cash register events...${NC}"
test_endpoint "Cash Register Events" "/api/reports/cash-register-events?from=${TODAY}&to=${TODAY}" > /tmp/register_events.json 2>&1
if [ $? -eq 0 ]; then
    EVENT_COUNT=$(grep -o '\[.*\]' /tmp/register_events.json | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")
    echo -e "  Events Today: ${EVENT_COUNT}"
fi

# Test 5: Get Expenses
echo -e "${YELLOW}[6/10] Testing expenses endpoint...${NC}"
EXPENSES=$(test_endpoint "Expenses" "/api/reports/expenses?from=${TODAY}&to=${TODAY}")

# Test 6: Get Supplier Cash Payments
echo -e "${YELLOW}[7/10] Testing supplier cash payments...${NC}"
test_endpoint "Supplier Cash Payments" "/api/reports/supplier-cash-payments?from=${TODAY}&to=${TODAY}"

# Test 7: Get Staff Cash Payments
echo -e "${YELLOW}[8/10] Testing staff cash payments...${NC}"
test_endpoint "Staff Cash Payments" "/api/reports/staff-cash-payments?from=${TODAY}&to=${TODAY}"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  PART 2: Register Operations Tests${NC}"
echo -e "${BLUE}========================================${NC}"

# Test 8: Test Entry Creation (if register is open)
echo -e "${YELLOW}[9/10] Testing cash entry creation...${NC}"
if [ "$CURRENT_STATE" = "open" ]; then
    echo -e "${YELLOW}  Attempting to add a test cash entry...${NC}"
    ENTRY_RESULT=$(test_endpoint "Add Cash Entry" "/api/reports/cash-register-log" "POST" '{"type":"entry","amount":10,"note":"Test entry from automated test"}')
    
    if [ $? -eq 0 ]; then
        # Wait a moment for DB to update
        sleep 1
        
        # Verify the entry was added
        test_endpoint "Verify Entry Added" "/api/reports/cash-register-events?from=${TODAY}&to=${TODAY}" > /tmp/new_register_events.json 2>&1
        if [ $? -eq 0 ]; then
            NEW_EVENT_COUNT=$(grep -o '\[.*\]' /tmp/new_register_events.json | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")
            if [ "$NEW_EVENT_COUNT" -gt "$EVENT_COUNT" ]; then
                echo -e "${GREEN}✓ Cash entry successfully added and verified${NC}"
            else
                echo -e "${YELLOW}⚠ Entry might not have been added (event count unchanged)${NC}"
                ISSUES+=("Cash Entry: Entry added but not appearing in events")
            fi
        fi
    fi
else
    echo -e "${YELLOW}  Skipping (register is not open)${NC}"
fi

# Test 9: Validate Combined Events Logic
echo -e "${YELLOW}[10/10] Testing combined events calculation...${NC}"
echo -e "${YELLOW}  Checking if events are properly combined with expenses...${NC}"

# Get both events and expenses
EVENTS_DATA=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}/api/reports/cash-register-events?from=${TODAY}&to=${TODAY}")
EXPENSES_DATA=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}/api/reports/expenses?from=${TODAY}&to=${TODAY}")

echo "$EVENTS_DATA" > /tmp/events.json
echo "$EXPENSES_DATA" > /tmp/expenses.json

python3 << 'PYTHON_SCRIPT'
import json

try:
    with open('/tmp/events.json') as f:
        events = json.load(f)
    with open('/tmp/expenses.json') as f:
        expenses = json.load(f)
    
    print(f"  Events count: {len(events)}")
    print(f"  Expenses count: {len(expenses)}")
    
    # Check if events include all expected types
    event_types = set(e.get('type') for e in events)
    print(f"  Event types found: {', '.join(sorted(event_types))}")
    
    # Calculate totals
    entry_total = sum(float(e.get('amount', 0)) for e in events if e.get('type') == 'entry')
    expense_total = sum(float(e.get('amount', 0)) for e in events if e.get('type') == 'expense')
    
    print(f"\n  Calculated from events:")
    print(f"    Total entries: {entry_total}")
    print(f"    Total expenses from events: {expense_total}")
    
    # Check expenses list
    expenses_list_total = sum(float(e.get('amount', 0)) for e in expenses)
    print(f"    Total from expenses endpoint: {expenses_list_total}")
    
    # Discrepancy check
    if abs(expense_total - expenses_list_total) > 0.01:
        print(f"\n  ⚠️  WARNING: Expense totals don't match!")
        print(f"    Events show: {expense_total}")
        print(f"    Expenses endpoint shows: {expenses_list_total}")
        exit(1)
    else:
        print(f"\n  ✓ Expense totals are consistent")
        exit(0)
        
except Exception as e:
    print(f"\n  ✗ Error analyzing data: {e}")
    exit(1)
PYTHON_SCRIPT

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Combined events calculation logic is correct${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗ Discrepancy found in combined events${NC}"
    FAILED=$((FAILED + 1))
    ISSUES+=("Combined Events: Expense totals mismatch between events and expenses endpoints")
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
    echo -e "${YELLOW}Issues Found:${NC}"
    for issue in "${ISSUES[@]}"; do
        echo -e "${YELLOW}  • ${issue}${NC}"
    done
fi

echo ""

if [ $FAILED -eq 0 ] && [ ${#ISSUES[@]} -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed with no issues!${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠ Some tests failed or issues were detected${NC}"
    exit 1
fi
