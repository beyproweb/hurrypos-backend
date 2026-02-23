#!/usr/bin/env python3
import sys
import json
import os
import tempfile
import shutil
import subprocess

try:
    from paddleocr import PaddleOCR
except ImportError as e:
    print(json.dumps({"error": f"PaddleOCR not installed: {e}"}))
    sys.exit(1)

try:
    import cv2
    import numpy as np
except ImportError:
    # cv2 and numpy are optional for preprocessing; we'll skip if not available
    cv2 = None
    np = None


def build_ocr():
    # PaddleOCR's constructor args vary by version; keep this minimal and
    # retry without optional args if the installed version rejects them.
    # Prefer local cached models to avoid network downloads.
    # For Turkish documents, use 'tr' or 'en+tr' as the language
    lang = os.environ.get("PADDLE_OCR_LANG", "en")
    
    # For Turkish invoices, we should try Turkish models first
    if lang.lower() in ["tr", "turkish"]:
        lang = "tr"
    elif "tr" not in lang.lower():
        # Add Turkish support to multi-language
        lang = f"{lang}+tr" if lang != "en" else "tr"
    
    model_base = os.environ.get(
        "PADDLE_OCR_MODEL_DIR",
        os.path.expanduser("~/.paddlex/official_models"),
    )

    def model_dir(name):
        path = os.path.join(model_base, name)
        return path if os.path.isdir(path) else None

    params = {
        "lang": lang,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "text_detection_model_name": "PP-OCRv5_server_det",
        "text_detection_model_dir": model_dir("PP-OCRv5_server_det"),
        "text_recognition_model_name": "en_PP-OCRv5_mobile_rec",
        "text_recognition_model_dir": model_dir("en_PP-OCRv5_mobile_rec"),
        "doc_orientation_classify_model_name": "PP-LCNet_x1_0_doc_ori",
        "doc_orientation_classify_model_dir": model_dir("PP-LCNet_x1_0_doc_ori"),
        "textline_orientation_model_name": "PP-LCNet_x1_0_textline_ori",
        "textline_orientation_model_dir": model_dir("PP-LCNet_x1_0_textline_ori"),
    }
    # Drop None values to avoid triggering download logic.
    params = {k: v for k, v in params.items() if v is not None}

    try:
        return PaddleOCR(**params)
    except Exception:
        try:
            params.pop("use_doc_orientation_classify", None)
            params.pop("use_doc_unwarping", None)
            params.pop("use_textline_orientation", None)
            return PaddleOCR(**params)
        except Exception:
            return PaddleOCR(lang=lang)


def flatten_numbers(value):
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(flatten_numbers(item))
        return out
    if isinstance(value, (int, float)):
        return [float(value)]
    return []


def normalize_bbox(box):
    nums = flatten_numbers(box)
    if len(nums) < 4:
        return None
    xs = nums[0::2]
    ys = nums[1::2]
    if not xs or not ys:
        return None
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return {
        "x0": x0,
        "x1": x1,
        "y0": y0,
        "y1": y1,
        "cx": (x0 + x1) / 2.0,
        "cy": (y0 + y1) / 2.0,
    }


def append_word(words, text, bbox):
    txt = str(text or "").strip()
    if not txt:
        return
    normalized = normalize_bbox(bbox)
    if normalized is None:
        return
    words.append({"text": txt, **normalized})


def extract_words_and_text(result):
    words = []
    lines = []

    if isinstance(result, dict):
        texts = result.get("rec_texts") or result.get("text") or []
        polys = (
            result.get("rec_polys")
            or result.get("dt_polys")
            or result.get("polys")
            or []
        )
        for idx, txt in enumerate(texts):
            t = str(txt or "").strip()
            if not t:
                continue
            lines.append(t)
            box = polys[idx] if idx < len(polys) else None
            append_word(words, t, box)
    else:
        for page in result or []:
            if isinstance(page, dict):
                page_texts = page.get("rec_texts") or page.get("text") or []
                page_polys = (
                    page.get("rec_polys")
                    or page.get("dt_polys")
                    or page.get("polys")
                    or []
                )
                for idx, txt in enumerate(page_texts):
                    t = str(txt or "").strip()
                    if not t:
                        continue
                    lines.append(t)
                    box = page_polys[idx] if idx < len(page_polys) else None
                    append_word(words, t, box)
                continue

            for line in page or []:
                txt = ""
                box = None
                if isinstance(line, dict):
                    txt = line.get("text") or line.get("rec_text") or ""
                    box = (
                        line.get("rec_box")
                        or line.get("dt_box")
                        or line.get("poly")
                        or line.get("points")
                    )
                else:
                    box = line[0] if line and len(line) > 0 else None
                    txt = line[1][0] if line and len(line) > 1 else ""
                t = str(txt or "").strip()
                if not t:
                    continue
                lines.append(t)
                append_word(words, t, box)

    words.sort(key=lambda w: (w["cy"], w["x0"]))
    return words, "\n".join(lines)


