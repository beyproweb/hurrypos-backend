# OCR Setup & Dependencies

## Required Python Packages

The OCR system uses multiple engines. Install all for best compatibility:

### Quick Install

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend

# Install Paddle OCR
pip install paddleocr paddlepaddle opencv-python numpy

# Install Tesseract (if not already installed)
# On macOS:
brew install tesseract

# On Ubuntu/Debian:
# sudo apt-get install tesseract-ocr

# On CentOS/RHEL:
# sudo yum install tesseract
```

### Install Turkish Language Models

```bash
# Tesseract Turkish
brew install tesseract-lang

# PaddleOCR Turkish (automatic on first use, or manually):
python3 -c "from paddleocr import PaddleOCR; PaddleOCR(lang='tr')"
```

## Environment Setup

Add to `.env` or shell profile for Turkish invoice optimization:

```bash
# Use Turkish language for better accuracy
export PADDLE_OCR_LANG="tr"
export TESSERACT_LANG="tur+eng"

# Allow automatic fallback between engines
export SUPPLIER_OCR_AUTO_PADDLE_FALLBACK="true"

# Increase preprocessing quality for difficult invoices
export SUPPLIER_OCR_DEEP_SCAN="false"  # Set to "true" for slower but more accurate

# Timeout settings (milliseconds)
export SUPPLIER_OCR_PADDLE_TIMEOUT_MS="45000"
export SUPPLIER_OCR_TESS_TIMEOUT_MS="30000"

# Thread settings for performance
export OMP_NUM_THREADS="1"
export MKL_NUM_THREADS="1"
```

## Verify Installation

```bash
# Test Paddle OCR
python3 -c "from paddleocr import PaddleOCR; ocr = PaddleOCR(lang='tr'); print('✓ PaddleOCR working')"

# Test Tesseract
tesseract --version | grep "tesseract"
tesseract --list-langs | grep "tur"

# Test OpenCV
python3 -c "import cv2; print(f'✓ OpenCV {cv2.__version__} working')"
```

## Backend Dependencies

Make sure these are installed in the Node backend:

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend

npm install --save sharp  # Image processing
```

Check `package.json`:

```json
{
  "dependencies": {
    "sharp": "^0.32.0"
  }
}
```

## Troubleshooting

### Paddle OCR not found

```bash
pip list | grep paddle
# If missing: pip install paddleocr
```

### Tesseract not found

```bash
which tesseract
# If missing: brew install tesseract
```

### Turkish models not installed

```bash
python3 -c "from paddleocr import PaddleOCR; PaddleOCR(lang='tr')"
# Wait for first-time model download
```

### OpenCV import error

```bash
pip install opencv-python
# Or: pip install opencv-contrib-python  # for more features
```

### Insufficient permissions

```bash
# If you get permission errors, use --user flag:
pip install --user paddleocr opencv-python numpy
```

## Testing with Real Invoice

1. Start the backend:

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm run dev
```

2. Upload an invoice image via the web UI:
   - Navigate to Suppliers → Add Product
   - Upload Turkish invoice image

3. Check logs for OCR processing:

```bash
# Watch backend logs
npm run dev 2>&1 | grep -i "ocr"
```

Expected output:

```
✓ Using Tesseract first (faster)
✓ Successfully parsed X items
OR
✓ Falling back to paddle after weak tesseract OCR parse
✓ Paddle OCR with Turkish models recognized Y fields
```

## Performance Tips

1. **Keep images < 5MB** - Resize if needed
2. **Use PNG format** - Best compatibility
3. **Ensure good lighting** - Helps with text detection
4. **Level the document** - Portrait orientation preferred
5. **High DPI preferred** - 300+ DPI for best accuracy

## GPU Acceleration (Optional)

For faster OCR with GPU:

```bash
# Install GPU-enabled Paddle
pip install paddlepaddle-gpu

# Set environment variable
export CUDA_VISIBLE_DEVICES="0"  # GPU ID
```

This will significantly speed up OCR processing but requires CUDA setup.
