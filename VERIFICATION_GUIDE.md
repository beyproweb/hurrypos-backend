# OCR Extraction System - Verification Guide

## System Architecture

```
User uploads invoice (JPG/PNG)
        ↓
[Mobile App / Web Dashboard]
  ↓
POST /suppliers/invoices/extract-items
  ↓
[Node.js Backend - routes/suppliers.js]
  ├─ Receive file upload via multer
  ├─ Preprocess with Sharp (rotate, resize, grayscale)
  ├─ Invoke Python script with venv Python
  └─ Return extracted items JSON
  ↓
[Python Script - tools/supplier_invoice_item_extractor.py]
  ├─ Load cached PaddleOCR (Turkish language)
  ├─ Preprocess image (enhance, denoise)
  ├─ Run OCR on image
  ├─ Parse OCR text to extract items
  └─ Output JSON with item details
  ↓
Frontend receives response
  ├─ Parse JSON items
  ├─ Populate transaction rows
  └─ Display to user
```

## Verification Checklist

### ✅ Step 1: Python Environment

```bash
# Navigate to backend
cd /Users/nurikord/PycharmProjects/hurrypos-backend

# Verify virtual environment exists
ls -la .venv/bin/python

# Test imports
.venv/bin/python -c "from paddleocr import PaddleOCR; import cv2; import numpy; print('✅ All imports OK')"
```

Expected output: `✅ All imports OK`

### ✅ Step 2: Python Script Execution

```bash
# Test script with non-existent image (should fail gracefully)
.venv/bin/python tools/supplier_invoice_item_extractor.py /nonexistent/image.png 0

# Should output JSON error
```

Expected output:

```json
{ "error": "Image not found: /nonexistent/image.png" }
```

### ✅ Step 3: Backend API Endpoint

```bash
# Check endpoint is registered in suppliers.js
grep -n "invoices/extract-items" routes/suppliers.js

# Should find: router.post("/invoices/extract-items", ...)
```

### ✅ Step 4: Backend Runtime Check

```bash
# Check if backend is running
curl -s http://localhost:3001/suppliers | head -c 20

# If connected, should return some data or empty array

# If not connected, start backend:
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm start
```

### ✅ Step 5: Full Integration Test

**Mobile App (beypro-admin-mobile):**

1. Open mobile app in Expo
2. Navigate to Suppliers section
3. Find "Add from Receipt" or upload invoice option
4. Select a JPG/PNG invoice image
5. Check if:
   - File uploads successfully
   - Backend processes (check backend logs)
   - Items appear in transaction rows
   - Item names look correct

**Web Dashboard (hurryposdashboard):**

1. Open web dashboard at `http://localhost:5173` (or configured URL)
2. Navigate to Suppliers page
3. Find receipt upload option
4. Select a JPG/PNG invoice image
5. Check if:
   - File uploads successfully
   - Items populate in form
   - Data looks reasonable

### ✅ Step 6: Backend Logs

Monitor backend console for messages like:

**Success indicators:**

```
[suppliers] Received file upload for extract-items
[suppliers] Image preprocessing completed
✅ Python script executed successfully
[suppliers] Extracted 5 items from invoice
```

**Error indicators to watch for:**

```
❌ Python script error: [error details]
Python script timed out after 120 seconds
Image preprocessing failed: [reason]
Failed to parse Python output
```

## Common Issues & Solutions

### Issue: "Module not found" errors

**Solution:**

```bash
# Reinstall dependencies
cd /Users/nurikord/PycharmProjects/hurrypos-backend
source .venv/bin/activate
pip install --upgrade paddleocr paddlepaddle opencv-python numpy
```

### Issue: Script times out on first run

**Expected:** First run takes 10-30 seconds (downloading models)
**Solution:** Be patient, let it complete. Subsequent runs will be <3 seconds

### Issue: "Connection refused" on localhost:3001

**Solution:**

```bash
# Start backend
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm start

# Wait for startup message showing port 3001 is listening
```

### Issue: Image file has `.png.png` extension in logs

**Solution:** Already fixed in latest code. If you see this, ensure you have the latest version of `/routes/suppliers.js`

### Issue: No items extracted from valid invoice

**Possible causes:**

- Image quality too low
- Text not clearly visible
- Language not Turkish (check PADDLE_OCR_LANG environment variable)
- OCR failed silently (check backend logs for warnings)

## File Locations

**Key files to check/modify:**

```
Backend:
├── routes/suppliers.js          (POST /suppliers/invoices/extract-items endpoint)
├── tools/supplier_invoice_item_extractor.py  (OCR processing script)
├── .venv/                       (Virtual environment with dependencies)
└── uploads/receipts/            (Temporary uploaded file storage)

Mobile Frontend:
├── beypro-admin-mobile/
└── app/suppliers/index.tsx      (uploadReceiptToCloud function)

Web Frontend:
├── hurryposdashboard/hurryposdash-vite/
└── src/pages/Suppliers.jsx      (handleReceiptFileSelect function)
```

## Debug Commands

**Clear Python cache:**

```bash
find /Users/nurikord/PycharmProjects/hurrypos-backend -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null
```

**Test OCR models are downloaded:**

```bash
ls -lah ~/.paddlepaddle/models/
# Should see directory with model files

# If empty, models will download on first OCR use
```

**Test image preprocessing manually:**

```python
#!/usr/bin/env python3
import sys
sys.path.insert(0, '/Users/nurikord/PycharmProjects/hurrypos-backend')

from tools.supplier_invoice_item_extractor import preprocess_image
result = preprocess_image("/path/to/image.png")
print(f"Preprocessed: {result}")
```

**Test extraction end-to-end:**

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
.venv/bin/python tools/supplier_invoice_item_extractor.py /path/to/real/invoice.jpg 1 | jq .
```

## Performance Monitoring

**Check extraction speed:**

```bash
# Time the extraction
time .venv/bin/python tools/supplier_invoice_item_extractor.py test-image.png 1

# Should complete in 1-3 seconds after first run
```

**Monitor memory usage:**

```bash
# Watch backend process
top -p $(pgrep -f "node.*server.js")

# PaddleOCR uses ~500MB-1GB RAM, normal for this size model
```

**Check file sizes:**

```bash
# PaddleOCR model directory
du -sh ~/.paddlepaddle/models/

# Should be 100-200MB total
```

## Success Criteria

You'll know everything is working when:

✅ Backend starts without errors
✅ Python imports work (`paddleocr`, `cv2`, `numpy`)
✅ Script runs on test image and returns JSON
✅ Upload from mobile/web triggers extraction
✅ Transaction rows populate with extracted items
✅ Item names are readable and correct
✅ Quantities and prices look reasonable
✅ No timeout errors on subsequent uploads
✅ Turkish characters display correctly in extracted text

## Next: Production Deployment

Once verified, for production:

1. Test with various invoice formats
2. Verify Turkish character handling
3. Monitor backend resource usage
4. Consider caching OCR results for repeated invoices
5. Set up error logging/alerting for failed extractions
6. Document expected extraction accuracy limits
