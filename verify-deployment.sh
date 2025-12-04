#!/bin/bash
# Backend Deployment Verification Script
# Tests printer detection endpoints after deployment

set -e

echo "🔍 Backend Deployment Verification"
echo "===================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# API endpoints
API_BASE="https://hurrypos-backend.onrender.com/api"

# Helper function to test endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local expected_code=$3
    local data=$4
    
    echo -n "Testing $method $endpoint... "
    
    if [ -z "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$API_BASE$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$API_BASE$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [[ "$http_code" =~ ^($expected_code|200|201)$ ]]; then
        echo -e "${GREEN}✅ ($http_code)${NC}"
        
        # Show first 100 chars of response
        if [ -n "$body" ] && [ "$body" != "null" ]; then
            echo "  Response: $(echo "$body" | head -c 100)..."
        fi
    else
        echo -e "${RED}❌ (Expected 200, got $http_code)${NC}"
        echo "  Response: $(echo "$body" | head -c 100)..."
    fi
    echo ""
}

# Wait for Render to be ready
echo -e "${YELLOW}⏳ Waiting for backend to be ready...${NC}"
for i in {1..30}; do
    if curl -s "$API_BASE/printer-settings/status" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Backend is online${NC}"
        break
    fi
    echo -n "."
    sleep 2
done
echo ""
echo ""

# Test endpoints
echo -e "${BLUE}Testing Printer Detection Endpoints:${NC}"
echo ""

test_endpoint "GET" "/printer-settings/status" "200"

test_endpoint "GET" "/printer-settings/printers" "200"

test_endpoint "POST" "/printer-settings/lan-scan" "200" '{"subnet":"192.168.1","fingerprint":true}'

test_endpoint "GET" "/printer-settings/discover-network" "200"

echo -e "${BLUE}Testing ESC/POS Fingerprinting:${NC}"
echo ""

# Test with a specific IP (if available)
test_endpoint "POST" "/printer-settings/lan-scan" "200" '{"ip":"192.168.1.100","fingerprint":true}'

echo ""
echo -e "${GREEN}✨ Verification Complete!${NC}"
echo ""

echo -e "${BLUE}Endpoint Status Summary:${NC}"
echo "  /printer-settings/status        → Check backend health"
echo "  /printer-settings/printers      → List USB/Serial printers"
echo "  /printer-settings/lan-scan      → Scan network with fingerprinting"
echo "  /printer-settings/discover-network → Auto-discover printers"
echo ""

echo -e "${YELLOW}📊 Deployment Info:${NC}"
echo "  Backend: https://hurrypos-backend.onrender.com"
echo "  Repository: https://github.com/beyproweb/hurrypos-backend"
echo "  Branch: main"
echo ""

echo -e "${YELLOW}📖 View deployment logs:${NC}"
echo "  https://dashboard.render.com/services/..."
