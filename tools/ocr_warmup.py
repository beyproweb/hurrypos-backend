#!/usr/bin/env python3
"""
OCR Warmup Script - Pre-initializes PaddleOCR on backend startup

This script is called during backend initialization to warm up the PaddleOCR cache,
preventing timeout errors on the first invoice upload request.

Without this, first requests timeout because PaddleOCR needs 20-30 seconds to initialize
and download models on first use.
"""

import json
import sys
import os

try:
    # Suppress verbose logging
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
    
    import warnings
    warnings.filterwarnings("ignore")
    
    # Redirect stderr
    import io
    _stderr_original = sys.stderr
    sys.stderr = io.StringIO()
    
    from paddleocr import PaddleOCR
    
    # Restore stderr
    sys.stderr = _stderr_original
    
    # Initialize with Turkish language
    lang = os.environ.get("PADDLE_OCR_LANG", "tr")
    print(f"Initializing PaddleOCR with language: {lang}")
    
    ocr = PaddleOCR(lang=lang, use_doc_orientation_classify=False)
    
    print(json.dumps({
        "status": "success",
        "message": "PaddleOCR initialized and cached",
        "language": lang
    }))
    sys.exit(0)

except Exception as e:
    sys.stderr = _stderr_original if '_stderr_original' in locals() else sys.stderr
    import traceback
    print(json.dumps({
        "status": "error",
        "error": str(e),
        "error_type": type(e).__name__,
        "details": traceback.format_exc()
    }))
    sys.exit(0)  # Exit 0 so backend doesn't fail to start
