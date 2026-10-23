#!/usr/bin/env python3
"""Compare decoded Rust PNGs against the reference Pillow glyph renderer.

Run after cargo build: reference-venv/python scripts/verify_pixels.py REFERENCE
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFont

repo = Path(__file__).resolve().parents[1]
reference = Path(sys.argv[1])
text = ''.join(chr(c) for c in range(32, 127)) + '\n' + (
    'alpha  beta\tbackslash \\ unicode: \u03b1\U0001f9ec\r\n' * 40
)
for preset in ('safe', 'data', 'prose', 'large'):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        subprocess.run([str(repo / 'target/debug/textizer'), '-', '--out', str(out),
                        '--preset', preset, '--max-width', '224', '--max-height', '224'],
                       input=text, text=True, check=True, capture_output=True)
        manifest = json.loads((out / 'manifest.json').read_text())
        rows = json.loads((out / 'rows.json').read_text())
        font = ImageFont.load(str(reference / '_pilfonts' / (manifest['font'] + '.pil')))
        for page, page_rows in zip(manifest['pages'], rows):
            actual = Image.open(out / page['filename']).convert('RGB')
            expected = Image.new('RGB', actual.size, 'white')
            draw = ImageDraw.Draw(expected)
            draw.fontmode = '1'
            for y, row in enumerate(page_rows):
                draw.text((0, y * manifest['cell_height']), row['text'], font=font, fill='black')
            assert ImageChops.difference(actual, expected).getbbox() is None, (preset, page['index'])
        print(f"{preset}: {len(rows)} pages match reference decoded RGB exactly")

# Verify asset integrity separately from encoded PNG byte identity.
for font in json.loads((repo / 'assets/fonts.json').read_text()):
    assert hashlib.sha256((repo / 'assets' / (font['font'] + '.bin')).read_bytes()).hexdigest() == font['sha256']
