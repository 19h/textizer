# Textizer

Rust text-to-image packer with a native CLI and a WebAssembly library. It emits
opaque, monochrome, **1-bit grayscale PNGs** with fixed bitmap glyphs, plus page
and row metadata. All rendering runs in Rust; no browser canvas, network access,
system font installation or Python is needed at runtime.

```text
UTF-8 text -> reversible ASCII escapes -> wrapped rows -> page layout
                                                           |
                                        +------------------+-----------------+
                                        |                                    |
                                 PNG page on demand                   JSON metadata
```

## Build and run

```sh
cargo build --release --locked
cargo run --release -- notes.txt --out packed
printf 'Hello, world!\n' | cargo run --release -- - --out hello

rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked  # if not already installed
sh scripts/build_wasm.sh
```

The WASM build produces `pkg/textizer_bg.wasm`, ES module glue, and TypeScript
declarations, with the font redistribution notices alongside. `Cargo.lock` pins Rust dependencies. The CLI creates
`page0001.png`, subsequent pages, `rows.json`, and `manifest.json`. It refuses to
overwrite existing destinations. Invalid UTF-8 is an error.

For the runnable integration example, serve the repository root:

```sh
python3 -m http.server 8000
# Open http://localhost:8000/examples/
```

Minimal integration follows the upstream
[wasm-bindgen ES module interface](https://rustwasm.github.io/docs/wasm-bindgen/examples/hello-world.html):

```js
import init, { PackedText } from './pkg/textizer.js';
await init();
const doc = new PackedText(text, JSON.stringify({ preset: 'safe' }));
try {
  const manifest = JSON.parse(doc.manifestJson());
  for (const page of manifest.pages) {
    const bytes = doc.pagePng(page.index); // Uint8Array, ordinary image/png
    const blob = new Blob([bytes], { type: 'image/png' });
    // Upload blob, download it, or create an object URL for an <img>.
  }
} finally {
  doc.free();
}
```

`new PackedText(text)` uses defaults. `pageCount` is a number;
`manifestJson()`, `pageText(index)` and `pageRowsJson(index)` return strings.
`pagePng(index)` returns one PNG as a `Uint8Array`. Page indices are zero-based.
Invalid options and out-of-range indices throw. Unknown JSON option keys are
errors. PNGs are produced on demand and are not retained by the document.
For large inputs, instantiate and render inside a Web Worker to move synchronous
layout/compression off the UI thread. The example yields between pages, but its
initial layout remains synchronous.

## Representation decision

The reference investigation is `/Users/int/dev/vision-text-tests`, inspected at
commit `b21916874356d7971e7e6dad08ffb07db7e56de0`. Relevant source SHA-256 values
are recorded in [assets/reference-provenance.json](assets/reference-provenance.json).
This is a source-backed engineering selection, not a newly measured model ranking.

| Layer | Selection | Basis |
|---|---|---|
| Text carrier | Readable literal text | Preserves semantics; converting all prose to hex/base32 was not established as beneficial |
| Raster | Black text on white, exact bitmap glyphs | Matches the reference bitmap rendering without antialiasing or font substitution |
| Image container | Lossless 1-bit grayscale PNG | Preserves the same black/white pixels as RGB PNG with fewer raw pixel bits |
| Default cell | `8x16`, at most 64 columns | Conservative preset inherited from `pack_text.py`; cross-model superiority remains unknown |
| Page grid | Multiples of 224 px | `lcm(28,32) = 224`; aligns both historical patch grids |
| Size limit | At most 1568 px in either dimension | Configurable within this bound; does not assert a universal provider downscale threshold |
| Opaque numeric fields already in source | Preserve their literal representation | Completed powered GPT comparisons favored lowercase hex over Crockford base32; no automatic transcoding |

PNG's grayscale and sample-depth support is defined by the
[W3C PNG specification](https://www.w3.org/TR/png-3/).
This packer does not use PNG metadata as an invisible text carrier. Font bitmaps
are embedded and match the reference project's ASCII pixels; the import script,
pixel tests and font hashes establish that boundary.

The completed powered 64-bit field comparisons in
`analysis_campaign_comparison.md`, section "Encoding, cell size and effort", are:

| Model ID in reference | Hex value-correct | Base32 value-correct |
|---|---:|---:|
| gpt-5.6-sol | 173/186 | 104/186 |
| gpt-6-sol | 171/186 | 85/186 |
| gpt-6.1-sol | 181/186 | 111/186 |
| gpt-6-astra | 182/186 | 113/186 |

These are short-field results, not exact recovery rates for arbitrary documents.
The corresponding Claude powered comparisons are unavailable because of terminal
quota failures. The audit counted 2616 such failures across the two Claude
campaigns. The earlier legibility presets are not six-model confirmations.
No model API was called for this implementation.

## Presets and options

| Preset | Embedded font | Cell area (px^2) | Intended use |
|---|---|---:|---|
| `safe` (default) | `8x16` | 128 | Conservative mixed text/code |
| `data` | `6x13` | 78 | Denser mixed text and short opaque fields |
| `prose` | `clR5x10` | 50 | Dense redundant prose; not an exact-data fidelity claim |
| `large` | `9x18` | 162 | Larger glyphs for comparison or inspection |

CLI flags correspond directly to these JSON fields:

```json
{
  "preset": "safe",
  "max_width": 1568,
  "max_height": 1568,
  "max_columns": 64,
  "grid": 224,
  "reflow": false
}
```

`grid` accepts 224, 28 or 32. Dimensions must be at least one grid unit and at
most 1568; the search uses whole grid units at or below each bound. `max_columns`
accepts 12 through 256. The actual column count may be smaller. Default wrapping
preserves all whitespace and wraps preferentially after a space, retaining the
space. Long tokens wrap at character boundaries. Escape sequences never split.
`--reflow` explicitly collapses Unicode whitespace to single spaces and removes
leading/trailing whitespace; that mode changes the input representation.

Printable ASCII (U+0020 through U+007E) renders directly, except that a literal
backslash becomes `\\`. Tab becomes `\t`, CR becomes `\r`, and unsupported
characters become lowercase `\u{hex}` escapes, e.g. Greek alpha becomes `\u{3b1}`.
LF is a hard row break. CJK, combining marks, emoji and RTL text therefore appear
as reversible escapes, not as shaped native glyphs. CRLF remains CR escape + LF;
no normalization occurs unless reflow is explicitly enabled.

`pageText()` is a visual transcript with wrap newlines. For exact reconstruction
without reflow, concatenate every row's `text` in page order, appending LF only
when `hard_break` is true; then decode the documented escapes. Empty input yields
one blank page. `source_sha256` hashes the original UTF-8 bytes, before reflow.
Row metadata contains the source text in escaped form; applications control
whether to retain or export it alongside images.

## Packing algorithm and resource bounds

For each permissible grid width `w`, use
`columns = min(floor(w/cell_width), max_columns)`, wrap text once, and enumerate
permissible grid heights `h`. With `r = floor(h/cell_height)` and `L` wrapped rows:

```text
pages       = ceil(L/r)
last_rows   = L - (pages-1)*r
last_height = ceil(last_rows*cell_height/grid)*grid
total_area  = w*((pages-1)*h + last_height)              [px^2]
```

Find the minimum area. Among candidates within 15% of it, select the fewest
pages, then minimum area, then smaller width/height. Discard duplicate column
counts at wider widths. Short final pages are cropped to a grid unit; glyphs
are never scaled. This optimizes over the enumerated grid layouts, not every
possible layout or the compressed PNG byte count. All calculations are integer;
there is no numerical rounding uncertainty.

For `N` escaped bytes, `W` candidate widths, `H` candidate heights and `A` pixels
in a rendered page: layout time is `O(W*N + W*H)` and auxiliary space is
`O(N + W*H)`; rendering time is `O(A)` with `O(A)` space. The column limit is a
fixed bound, so bounded row scans do not change this asymptotic expression.
Raster storage before PNG compression is exactly
`ceil(width/8)*height` bytes. A 1568 by 1568 page takes 307328 raw raster bytes,
versus 7375872 bytes for RGB8, a factor of 24. Compressed-file savings depend
on content and are not assumed to be 24-fold.

The library caps original UTF-8 at 4 MiB, escaped text at 16 MiB, and output at
4096 pages. These are workload limits, not a hard cap on total allocator usage.
The CLI bounds its initial read. JavaScript still owns its input string before
the WASM size check runs.

Manifest `patches_28` and `patches_32` are geometric counts:
`ceil(width/p)*ceil(height/p)`. They are not billed token predictions. Reference
GPT-5.6 measurements used 1.2 tokens per 32 px patch; fixed overhead, resizing,
model changes and provider accounting are outside this utility. In particular,
the reference audit found an unintended 28 px fallback in GPT-6 Arm B, and
GPT-6 square ceilings were not measured.

## Assumption register and bounded implications

| ID | Assumption / boundary | Stress test or falsification probe | Dependent result |
|---|---|---|---|
| A1 | Clients accept standards-conforming grayscale PNG; model-specific ingestion is unknown | Decode in target browser/provider; compare decoded RGB to reference | Container compatibility, not model accuracy |
| A2 | Embedded ASCII glyphs match reference rasters | `verify_pixels.py` checks all printable ASCII plus wrapped multi-page content for all four fonts | Renderer compatibility |
| A3 | 8x16 is a conservative default; the most accurate cross-model default is unknown | Frozen, paired representative documents with exact target model IDs | Default font selection |
| A4 | 224 px alignment is useful for historical 28/32 grids; current provider resizing is unknown | Inspect delivered pixels and measured usage for target model | Grid choice, not billing claims |
| A5 | Escapes are acceptable for unsupported scripts | Round-trip Unicode/control fixtures; inspect non-Latin use cases | Arbitrary UTF-8 transport, not native-script readability |
| A6 | Preserving whitespace is required unless reflow is requested | Compare reconstructed escaped stream and original SHA-256 | Fidelity and pagination |

| Impact | Additional pattern | Boundary / probe |
|---|---|---|
| High | OCR can substitute symbols or bind a correct value to the wrong record | No exact transcription guarantee; retain canonical source and validate extracted identifiers independently |
| Medium | Leading-zero runs caused many rejected reference codewords | Textizer preserves them; it does not silently canonicalize data or claim a tested repair |
| Medium | Tight packing may reduce model readability despite pixel equivalence | Compare `safe`, `data`, `prose`, and `large` on held-out target content |
| Low | One-bit PNG saves transfer/storage bytes, not geometric image tokens | Compare PNG lengths separately from patch counts |

## Validation

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo build --locked
/Users/int/dev/vision-text-tests/.venv-run/bin/python \
  scripts/verify_pixels.py /Users/int/dev/vision-text-tests
sh scripts/build_wasm.sh
node scripts/verify_wasm.mjs
BROWSER=/path/to/chrome node scripts/verify_browser.mjs
```

The independent Pillow oracle checks decoded RGB, not PNG file hashes. The Node
test instantiates the same web-target WASM module and tests multi-page output,
metadata, escaping, deterministic PNGs, typed arrays and error propagation.
The browser test uses an isolated headless Chromium profile and a temporary local
HTTP server; Node >= 22 is required. It verifies native browser PNG decoding and
the example UI's generation of downloadable images. Live model inference remains
outside this validation.

Verified locally: 7 Rust tests, Clippy with warnings denied, exact decoded RGB
matches on 27 pages across four fonts, the Node WASM API on 15 pages, Chromium
PNG decoding on six pages, and the example browser UI. The release WASM artifact
is approximately 303 KiB; build versions and optimizations affect that size.

Quality gates: implementation decisions are factual/technical (QG1); assumptions
and probes are above (QG2); native and WASM usage are covered (QG3); pixel formulas
and bounds are explicit (QG4); edge cases have regression tests (QG5); reference
hashes, font origins and standards are recorded (QG6); additional implications are
bounded above (QG7). No inference accuracy is claimed from renderer tests.

Font origins and redistributed notices are listed in
[assets/NOTICE.md](assets/NOTICE.md). The Python import/verification scripts are
development tools only.
