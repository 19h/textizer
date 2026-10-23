#!/usr/bin/env python3
"""Import ASCII glyph pixels from the reference project's Pillow bitmap fonts.

Development-only: runtime has no Python, Pillow, OS fonts or canvas dependency.
Usage: python scripts/import_fonts.py /path/to/vision-text-tests
"""
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
dest = Path(__file__).resolve().parents[1] / "assets"
records = []
for name, width, height in [("8x16", 8, 16), ("6x13", 6, 13),
                            ("clR5x10", 5, 10), ("9x18", 9, 18)]:
    base = root / "_pilfonts" / name
    font = ImageFont.load(str(base.with_suffix(".pil")))
    data = bytearray()
    for code in range(32, 127):
        im = Image.new("1", (width, height), 1)
        draw = ImageDraw.Draw(im)
        draw.fontmode = "1"
        draw.text((0, 0), chr(code), font=font, fill=0)
        data.extend(0 if pixel else 1 for pixel in im.getdata())
    target = dest / f"{name}.bin"
    target.write_bytes(data)
    records.append(dict(font=name, width=width, height=height,
                        format="ASCII 32..126; glyph-major, row-major; 1=black, 0=white",
                        sha256=hashlib.sha256(data).hexdigest(),
                        source_pil_sha256=hashlib.sha256(base.with_suffix(".pil").read_bytes()).hexdigest(),
                        source_pbm_sha256=hashlib.sha256(base.with_suffix(".pbm").read_bytes()).hexdigest()))
(dest / "fonts.json").write_text(json.dumps(records, indent=2) + "\n")
