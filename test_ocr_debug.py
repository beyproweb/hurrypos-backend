#!/usr/bin/env python3
import sys
import os
import time

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

print("[1] Starting script", file=sys.stderr, flush=True)
sys.stderr.flush()

try:
    print("[2] About to import PaddleOCR", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    from paddleocr import PaddleOCR
    
    print("[3] PaddleOCR imported", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    print("[4] Creating OCR instance", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    start = time.time()
    ocr = PaddleOCR(lang='tr', use_doc_orientation_classify=False)
    elapsed = time.time() - start
    
    print(f"[5] OCR instance created in {elapsed:.2f}s", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    print("[6] Running OCR", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    result = ocr.ocr("/Users/nurikord/PycharmProjects/hurrypos-backend/uploads/receipts/receipt-1771011323518-356128886.ocr.png")
    
    print(f"[7] OCR complete, got {len(result[0]) if result and result[0] else 0} text boxes", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    print(f"SUCCESS: {len(result[0]) if result and result[0] else 0} items found", file=sys.stdout, flush=True)
    
except Exception as e:
    import traceback
    print(f"[ERROR] {e}", file=sys.stderr, flush=True)
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
