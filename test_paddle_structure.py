#!/usr/bin/env python3
from paddleocr import PaddleOCR
import os
import json

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

print("=" * 80)
print("Testing PaddleOCR Output Structure")
print("=" * 80)

ocr = PaddleOCR(use_textline_orientation=False, lang='tr')
img_path = "/Users/nurikord/PycharmProjects/hurrypos-backend/uploads/receipts/receipt-1771011323518-356128886.ocr.png"

print(f"\nRunning OCR on: {img_path}")
result = ocr.ocr(img_path)

print(f"\nResult type: {type(result)}")
print(f"Result is None? {result is None}")
if result:
    print(f"Result length: {len(result)}")
    print(f"Result[0] type: {type(result[0])}")
    print(f"Result[0] length: {len(result[0]) if result[0] else 0}")
    
    if result[0]:
        print("\n\nFirst 3 items:")
        for i in range(min(3, len(result[0]))):
            item = result[0][i]
            print(f"\n  Item {i}:")
            print(f"    Type: {type(item)}")
            print(f"    Length: {len(item) if isinstance(item, (list, tuple)) else 'N/A'}")
            print(f"    Value: {item}")
            
            if isinstance(item, (list, tuple)) and len(item) >= 3:
                print(f"    Breakdown:")
                for j, sub_item in enumerate(item):
                    print(f"      [{j}] type={type(sub_item).__name__}, value={repr(sub_item)}")
