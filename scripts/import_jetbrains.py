#!/usr/bin/env python3
"""Bake the installed JetBrains Mono NL Regular into a deterministic printable-glyph atlas.

Usage: python scripts/import_jetbrains.py /path/to/JetBrainsMonoNL-Regular.ttf
Runtime rendering uses only the generated pixels, not Pillow or a system font.
"""
import hashlib
import json
from pathlib import Path
import sys
import struct
import unicodedata
import math
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, __version__

source = Path(sys.argv[1])
assets = Path(__file__).resolve().parents[1] / 'assets'
font = ImageFont.truetype(str(source), 13)
width, height = 8, 18
data = bytearray()
codepoints = sorted(code for code in TTFont(source).getBestCmap()
                    if chr(code).isprintable() and not unicodedata.category(chr(code)).startswith('M'))
for code in codepoints:
    image = Image.new('L', (width, height), 255)
    ImageDraw.Draw(image).text((0, 0), chr(code), font=font, fill=0)
    data.extend(int(pixel < 128) for pixel in image.getdata())
(assets / 'jetbrains-mono-13.bin').write_bytes(data)
(assets / 'jetbrains-mono-codepoints.bin').write_bytes(b''.join(struct.pack('<I', c) for c in codepoints))
(assets / 'jetbrains-mono.json').write_text(json.dumps({
    'font': 'JetBrains Mono NL Regular', 'width': width, 'height': height,
    'size_px': 13, 'threshold': 128, 'pillow_version': __version__,
    'format': 'Sorted codepoints in jetbrains-mono-codepoints.bin (u32 LE); glyph-major, row-major; 1=ink, 0=background',
    'glyph_count': len(codepoints),
    'source_filename': source.name,
    'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'sha256': hashlib.sha256(data).hexdigest(),
}, indent=2) + '\n')

# Render each target size directly through Pillow/FreeType. Store coverage, not
# thresholded pixels, so the runtime can select grayscale or crisp rendering.
sizes = []
for size in range(8, 17):
    scaled = ImageFont.truetype(str(source), size)
    width = math.ceil(size * 0.6)  # JetBrains Mono's 600-unit monospace advance
    height = sum(scaled.getmetrics())
    coverage = bytearray()
    for code in codepoints:
        image = Image.new('L', (width, height), 255)
        ImageDraw.Draw(image).text((0, 0), chr(code), font=scaled, fill=0)
        coverage.extend(255 - p for p in image.getdata())
    path = assets / f'jetbrains-mono-{size}.gray.bin'
    path.write_bytes(coverage)
    sizes.append(dict(size_px=size, width=width, height=height,
                      sha256=hashlib.sha256(coverage).hexdigest()))
(assets / 'jetbrains-sizes.json').write_text(json.dumps({
    'rasterizer': 'Pillow FreeType at native pixel size; grayscale coverage, no image scaling',
    'pillow_version': __version__, 'sizes': sizes,
}, indent=2) + '\n')
