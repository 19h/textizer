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
text = '—“Title”… é Ω Ж ≤ ≥\n' + ''.join(chr(c) for c in range(32, 127)) + '\n' + (
    'alpha  beta\tbackslash \\ unicode: \u03b1\U0001f9ec\r\n' * 40
)
def verify(preset, side, mode, size=13, antialias=True):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        args = [str(repo / 'target/debug/textizer'), '-', '--out', str(out),
                        '--preset', preset, '--theme', 'light', '--no-crop', '--max-width', str(side), '--max-height', str(side),
                        '--font-size', str(size), '--page-mode', mode, '--max-columns', '0' if mode == 'full' else '64']
        if not antialias: args.append('--no-antialias')
        subprocess.run(args,
                       input=text, text=True, check=True, capture_output=True)
        manifest = json.loads((out / 'manifest.json').read_text())
        rows = json.loads((out / 'rows.json').read_text())
        font = (ImageFont.truetype('/Users/int/Library/Fonts/JetBrainsMonoNL-Regular.ttf', size)
                if preset == 'jetbrains_mono' else ImageFont.load(str(reference / '_pilfonts' / (manifest['font'] + '.pil'))))
        for page, page_rows in zip(manifest['pages'], rows):
            actual = Image.open(out / page['filename']).convert('RGB')
            if mode == 'full':
                assert actual.size == (side, side)
            expected = Image.new('L' if preset == 'jetbrains_mono' else 'RGB', actual.size, 'white')
            draw = ImageDraw.Draw(expected)
            draw.fontmode = 'L' if preset == 'jetbrains_mono' else '1'
            for y, row in enumerate(page_rows):
                for x, ch in enumerate(row['text']):
                    if preset == 'jetbrains_mono':
                        cell = Image.new('L', (manifest['cell_width'], manifest['cell_height']), 255)
                        ImageDraw.Draw(cell).text((0, 0), ch, font=font, fill=0)
                        expected.paste(cell, (x * manifest['cell_width'], y * manifest['cell_height']))
                    else:
                        draw.text((x * manifest['cell_width'], y * manifest['cell_height']), ch, font=font, fill='black')
            if preset == 'jetbrains_mono':
                if not antialias: expected = expected.point(lambda p: 255 if p >= 128 else 0)
                expected = expected.convert('RGB')
            assert ImageChops.difference(actual, expected).getbbox() is None, (preset, page['index'])
        print(f"{preset}/{size}px/{mode}/{side}/aa={antialias}: {len(rows)} pages match reference decoded RGB exactly")

for preset in ('safe', 'data', 'prose', 'large', 'jetbrains_mono'):
    verify(preset, 224, 'compact')
    verify(preset, 1600, 'full')
    verify(preset, 1932, 'full')
for size in range(8, 17):
    verify('jetbrains_mono', 224, 'compact', size)
    verify('jetbrains_mono', 224, 'compact', size, False)

# Verify asset integrity separately from encoded PNG byte identity.
for font in json.loads((repo / 'assets/fonts.json').read_text()):
    assert hashlib.sha256((repo / 'assets' / (font['font'] + '.bin')).read_bytes()).hexdigest() == font['sha256']
