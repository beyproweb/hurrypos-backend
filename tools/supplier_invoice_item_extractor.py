#!/usr/bin/env python3
"""
Supplier Invoice Item Extractor - OCR-based item extraction and product addition
"""

import sys
import json
import os

def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}

def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return int(default)
    try:
        return int(raw)
    except Exception:
        return int(default)

def safe_json_print(payload) -> None:
    """Print JSON safely so the caller always receives parseable output."""
    try:
        body = json.dumps(payload, ensure_ascii=False)
    except Exception as serialization_error:
        fallback = {
            "error": "Failed to serialize OCR response",
            "error_type": type(serialization_error).__name__,
            "success": False,
        }
        try:
            body = json.dumps(fallback, ensure_ascii=False)
        except Exception:
            body = '{"error":"Failed to serialize OCR response","success":false}'
    try:
        sys.stdout.write(body + "\n")
        sys.stdout.flush()
    except Exception:
        # Last-resort write path
        print(body, flush=True)

# Global variables
_stderr_original = sys.stderr
_ocr_instance = None
cv2 = None
np = None

try:
    # Setup environment early, before any imports
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
    os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

    # Suppress warnings
    import warnings
    warnings.filterwarnings("ignore")

    # Standard library imports - these should always work
    import re
    import tempfile
    import shutil
    import subprocess
    import threading
    import time
    import unicodedata
    from typing import List, Dict, Any, Tuple, Optional

    # Redirect stderr BEFORE any PaddleOCR-related imports
    import io
    _stderr_original = sys.stderr
    sys.stderr = io.StringIO()

    # Try importing cv2 and numpy first (these are lighter weight)
    try:
        import cv2
        import numpy as np
    except ImportError:
        pass  # Will use fallback

    # Only import PaddleOCR when we actually need it (lazy import in get_ocr)
    # Don't import it here!

    # Restore stderr
    sys.stderr = _stderr_original

except Exception as e:
    sys.stderr = _stderr_original if '_stderr_original' in locals() else sys.stderr
    import traceback
    safe_json_print({
        "error": f"Initialization failed: {str(e)}",
        "error_type": type(e).__name__,
        "details": traceback.format_exc(),
        "success": False,
    })
    sys.stdout.flush()
    sys.stderr.flush()
    sys.exit(1)

# Global cached OCR instance
_ocr_instance = None
_ocr_lock = None

