# OCR Extraction - Quick Reference

## What Was Fixed

| Issue             | Fix                                        | Impact                       |
| ----------------- | ------------------------------------------ | ---------------------------- |
| Wrong Python used | Uses venv Python instead of system python3 | Packages available ✅        |
| Slow startup      | Global cached OCR instance                 | First run: 10-20s, next: <1s |
| Timeout errors    | Increased timeout 60s → 120s               | Handles larger images        |
| Double extensions | File extension check logic                 | No `.png.png` issues         |

## Start Using

### 1. Ensure Backend is Running

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm start
```

### 2. Upload Invoice via Frontend

- **Mobile**: `beypro-admin-mobile` → Suppliers → Upload Receipt
- **Web**: `hurryposdash-vite` → Suppliers → Upload Receipt

### 3. Items Auto-Extract

Frontend shows extracted items, click to add to transaction

## Test Manually

```bash
# Direct extraction test
cd /Users/nurikord/PycharmProjects/hurrypos-backend
.venv/bin/python tools/supplier_invoice_item_extractor.py /path/to/invoice.jpg 1

# Should output JSON with extracted items
```

## Files Changed

```
✓ /routes/suppliers.js                                    (+15 lines, venv Python)
✓ /tools/supplier_invoice_item_extractor.py              (+30 lines, caching)
✓ (No changes needed in frontend - already configured)
```

## Endpoints

| Method | URL                                 | Purpose                          |
| ------ | ----------------------------------- | -------------------------------- |
| POST   | `/suppliers/invoices/extract-items` | Extract items from invoice image |

**Request:**

```
Content-Type: multipart/form-data
- file: image file (JPG/PNG)
- supplier_id: optional supplier ID
```

**Response:**

```json
{
  "success": true,
  "items": [
    {"name": "Elma", "quantity": 50, "unit": "kg", "total_cost": 250},
    ...
  ],
  "item_count": 5,
  "message": "Extracted 5 items from invoice"
}
```

## Troubleshooting

| Problem              | Check           | Fix                                               |
| -------------------- | --------------- | ------------------------------------------------- |
| Backend won't start  | DB connection   | Backend starts even with DB timeout, retry upload |
| No items extracted   | Image quality   | Try clearer/higher res image                      |
| Script times out     | First run?      | First run takes 10-20s, wait longer               |
| Wrong Python version | `which python3` | Confirm using `.venv/bin/python` ✓                |
| Module not found     | venv activated  | Dependencies in `.venv` ✓                         |

## Performance Expectations

| Scenario               | Time                   |
| ---------------------- | ---------------------- |
| First OCR extraction   | 10-20 seconds          |
| Subsequent extractions | 1-3 seconds            |
| API request timeout    | 120 seconds            |
| Backend processing     | <500ms (excluding OCR) |

## Key Paths

```
Backend:           /Users/nurikord/PycharmProjects/hurrypos-backend/
Python venv:       .venv/bin/python
OCR script:        tools/supplier_invoice_item_extractor.py
Backend route:     routes/suppliers.js
Mobile frontend:   ../beypro-admin-mobile/app/suppliers/index.tsx
Web frontend:      ../hurryposdashboard/hurryposdash-vite/src/pages/Suppliers.jsx
```

## Environment Variables (Optional)

```bash
# Set before running backend:
export PADDLE_OCR_LANG="tr"              # Turkish (default)
export NODE_ENV="development"             # For more logs
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True"  # Skip connectivity check
```

## Success Checklist

- [ ] Backend running on localhost:3001
- [ ] Python imports work (paddleocr, cv2, numpy)
- [ ] Can upload image from mobile/web
- [ ] Items appear in transaction rows
- [ ] Backend logs show "Extracted X items"
- [ ] No timeout errors
- [ ] Turkish characters display correctly

## Version Info

- Python: 3.13.2
- PaddleOCR: Latest (with Turkish model)
- Node.js: Check with `node --version`
- Virtual Env: `.venv/bin/python`

## Quick Fixes

```bash
# Restart backend
pkill -f "node.*server.js"
npm start

# Reinstall Python deps
pip install --upgrade paddleocr paddlepaddle opencv-python numpy

# Clear Python cache
find . -type d -name "__pycache__" -exec rm -rf {} +

# Test script directly
.venv/bin/python tools/supplier_invoice_item_extractor.py test.jpg 0
```

---

**For detailed info:** See `OCR_FIX_SUMMARY.md` and `VERIFICATION_GUIDE.md`
