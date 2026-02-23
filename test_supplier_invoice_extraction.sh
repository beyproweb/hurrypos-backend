#!/bin/bash
# test_supplier_invoice_extraction.sh
# Test script for supplier invoice item extraction

set -e

# Configuration
API_URL="${API_URL:-http://localhost:3000}"
TOKEN="${TOKEN:-}"
SUPPLIER_ID="${SUPPLIER_ID:-1}"
INVOICE_FILE="${1:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
}

# Check prerequisites
check_prerequisites() {
  log_info "Checking prerequisites..."
  
  if [ -z "$TOKEN" ]; then
    log_warning "TOKEN not set. Use: TOKEN=your_token $0"
    # TOKEN="dummy" # For testing without auth
  fi
  
  if ! command -v curl &> /dev/null; then
    log_error "curl not found. Please install curl."
    exit 1
  fi
  
  if ! command -v python3 &> /dev/null; then
    log_error "python3 not found. Please install Python 3."
    exit 1
  fi
  
  log_success "Prerequisites OK"
}

# Check backend is running
check_backend() {
  log_info "Checking backend at $API_URL..."
  
  if ! curl -s "$API_URL/health" > /dev/null 2>&1; then
    log_warning "Backend may not be running at $API_URL"
    log_info "Start backend with: npm run dev"
  else
    log_success "Backend is running"
  fi
}

# Install Python dependencies
install_python_deps() {
  log_info "Checking Python dependencies..."
  
  python3 -c "import paddleocr" 2>/dev/null || {
    log_warning "PaddleOCR not installed. Installing..."
    pip install paddleocr paddlepaddle opencv-python numpy -q
    log_success "Python dependencies installed"
  }
  
  log_info "Downloading Turkish OCR models..."
  python3 -c "from paddleocr import PaddleOCR; PaddleOCR(lang='tr')" > /dev/null 2>&1 || {
    log_warning "Could not download models, this may be done on first use"
  }
  
  log_success "Python dependencies OK"
}

# Create test invoice image (optional)
create_test_invoice() {
  log_info "Creating test invoice image..."
  
  python3 << 'EOF'
import json
from PIL import Image, ImageDraw, ImageFont
import os

# Create simple test invoice image
width, height = 800, 600
image = Image.new('RGB', (width, height), 'white')
draw = ImageDraw.Draw(image)

# Try to use default font, fallback to empty string if not available
try:
    font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", 16)
    font_title = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", 24)
except:
    font = ImageFont.load_default()
    font_title = font

# Draw invoice
y = 20
draw.text((20, y), "DENIZMEŞRUBAT - e-FATURA", fill='black', font=font_title)
y += 40

# Draw table header
headers = "No | Ürün Kodu | Mal Hizmet | Miktar | Birim | Toplam Tutar"
draw.text((20, y), headers, fill='black', font=font)
y += 30

# Draw sample items
items = [
    "1 | COCA-COLA KUTU | 330ml 1X24 DYS | 6 | Koli | 2,380.00 TL",
    "2 | CC ZERO SUGAR KUTU | 330ml | 2 | Koli | 522.60 TL",
    "3 | COCA-COLA PET 1L | 1L | 3 | Koli | 710.61 TL",
]

for item in items:
    draw.text((20, y), item, fill='black', font=font)
    y += 25

# Save
path = "/tmp/test_invoice.png"
image.save(path)
print(json.dumps({"status": "created", "path": path}))
EOF
}

# Upload and extract items
extract_items() {
  local invoice_path="$1"
  
  if [ ! -f "$invoice_path" ]; then
    log_error "Invoice file not found: $invoice_path"
    return 1
  fi
  
  log_info "Uploading invoice and extracting items..."
  log_info "File: $invoice_path"
  log_info "Supplier ID: $SUPPLIER_ID"
  
  local headers=(-H "Content-Type: multipart/form-data")
  if [ ! -z "$TOKEN" ]; then
    headers+=(-H "Authorization: Bearer $TOKEN")
  fi
  
  local response=$(curl -s \
    "${headers[@]}" \
    -F "file=@$invoice_path" \
    -F "supplier_id=$SUPPLIER_ID" \
    "$API_URL/suppliers/invoices/extract-items")
  
  echo "$response"
}

# Display results
display_results() {
  local json_output="$1"
  
  log_info "Extraction Results:"
  echo "---"
  
  # Check for errors
  if echo "$json_output" | grep -q '"error"'; then
    log_error "Extraction failed:"
    echo "$json_output" | python3 -m json.tool 2>/dev/null || echo "$json_output"
    return 1
  fi
  
  # Display summary
  local item_count=$(echo "$json_output" | python3 -c "import sys, json; print(json.load(sys.stdin).get('item_count', 0))" 2>/dev/null || echo "0")
  local ocr_status=$(echo "$json_output" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ocr_status', 'unknown'))" 2>/dev/null || echo "unknown")
  
  log_success "Extraction completed"
  echo "  Items extracted: $item_count"
  echo "  OCR status: $ocr_status"
  
  # Display items table
  if [ "$item_count" -gt 0 ]; then
    echo ""
    log_info "Extracted Items:"
    echo "$json_output" | python3 << 'PYTHON_EOF'
import sys, json

data = json.load(sys.stdin)
items = data.get('items', [])

if items:
    print(f"{'Name':<30} | {'Qty':>5} | {'Unit':<10} | {'Price':>12}")
    print("-" * 70)
    for item in items:
        name = (item.get('name', 'N/A')[:28]).ljust(28)
        qty = str(item.get('quantity', 'N/A')).rjust(5)
        unit = (item.get('unit', 'N/A')[:8]).ljust(8)
        price = f"{item.get('total_price', 0):.2f} {item.get('currency', 'TRY')}"
        price = price.rjust(12)
        print(f"{name} | {qty} | {unit} | {price}")
PYTHON_EOF
  fi
  
  echo ""
  log_info "Full JSON response:"
  echo "$json_output" | python3 -m json.tool 2>/dev/null || echo "$json_output"
}

# Save results
save_results() {
  local json_output="$1"
  local output_file="${2:-extracted_items_$(date +%s).json}"
  
  echo "$json_output" > "$output_file"
  log_success "Results saved to: $output_file"
}

# Main execution
main() {
  log_info "========================================="
  log_info "Supplier Invoice Item Extractor - Test"
  log_info "========================================="
  echo ""
  
  # Check environment
  check_prerequisites
  check_backend
  install_python_deps
  
  echo ""
  
  # Determine invoice file
  if [ -z "$INVOICE_FILE" ]; then
    log_info "No invoice file provided, creating test invoice..."
    create_test_invoice
    INVOICE_FILE="/tmp/test_invoice.png"
  fi
  
  echo ""
  
  # Extract items
  result=$(extract_items "$INVOICE_FILE")
  
  # Display results
  display_results "$result"
  
  # Save results
  echo ""
  save_results "$result"
  
  echo ""
  log_success "Test completed!"
}

# Run main
main