def preprocess_image_for_ocr(input_path):
    """
    Enhance image quality for better OCR recognition.
    Handles rotation, contrast enhancement, noise reduction, etc.
    """
    try:
        import cv2
        import numpy as np
        
        img = cv2.imread(input_path)
        if img is None:
            return input_path
        
        # Convert to grayscale if needed
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        else:
            gray = img
        
        # 1. Auto-rotate if document appears upside down or sideways
        # Using simple edge detection to guess orientation
        try:
            # Detect document edges
            edges = cv2.Canny(gray, 100, 200)
            lines = cv2.HoughLines(edges, 1, np.pi / 180, 100)
            
            if lines is not None and len(lines) > 0:
                angles = []
                for line in lines:
                    rho, theta = line[0]
                    angle = np.degrees(theta) - 90
                    if abs(angle) < 45:  # Only consider near-horizontal lines
                        angles.append(angle)
                
                if angles:
                    median_angle = np.median(angles)
                    if abs(median_angle) > 5:  # Only rotate if angle is significant
                        h, w = gray.shape
                        center = (w // 2, h // 2)
                        rotation_matrix = cv2.getRotationMatrix2D(center, median_angle, 1.0)
                        gray = cv2.warpAffine(gray, rotation_matrix, (w, h), borderMode=cv2.BORDER_REFLECT)
        except Exception as e:
            pass  # Skip rotation on error
        
        # 2. Enhance contrast using CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        # 3. Denoise
        denoised = cv2.fastNlMeansDenoising(enhanced, None, h=10, templateWindowSize=7, searchWindowSize=21)
        
        # 4. Binary thresholding for better text definition
        _, binary = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # 5. Dilate slightly to connect broken characters
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        processed = cv2.dilate(binary, kernel, iterations=1)
        
        # Save to temporary file
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        cv2.imwrite(tmp.name, processed)
        return tmp.name
        
    except Exception as e:
        # If cv2 not available or processing fails, return original
        return input_path


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No image path provided"}))
        return
    image_path = sys.argv[1]
    try:
        # HEIC/HEIF conversion if needed (fallback when OpenCV/Paddle can't read)
        try:
            with open(image_path, "rb") as f:
                header = f.read(32)
            is_heif = b"ftyp" in header and any(
                tag in header for tag in [b"heic", b"heif", b"hevc", b"mif1"]
            )
        except Exception:
            is_heif = False

        if is_heif or image_path.lower().endswith((".heic", ".heif")):
            try:
                from PIL import Image
                import pillow_heif  # type: ignore

                pillow_heif.register_heif_opener()
                img = Image.open(image_path)
                tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                img.save(tmp.name, format="PNG")
                image_path = tmp.name
            except Exception as e:
                # Fallback to macOS sips if available
                sips = shutil.which("sips")
                if sips:
                    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                    try:
                        subprocess.run(
                            [sips, "-s", "format", "png", image_path, "--out", tmp.name],
                            check=True,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        image_path = tmp.name
                    except Exception:
                        print(
                            json.dumps(
                                {
                                    "error": "OCR failed: HEIC conversion failed. Install pillow-heif."
                                }
                            )
                        )
                        return
                else:
                    print(
                        json.dumps(
                            {
                                "error": "OCR failed: HEIC not supported. Install pillow-heif."
                            }
                        )
                    )
                    return

        # Preprocess image for better OCR
        processed_image = preprocess_image_for_ocr(image_path)
        
        ocr = build_ocr()
        try:
            if hasattr(ocr, "predict"):
                result = ocr.predict(processed_image, text_det_limit_side_len=1024)
            else:
                result = ocr.ocr(processed_image, cls=False)
        except Exception as e:
            msg = str(e)
            if "predict() got an unexpected keyword argument" in msg or "unexpected keyword argument" in msg:
                result = ocr.predict(processed_image)
            else:
                try:
                    result = ocr.ocr(processed_image, cls=False)
                except Exception:
                    result = ocr.ocr(processed_image)
        words, text = extract_words_and_text(result)
        if not text.strip():
            print(json.dumps({"error": "OCR failed: NO_TEXT"}))
            return
        print(json.dumps({"text": text, "words": words}))
    except Exception as e:
        print(json.dumps({"error": f"OCR failed: {e.__class__.__name__}: {e}"}))
        return


if __name__ == "__main__":
    main()