def get_ocr():
    """Get or build cached PaddleOCR instance - lazy imports PaddleOCR on first call"""
    global _ocr_instance
    
    # Return cached instance if available
    if _ocr_instance is not None:
        return _ocr_instance
    
    print("[DEBUG] Starting OCR initialization", file=sys.stderr, flush=True)
    sys.stderr.flush()
    
    try:
        # Check if models are already cached
        paddle_cache_dir = os.path.expanduser("~/.paddlex/official_models")
        if os.path.exists(paddle_cache_dir):
            cached_models = os.listdir(paddle_cache_dir)
            print(f"[DEBUG] Found {len(cached_models)} cached Paddle models", file=sys.stderr, flush=True)
            sys.stderr.flush()
        
        # Import PaddleOCR here, not at module level
        print("[DEBUG] Importing PaddleOCR...", file=sys.stderr, flush=True)
        sys.stderr.flush()
        
        from paddleocr import PaddleOCR
        
        print("[DEBUG] PaddleOCR imported", file=sys.stderr, flush=True)
        sys.stderr.flush()
        
        lang = os.environ.get("PADDLE_OCR_LANG", "tr")
        if lang.lower() in ["tr", "turkish"]:
            lang = "tr"
        elif "tr" not in lang.lower():
            lang = f"{lang}+tr" if lang != "en" else "tr"
        
        print(f"[DEBUG] Creating OCR instance with lang={lang}", file=sys.stderr, flush=True)
        sys.stderr.flush()
        
        # Initialize PaddleOCR - this might take time on first call
        _ocr_instance = PaddleOCR(lang=lang, use_doc_orientation_classify=False)
        
        print("[DEBUG] OCR instance created successfully", file=sys.stderr, flush=True)
        sys.stderr.flush()
        
        return _ocr_instance
            
    except Exception as e:
        print(f"[DEBUG] Exception in get_ocr: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        sys.stderr.flush()
        raise RuntimeError(f"Failed to load PaddleOCR: {str(e)}")

def build_ocr():
    """Build PaddleOCR instance - kept for backward compatibility"""
    return get_ocr()


def preprocess_image(image_path: str) -> str:
    """
    Preprocess invoice image for better OCR speed and stability.
    - Downscale large images (hard pixel guard)
    - Enhance contrast
    - Reduce noise
    - Apply binary threshold
    """
    if cv2 is None or np is None:
        return image_path
    
    try:
        img = cv2.imread(image_path)
        if img is None:
            return image_path

        height, width = img.shape[:2]
        max_side = max(1024, env_int("SUPPLIER_OCR_MAX_SIDE", 1600))
        max_pixels = max(1_500_000, env_int("SUPPLIER_OCR_MAX_PIXELS", 2_500_000))
        scale = 1.0
        largest_side = max(height, width)
        pixel_count = height * width
        if largest_side > max_side:
            scale = min(scale, max_side / float(largest_side))
        if pixel_count > max_pixels:
            scale = min(scale, (max_pixels / float(pixel_count)) ** 0.5)

        if scale < 0.999:
            new_width = max(1, int(width * scale))
            new_height = max(1, int(height * scale))
            img = cv2.resize(img, (new_width, new_height), interpolation=cv2.INTER_AREA)
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        # Denoise
        denoised = cv2.fastNlMeansDenoising(enhanced, h=10)
        
        # Apply binary threshold
        _, binary = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Save preprocessed image
        temp_path = f"{image_path}.preprocessed.png"
        cv2.imwrite(temp_path, binary)
        return temp_path
    except Exception as e:
        # Silently return original if preprocessing fails
        return image_path


def run_tesseract_ocr(image_path: str) -> Dict[str, Any]:
    """Run OCR via Tesseract CLI (safe/default path)."""
    tesseract_bin = os.environ.get("SUPPLIER_TESSERACT_BIN", "tesseract")
    has_tesseract = os.path.exists(tesseract_bin) if os.path.isabs(tesseract_bin) else shutil.which(tesseract_bin)
    if not has_tesseract:
        raise RuntimeError(f"Tesseract binary not found: {tesseract_bin}")

    timeout_ms = max(5000, env_int("SUPPLIER_OCR_TESS_TIMEOUT_MS", 45000))
    psm = max(3, min(13, env_int("SUPPLIER_OCR_TESS_PSM", 6)))
    language = os.environ.get("TESSERACT_LANG") or os.environ.get("SUPPLIER_OCR_TESSERACT_LANG", "tur+eng")
    cmd = [
        tesseract_bin,
        image_path,
        "stdout",
        "-l",
        language,
        "--oem",
        "1",
        "--psm",
        str(psm),
        "-c",
        "preserve_interword_spaces=1",
    ]

    start = time.time()
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_ms / 1000.0,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Tesseract timeout after {timeout_ms}ms") from exc

    if proc.returncode != 0:
        err = str(proc.stderr or "").strip()
        lower_err = err.lower()
        language_problem = (
            "failed loading language" in lower_err
            or "error opening data file" in lower_err
            or "could not initialize tesseract" in lower_err
        )
        if language_problem and language != "eng":
            fallback_cmd = cmd[:]
            fallback_cmd[fallback_cmd.index(language)] = "eng"
            proc = subprocess.run(
                fallback_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout_ms / 1000.0,
            )
            if proc.returncode != 0:
                err = str(proc.stderr or "").strip()
                raise RuntimeError(f"Tesseract failed (eng fallback): {err or 'unknown error'}")
        else:
            raise RuntimeError(f"Tesseract failed: {err or 'unknown error'}")

    text = str(proc.stdout or "").strip()
    if not text:
        raise RuntimeError("Tesseract returned empty text")

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return {
        "text": text,
        "words": [],
        "line_count": len(lines),
        "success": True,
        "engine": "tesseract",
        "timings": {
            "extraction_ms": int((time.time() - start) * 1000),
        },
    }


def run_paddle_ocr(image_path: str) -> Dict[str, Any]:
    """Run OCR via PaddleOCR (optional fallback path)."""
    start_ocr_init = time.time()
    ocr = get_ocr()
    ocr_init_time = time.time() - start_ocr_init

    start_extraction = time.time()
    result = ocr.ocr(image_path)
    extraction_time = time.time() - start_extraction

    if result is None:
        return {
            "error": "OCR returned no result",
            "text": "",
            "words": [],
            "timings": {
                "ocr_init_ms": int(ocr_init_time * 1000),
                "extraction_ms": int(extraction_time * 1000),
            },
        }

    words = []
    lines = []
    for page_result in result:
        if not page_result:
            continue
        for item in page_result:
            if not item or len(item) < 2:
                continue
            text = str(item[1]).strip() if len(item) > 1 else ""
            if text:
                lines.append(text)
                confidence = 0.0
                if len(item) > 2:
                    try:
                        confidence = float(item[2])
                    except (ValueError, TypeError):
                        confidence = 0.0
                words.append({
                    "text": text,
                    "confidence": confidence,
                })

    return {
        "text": "\n".join(lines),
        "words": words,
        "line_count": len(lines),
        "success": True,
        "engine": "paddle",
        "timings": {
            "ocr_init_ms": int(ocr_init_time * 1000),
            "extraction_ms": int(extraction_time * 1000),
        },
    }


def extract_ocr_text(image_path: str) -> Dict[str, Any]:
    """Extract text from invoice image using safe OCR strategy."""
    preprocessed_path = None
    try:
        start_preprocess = time.time()
        preprocessed_path = preprocess_image(image_path)
        preprocess_time = time.time() - start_preprocess

        mode = str(os.environ.get("SUPPLIER_OCR_MODE", "safe")).strip().lower()
        force_tesseract = env_bool("SUPPLIER_OCR_FORCE_TESSERACT", False)
        allow_paddle_fallback = env_bool("SUPPLIER_OCR_ALLOW_PADDLE_FALLBACK", False)
        warnings = []

        should_try_tesseract = force_tesseract or mode in {"safe", "auto", "fast", "tesseract"}
        if should_try_tesseract:
            try:
                tesseract_result = run_tesseract_ocr(preprocessed_path)
                tesseract_result.setdefault("timings", {})
                tesseract_result["timings"]["preprocess_ms"] = int(preprocess_time * 1000)
                if warnings:
                    tesseract_result["warnings"] = warnings
                return tesseract_result
            except Exception as tesseract_err:
                warnings.append(f"Tesseract failed: {str(tesseract_err)}")
                if force_tesseract or mode == "tesseract" or not allow_paddle_fallback:
                    return {
                        "error": str(tesseract_err),
                        "error_type": type(tesseract_err).__name__,
                        "text": "",
                        "words": [],
                        "success": False,
                        "engine": "tesseract",
                        "warnings": warnings,
                        "timings": {
                            "preprocess_ms": int(preprocess_time * 1000),
                        },
                    }

        if mode == "paddle" or allow_paddle_fallback:
            try:
                paddle_result = run_paddle_ocr(preprocessed_path)
                paddle_result.setdefault("timings", {})
                paddle_result["timings"]["preprocess_ms"] = int(preprocess_time * 1000)
                if warnings:
                    paddle_result["warnings"] = warnings
                return paddle_result
            except Exception as paddle_err:
                return {
                    "error": str(paddle_err),
                    "error_type": type(paddle_err).__name__,
                    "text": "",
                    "words": [],
                    "success": False,
                    "engine": "paddle",
                    "warnings": warnings,
                    "timings": {
                        "preprocess_ms": int(preprocess_time * 1000),
                    },
                }

        return {
            "error": "No OCR engine enabled",
            "error_type": "RuntimeError",
            "text": "",
            "words": [],
            "success": False,
            "warnings": warnings,
            "timings": {
                "preprocess_ms": int(preprocess_time * 1000),
            },
        }
    except Exception as e:
        import traceback
        return {
            "error": str(e), 
            "error_type": type(e).__name__,
            "details": traceback.format_exc(),
            "text": "", 
            "words": []
        }
    finally:
        # Cleanup preprocessed image
        if preprocessed_path and preprocessed_path != image_path and os.path.exists(preprocessed_path):
            try:
                os.remove(preprocessed_path)
            except:
                pass


def parse_currency(text: str) -> str:
    """Parse currency code from text"""
    if not text:
        return "TRY"
    normalized = text.lower()
    if "eur" in normalized or "€" in normalized:
        return "EUR"
    if "usd" in normalized or "$" in normalized:
        return "USD"
    if "try" in normalized or "tl" in normalized or "₺" in normalized:
        return "TRY"
    return "TRY"


def parse_number(value: str) -> Optional[float]:
    """Parse number from text with Turkish locale support"""
    if not value:
        return None
    
    # Clean up
    value = str(value).strip()
    
    # Handle common OCR mistakes
    value = value.replace("O", "0").replace("o", "0")
    value = value.replace("l", "1").replace("I", "1")
    value = value.replace("S", "5")

    negative = value.startswith("-")
    value = re.sub(r"[^0-9,.\-]", "", value).replace("-", "")
    if not value:
        return None

    comma_count = value.count(",")
    dot_count = value.count(".")
    if comma_count > 0 and dot_count > 0:
        if value.rfind(",") > value.rfind("."):
            value = value.replace(".", "").replace(",", ".")
        else:
            value = value.replace(",", "")
    elif comma_count > 1:
        last = value.rfind(",")
        value = value[:last].replace(",", "") + "." + value[last + 1 :].replace(",", "")
    elif dot_count > 1:
        last = value.rfind(".")
        value = value[:last].replace(".", "") + "." + value[last + 1 :].replace(".", "")
    elif comma_count == 1:
        idx = value.rfind(",")
        decimals = len(value) - idx - 1
        if decimals == 3 and idx <= 2:
            value = value.replace(",", "")
        else:
            value = value.replace(",", ".")

    if negative and value:
        value = "-" + value
    
    try:
        return float(value) if value else None
    except ValueError:
        return None


def extract_invoice_items(ocr_text: str) -> List[Dict[str, Any]]:
    """
    Extract individual items from invoice text
    
    Expected format (as in your invoice):
    No | Ürün Kodu | Mal Hizmet | Miktar | Birim | ... | Toplam Tutar
    1  | COCA-COLA KUTU | (330ml 1X24 DYS) | 6 | Koli | ... | 2,380.00 TL
    """
    
    items = []
    lines = ocr_text.split("\n")
    
    # Find header row (contains keywords like "Ürün Kodu", "Mal Hizmet", etc.)
    header_keywords = ["ürün kodu", "mal hizmet", "miktar", "birim", "fiyat", "toplam"]
    header_idx = -1
    
    for idx, line in enumerate(lines):
        line_lower = line.lower()
        if sum(1 for keyword in header_keywords if keyword in line_lower) >= 2:
            header_idx = idx
            break
    
    if header_idx == -1:
        # Try to find item rows by pattern (starts with number, has pricing)
        header_idx = 0
    
    # Parse items starting after header
    current_item = None
    
    for idx, line in enumerate(lines[header_idx + 1:], start=header_idx + 1):
        line = line.strip()
        if not line:
            continue
        
        # Check if line starts with a number (item number)
        if re.match(r"^\d+\s", line):
            # If we have a previous item, save it
            if current_item and current_item.get("name"):
                items.append(current_item)
            
            # Start new item
            current_item = {
                "line_number": None,
                "code": None,
                "name": None,
                "quantity": None,
                "unit": None,
                "unit_price": None,
                "vat_percent": None,
                "total_price": None,
                "currency": "TRY",
                "raw_line": line
            }
            
            # Parse line
            parts = line.split("|")
            if len(parts) > 0:
                current_item["line_number"] = parse_number(parts[0])
            if len(parts) > 1:
                current_item["code"] = parts[1].strip()
            if len(parts) > 2:
                # Product name is usually in position 2
                name_part = parts[2].strip()
                # Remove parenthetical descriptions for now
                current_item["name"] = re.sub(r"\s*\([^)]*\)", "", name_part).strip()
            if len(parts) > 3:
                current_item["quantity"] = parse_number(parts[3])
            if len(parts) > 4:
                current_item["unit"] = parts[4].strip()
            
            # Extract pricing from line (usually at end)
            # Look for pattern like "2,380.00 TL"
            price_pattern = r"(\d+[.,]\d{2})\s*(tl|₺|eur|€|usd|\$)?"
            price_matches = re.findall(price_pattern, line, re.IGNORECASE)
            if price_matches:
                last_price = price_matches[-1]
                current_item["total_price"] = parse_number(last_price[0])
                if len(price_matches) > 1:
                    current_item["unit_price"] = parse_number(price_matches[0][0])
                current_item["currency"] = parse_currency(last_price[1] if last_price[1] else "TRY")
        
        elif current_item and line:
            # Continuation line (e.g., product description)
            # Append to item name if it looks like description
            if line.startswith("(") or re.match(r"^[a-z]", line, re.IGNORECASE):
                if current_item.get("name"):
                    current_item["name"] += f" {line}"
    
    # Don't forget the last item
    if current_item and current_item.get("name"):
        items.append(current_item)

    fallback_items = []
    blocked_tokens = [
        "fatura",
        "seri",
        "sira no",
        "özelleştirme",
        "ozellestirme",
        "ödeme",
        "odeme",
        "vergi",
        "musteri",
        "müşteri",
        "vkn",
        "iban",
        "tel",
        "mersis",
        "toplam",
        "kdv",
        "kredi kart",
        "odenecek",
    ]

    # Fallback parser for OCR output without "|" separators.
    for line in lines:
        raw_line = str(line or "").strip()
        if not raw_line:
            continue

        line_key = re.sub(r"\s+", " ", raw_line.lower())
        if any(token in line_key for token in blocked_tokens):
            continue
        if re.search(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b", raw_line):
            continue

        price_pattern = r"(\d+(?:[.,]\d{2,3})+|\d+[.,]\d{2})\s*(tl|₺|eur|€|usd|\$)?"
        price_matches = re.findall(price_pattern, raw_line, re.IGNORECASE)
        if not price_matches:
            continue

        code_match = re.search(r"\b\d{5,8}\b", raw_line)
        qty_match = re.search(
            r"(\d+(?:[.,]\d+)?)\s*(koli|adet|kg|gr|g|lt|l|ml|paket|kutu|piece)\b",
            raw_line,
            re.IGNORECASE,
        )
        if not qty_match and not code_match:
            continue
        last_price = price_matches[-1]
        total_price = parse_number(last_price[0])
        if not total_price or total_price <= 0:
            continue

        name_candidate = raw_line
        if code_match:
            name_candidate = name_candidate.replace(code_match.group(0), " ")
        if qty_match:
            name_candidate = name_candidate.replace(qty_match.group(0), " ")
        name_candidate = name_candidate.replace(last_price[0], " ")
        name_candidate = re.sub(r"^\d+\s*", "", name_candidate)
        name_candidate = re.sub(r"%\s*\d+(?:[.,]\d+)?", " ", name_candidate)
        name_candidate = re.sub(r"[=*_]+", " ", name_candidate)
        name_candidate = re.sub(r"\s+", " ", name_candidate).strip(" -|")
        if len(re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü]", name_candidate)) < 3:
            continue

        unit = qty_match.group(2) if qty_match else None
        fallback_items.append({
            "line_number": None,
            "code": code_match.group(0) if code_match else None,
            "name": name_candidate,
            "quantity": parse_number(qty_match.group(1)) if qty_match else None,
            "unit": unit,
            "unit_price": None,
            "vat_percent": None,
            "total_price": total_price,
            "currency": parse_currency(last_price[1] if len(last_price) > 1 else "TRY"),
            "raw_line": raw_line,
        })

    # Prefer richer fallback extraction when primary pipe-based parse is weak.
    noise_tokens = [
        "kredi kart",
        "odenecek",
        "ara toplam",
        "mal hizmet toplam",
        "mal/hizmet toplam",
        "topkdv",
        "hesaplanan kdv",
        "toplam tutar",
        "fatura",
        "tarih",
        "saat",
        "vergi",
        "iban",
        "müşteri",
        "musteri",
        "seri",
    ]

    def is_noise_item(entry):
        merged = f"{entry.get('name') or ''} {entry.get('raw_line') or ''}".lower()
        merged = unicodedata.normalize("NFKD", merged)
        merged = "".join(ch for ch in merged if not unicodedata.combining(ch))
        if any(token in merged for token in noise_tokens):
            return True
        if re.search(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b", merged):
            return True
        return False

    def dedupe_and_filter(entries):
        filtered = []
        seen = set()
        for entry in entries:
            if not entry or not entry.get("name") or is_noise_item(entry):
                continue
            total_price = parse_number(entry.get("total_price"))
            if total_price in (None, 0):
                continue
            qty_value = parse_number(entry.get("quantity"))
            normalized_name = re.sub(
                r"[^a-z0-9çğıöşü]+",
                " ",
                str(entry.get("name") or "").lower(),
                flags=re.IGNORECASE,
            ).strip()
            dedupe_key = (
                normalized_name,
                round(float(total_price), 2) if total_price is not None else None,
                round(float(qty_value), 3) if qty_value is not None else None,
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            filtered.append(entry)
        return filtered

    primary_valid = dedupe_and_filter(items)
    fallback_valid = dedupe_and_filter(fallback_items)

    if len(fallback_valid) > len(primary_valid):
        return fallback_valid
    if primary_valid:
        return primary_valid
    return fallback_valid


def format_for_product_addition(items: List[Dict[str, Any]], supplier_id: int) -> Dict[str, Any]:
    """
    Format extracted items for bulk product insertion
    
    Returns structure suitable for POST /suppliers/:id/product-mappings/bulk
    """
    
    formatted_items = []
    
    for item in items:
        if not item.get("name"):
            continue
        
        formatted_item = {
            "supplier_id": supplier_id,
            "supplier_product_code": item.get("code") or None,
            "supplier_product_name_raw": item.get("name"),
            "supplier_product_name_normalized": item.get("name").lower().strip(),
            "quantity": item.get("quantity") or 1,
            "unit": item.get("unit") or "piece",
            "unit_price": item.get("unit_price"),
            "total_price": item.get("total_price"),
            "currency": item.get("currency", "TRY"),
            "vat_rate": item.get("vat_percent"),
            "raw_ocr_text": item.get("raw_line")
        }
        
        formatted_items.append(formatted_item)
    
    return {
        "supplier_id": supplier_id,
        "items": formatted_items,
        "total_items_extracted": len(formatted_items),
        "extraction_status": "success" if formatted_items else "no_items_found"
    }


def main() -> int:
    """Main entry point for command-line usage."""
    if len(sys.argv) < 2:
        safe_json_print({
            "error": "Usage: supplier_invoice_item_extractor.py <image_path> [supplier_id]",
            "success": False,
        })
        return 2

    image_path = sys.argv[1]
    supplier_id = None
    if len(sys.argv) > 2 and str(sys.argv[2]).strip():
        try:
            supplier_id = int(sys.argv[2])
        except Exception:
            safe_json_print({
                "error": f"Invalid supplier_id: {sys.argv[2]}",
                "success": False,
            })
            return 2

    if not os.path.exists(image_path):
        safe_json_print({
            "error": f"Image not found: {image_path}",
            "success": False,
        })
        return 1

    # Extract OCR text
    ocr_result = extract_ocr_text(image_path)
    if ocr_result.get("error"):
        payload = dict(ocr_result)
        payload["success"] = False
        safe_json_print(payload)
        return 1

    # Parse items from OCR text
    items = extract_invoice_items(ocr_result.get("text", ""))

    # Format for product addition
    result = {
        "success": True,
        "ocr": ocr_result,
        "items": items,
        "item_count": len(items),
    }

    if supplier_id:
        result["formatted_for_api"] = format_for_product_addition(items, supplier_id)

    safe_json_print(result)
    return 0


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except BaseException as e:
        # Catch everything to preserve valid JSON output contract.
        import traceback
        safe_json_print({
            "error": str(e),
            "error_type": type(e).__name__,
            "critical": True,
            "details": traceback.format_exc(),
            "success": False,
        })
        exit_code = 1
    sys.exit(int(exit_code))
