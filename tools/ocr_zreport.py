#!/usr/bin/env python3
import json
import sys
import os
import re

def load_image(path):
    try:
        from PIL import Image, ImageOps
    except Exception as e:
        raise RuntimeError("PIL not available") from e

    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        img = None
        # Try PyMuPDF
        try:
            import fitz  # type: ignore
            doc = fitz.open(path)
            page = doc.load_page(0)
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        except Exception:
            img = None
        if img is None:
            # Try pdf2image
            try:
                from pdf2image import convert_from_path  # type: ignore
                images = convert_from_path(path, dpi=200, first_page=1, last_page=1)
                img = images[0]
            except Exception as e:
                raise RuntimeError("PDF conversion failed") from e
    else:
        img = Image.open(path)

    img = ImageOps.exif_transpose(img)
    # Downscale for speed (keep enough width for thin receipt digits)
    try:
        w, h = img.size
        max_w = 1400
        if w > max_w:
            ratio = max_w / float(w)
            img = img.resize((int(w * ratio), int(h * ratio)))
    except Exception:
        pass

    w, h = img.size

    def build_variants(region):
        gray = ImageOps.grayscale(region)
        gray = ImageOps.autocontrast(gray)
        return [
            gray,
            gray.point(lambda x: 0 if x < 170 else 255, "1"),
        ]

    regions = []
    regions.append(img)
    # Focus on bottom half where totals usually are
    regions.append(img.crop((0, int(h * 0.45), w, h)))
    regions.append(img.crop((0, int(h * 0.25), w, int(h * 0.75))))
    # Mid band often contains "Satis ... adet ... total"
    regions.append(img.crop((0, int(h * 0.30), w, int(h * 0.65))))

    variants = []
    for region in regions:
        variants.extend(build_variants(region))

    return variants

def ocr_image(images):
    # Ensure deterministic tesseract resolution and availability
    try:
        from utils.ocrBootstrap import ensure_tesseract
    except Exception:
        # If bootstrap import fails, propagate an explicit error
        raise RuntimeError("pytesseract bootstrap not available")

    # This will raise RuntimeError("Tesseract binary not found") or
    # RuntimeError("pytesseract not available") on failure.
    tesseract_path = ensure_tesseract()

    # Import pytesseract now that bootstrap configured it
    import pytesseract

    def score_text(text):
        if not text:
            return 0
        upper = text.upper()
        score = sum(ch.isdigit() for ch in upper)
        for kw in ["KART", "CARD", "TOPLAM", "TOTAL", "RAPOR", "Z", "ISLEM", "ISLEM"]:
            if kw in upper:
                score += 20
        return score

    def has_total_amount(text):
        upper = (text or "").upper()
        if not upper:
            return False
        if not re.search(r"(KART|CARD|TOPLAM|TOTAL)", upper):
            return False
        return re.search(r"\d[\d\s.,]{2,}", upper) is not None

    # Fast pass: Turkish + English only
    best_text = ""
    best_score = 0
    for img in images:
        try:
            text = pytesseract.image_to_string(img, lang="tur+eng", config="--oem 1 --psm 6")
            s = score_text(text)
            if s > best_score:
                best_score = s
                best_text = text
            if s >= 40 and has_total_amount(text):
                return text
        except Exception:
            continue

    # Full pass if fast pass is weak
    for img in images:
        for lang in ["tur+eng+deu+fra", "eng"]:
            for psm in [6, 4]:
                try:
                    text = pytesseract.image_to_string(
                        img, lang=lang, config=f"--oem 1 --psm {psm}"
                    )
                    s = score_text(text)
                    if s > best_score:
                        best_score = s
                        best_text = text
                    if s >= 40 and has_total_amount(text):
                        return text
                except Exception:
                    continue
    return best_text

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing file"}))
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(json.dumps({"error": "file not found"}))
        sys.exit(1)
    try:
        images = load_image(path)
        text = ocr_image(images)
        print(json.dumps({"text": text}))
    except Exception as e:
        # Structured error output for missing tesseract/pytesseract
        msg = str(e or "")
        if msg.startswith("Tesseract binary not found"):
            print(json.dumps({"error": "Tesseract binary not found", "error_type": "RuntimeError", "engine": "tesseract"}))
            sys.exit(1)
        if msg.startswith("pytesseract not available") or msg.startswith("pytesseract bootstrap not available"):
            print(json.dumps({"error": "pytesseract not available", "error_type": "ImportError", "engine": "tesseract"}))
            sys.exit(1)

        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
