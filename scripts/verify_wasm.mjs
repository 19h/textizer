// Run after wasm-pack build --target web --out-dir pkg
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, { PackedText } from '../pkg/textizer.js';

await init({ module_or_path: readFileSync(new URL('../pkg/textizer_bg.wasm', import.meta.url)) });
const source = 'alpha beta\t\\unicode: \u03b1\n'.repeat(100);
const packed = new PackedText(source, JSON.stringify({ max_width: 224, max_height: 224 }));
try {
  assert.ok(packed.pageCount > 1);
  const manifest = JSON.parse(packed.manifestJson());
  assert.equal(manifest.pages.length, packed.pageCount);
  let transcript = '';
  for (let i = 0; i < packed.pageCount; i++) {
    const bytes = packed.pagePng(i);
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(bytes, packed.pagePng(i));
    assert.equal(bytes[24], 8); // IHDR bit depth
    assert.equal(bytes[25], 0); // IHDR grayscale
    for (const row of JSON.parse(packed.pageRowsJson(i))) {
      transcript += row.text + (row.hard_break ? '\n' : '');
    }
  }
  assert.equal(transcript, 'alpha beta\\t\\\\unicode: α\n'.repeat(100));
  const unicode = new PackedText('—“Title”… é Ω Ж ≤ ≥'.repeat(50), JSON.stringify({ max_columns: 12 }));
  try {
    let text = '';
    for (let i = 0; i < unicode.pageCount; i++) {
      for (const row of JSON.parse(unicode.pageRowsJson(i))) text += row.text + (row.hard_break ? '\n' : '');
      unicode.pagePng(i);
    }
    assert.equal(text, '—“Title”… é Ω Ж ≤ ≥'.repeat(50));
  } finally { unicode.free(); }
  assert.throws(() => packed.pagePng(packed.pageCount));
  assert.throws(() => new PackedText('x', '{"grid":0}'));
  assert.throws(() => new PackedText('x', '{"unknown":true}'));
  const empty = new PackedText('');
  assert.equal(empty.pageCount, 1);
  empty.free();
  for (const [side, grid, preset, columns] of [[1600, 32, 'safe', 200], [1932, 28, 'prose', 386]]) {
    const full = new PackedText('x'.repeat(80000), JSON.stringify({
      max_width: side, max_height: side, max_columns: 0, grid, preset, page_mode: 'full', crop: false,
    }));
    try {
      const info = JSON.parse(full.manifestJson());
      assert.equal(info.columns, columns);
      assert.ok(full.pageCount > 1);
      for (let i = 0; i < full.pageCount; i++) {
        const bytes = full.pagePng(i);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        assert.equal(view.getUint32(16), side);
        assert.equal(view.getUint32(20), side);
      }
    } finally { full.free(); }
  }
  console.log('WASM full-page profiles: 1600 and 1932 px dimensions verified');
  console.log(`WASM JavaScript API: ${packed.pageCount} pages, byte arrays, escaping and errors verified`);
} finally { packed.free(); }
