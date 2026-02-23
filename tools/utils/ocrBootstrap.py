import os
import shutil
import sys


def ensure_tesseract():
    """Ensure pytesseract is configured to use a deterministic tesseract binary.

    - Prefers `which tesseract` if available, otherwise falls back to `/usr/local/bin/tesseract`.
    - Prints a debug line with selected path.
    - Raises RuntimeError("Tesseract binary not found") if the binary is missing.
    - Raises RuntimeError("pytesseract not available") if pytesseract cannot be imported.
    """
    try:
        import pytesseract
    except Exception:
        raise RuntimeError("pytesseract not available")

    tesseract_path = shutil.which("tesseract") or "/usr/local/bin/tesseract"

    if not os.path.exists(tesseract_path):
        raise RuntimeError("Tesseract binary not found")

    # Force pytesseract to use our resolved binary
    pytesseract.pytesseract.tesseract_cmd = tesseract_path

    # Debug output consumed by Node logs (printed to stdout)
    print(f"[OCR DEBUG] Using tesseract at: {tesseract_path}")
    sys.stdout.flush()

    return tesseract_path
