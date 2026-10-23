# Textizer

Rust text-to-image packer with a native CLI and a WebAssembly library. It emits
opaque, **grayscale PNGs** with fixed bitmap glyphs, plus page
and row metadata. All rendering runs in Rust; no browser canvas, network access,
system font installation or Python is needed at runtime.

```text
UTF-8 text -> font glyphs / fallback escapes -> wrapped rows -> page layout
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

## Web UI

`web/` is a full client built from plain HTML, CSS and ES modules on the same
WASM package, styled with the vendored Phosphor design system
([web/phosphor/README.md](web/phosphor/README.md)). Build the package, serve the
repository root as above and open `http://localhost:8000/web/`.

- Type or paste into the editor; packed pages render below as you type. Layout
  and PNG encoding run in a module worker, and pages are encoded only when
  scrolled near, so large inputs do not block the UI.
- Press Cmd+V (Ctrl+V on Windows and Linux, or Shift+Insert) anywhere outside
  the editor to store the clipboard as a new text. Dropping UTF-8 files or using
  `open file` does the same; invalid UTF-8 is rejected, and a BOM is kept as the
  CLI keeps it.
- The sidebar lists earlier texts with their options, stored in this browser's
  IndexedDB. Nothing is uploaded. Pasting a stored text again reopens it instead
  of storing a copy.
- Each page can be copied to the clipboard as PNG or downloaded. `download .zip`
  writes the same files the CLI does (`page0001.png`..., `rows.json`,
  `manifest.json`).
- The default **shared** size produces full 1600 x 1600 px pages with automatic
  columns. **Claude** selects 1932 x 1932 px. Choose **compact** to minimize blank
  area, or set a column limit for short data lines. Historical entries keep their
  saved dimensions and compact mode; the defaults button selects the new defaults.
- Keys: `i` edit, `esc` leave the editor, `n` new, `/` filter, `j`/`k` move
  through history, `y` copy the page in view, `z` fit or 1:1, `?` list.

Browser textareas normalize CR and CRLF to LF, so a pasted text with carriage
returns keeps them only until it is edited in place; the editor flags such text.

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
| Default cell | JetBrains Mono `8x18` | User-selected default; cross-model readability remains unknown |
| Page dimensions | 1600 x 1600 shared; 1932 x 1932 Claude | Largest measured GPT-5.6 and Claude squares; GPT-6 square ceilings remain unknown |
| Page grid | 32 px shared; 28 px Claude; optional 224 px in compact mode | A 224 px grid tops out at 1568 below the 1600 px ceiling; full mode uses exact dimensions |
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

The resolution profiles come from `vision-text-tests/README.md`, sections 1 and
15, and `results_geometry_bisect_gpt-5.6-sol.json`. The paired Claude measurements
show the 1932-to-1933 px boundary reaching the 4761-patch cap. GPT-5.6's 1600 px
square is 2500 patches; 1632 px and larger squares are capped. The
`analysis_campaign_comparison.md` geometry section only establishes GPT-6 moderate
rectangle behavior; it does not establish GPT-6 square ceilings. Thus **shared**
is an engineering default within the two measured historical envelopes, not a
claim of measured support across most current models.

| Profile | Canvas (px) | Grid in compact mode (px) | Evidence boundary |
|---|---|---|---|
| shared | 1600 x 1600 | 32 | GPT-5.6 measured ceiling; below the Claude square ceiling |
| Claude | 1932 x 1932 | 28 | Measured historical Claude ceiling; exceeds GPT-5.6's ceiling |
| custom | Up to 1932 per side | Selected grid | No extra model-compatibility claim |

The web default fills 200 columns by 100 rows with 8x16 cells: `200 * 100 =
20000` characters for a completely filled page. At 1932 x 1932 with 5x10 cells,
`floor(1932/5) * floor(1932/10) = 386 * 193 = 74498` characters. Source line
breaks, word wrapping and escapes can reduce the actual capacity. Increasing
1600 from the old 1568 ceiling adds `(1600/1568)^2 - 1 = 4.12%` pixel area;
the former 64-column limit was a much larger constraint on full-page use.

## Fonts, image themes and options

JetBrains Mono NL Regular is the default, rasterized from the installed TTF at
13 px into an 8 x 18 glyph atlas. The default `dark` image theme renders white
text on black; `light` renders black text on white. These are actual PNG pixel
values, including downloads and clipboard images, not CSS filters. The selector
shows all fonts; capacity is shown for the configured maximum canvas and each
rendered page. Saved entries without a theme retain the old light appearance.
Reset selects the new JetBrains/dark defaults.

At 1600 x 1600 the JetBrains layout fits 200 columns x 88 rows = 17600 cells.
At 1932 x 1932 it fits 241 columns x 107 rows = 25787 cells. Source line breaks
and wrapping can leave cells empty. Raster provenance is in
`assets/jetbrains-mono.json`; `scripts/import_jetbrains.py` rebuilds the atlas
from the original TTF. No font installation is needed at runtime.

The reference study did not measure this JetBrains atlas or inverted images.
Assumption A7: model readability transfers to this font/theme; this remains
unknown and requires a paired held-out transcription test.

## Presets and options

| Preset | Embedded font | Cell area (px^2) | Intended use |
|---|---|---:|---|
| `jetbrains_mono` (default) | JetBrains Mono NL Regular 13px | 144 | 8x18 cells, embedded Unicode glyph atlas |
| `safe` | `8x16` | 128 | Conservative mixed text/code |
| `data` | `6x13` | 78 | Denser mixed text and short opaque fields |
| `prose` | `clR5x10` | 50 | Dense redundant prose; not an exact-data fidelity claim |
| `large` | `9x18` | 162 | Larger glyphs for comparison or inspection |

CLI/library defaults correspond directly to these JSON fields:

```json
{
  "preset": "jetbrains_mono",
  "theme": "dark",
  "max_width": 1600,
  "max_height": 1600,
  "max_columns": 64,
  "grid": 32,
  "page_mode": "compact",
  "reflow": false
}
```

The web UI overrides `max_columns` to `0` and `page_mode` to `full`, so its
default uses the complete shared canvas. `--page-mode full --max-columns 0`
selects the same behavior from the CLI. For Claude also pass
`--max-width 1932 --max-height 1932 --grid 28`.

`grid` accepts 224, 28 or 32. Dimensions must be at least one grid unit and at
most 1932. In `compact` mode the search uses whole grid units at or below each
bound. In `full` mode every page, including the final page, uses the exact
dimensions; grid alignment is not applied. The UI disables the grid selector
in full mode. `max_columns` accepts `0` (automatic) or 12 through 512. Automatic
uses `floor(width/cell_width)` columns. An explicit limit may reduce that count.
Default wrapping
preserves all whitespace and wraps preferentially after a space, retaining the
space. Long tokens wrap at character boundaries. Escape sequences never split.
`--reflow` explicitly collapses Unicode whitespace to single spaces and removes
leading/trailing whitespace; that mode changes the input representation.

JetBrains Mono renders supported printable characters directly, including em/en
dashes, curly quotes, ellipses, accented Latin, Greek and Cyrillic. Its embedded
atlas contains 1327 spacing glyphs from the installed font. Wrapping and capacity
count glyphs, not UTF-8 bytes. The historical bitmap fonts retain ASCII coverage.
Unsupported characters, controls and combining marks use explicit `\u{hex}`
fallbacks; tabs use `\t`, CR uses `\r`, and literal backslashes are escaped as
`\\`. LF is a hard row break. This is a fixed-cell renderer, not a shaping engine;
unsupported emoji/CJK and decomposed combining sequences are not silently replaced.

`pageText()` is a visual transcript with wrap newlines. For exact reconstruction
without reflow, concatenate every row's `text` in page order, appending LF only
when `hard_break` is true; then decode the documented escapes. Empty input yields
one blank page. `source_sha256` hashes the original UTF-8 bytes, before reflow.
Row metadata contains the source text in escaped form; applications control
whether to retain or export it alongside images.

## Packing algorithm and resource bounds

In compact mode, for each permissible grid width `w`, use
`columns = floor(w/cell_width)` with automatic columns, otherwise
`min(floor(w/cell_width), max_columns)`, wrap text once, and enumerate
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

Full mode wraps at the chosen width and paginates in chunks of
`floor(max_height/cell_height)` rows without a geometry search. Glyphs remain
their original pixel size; this mode adds blank pixels to a partially filled
last page rather than enlarging its text. It maximizes capacity per full page,
not characters per billed token for short inputs.

For `N` escaped bytes, `W` candidate widths, `H` candidate heights and `A` pixels
in a rendered page: layout time is `O(W*N + W*H)` and auxiliary space is
`O(N + W*H)`; rendering time is `O(A)` with `O(A)` space. The column limit is a
fixed bound, so bounded row scans do not change this asymptotic expression.
Raster storage before PNG compression is exactly
`ceil(width/8)*height` bytes. A 1600 by 1600 page takes 320000 raw raster bytes,
versus 7680000 bytes for RGB8, a factor of 24. A 1932 by 1932 page uses
`242 * 1932 = 467544` raster bytes, including four padding bits per scanline.
Full-mode layout time and auxiliary space are `O(N)`; rendering stays `O(A)`.
Compressed-file savings depend on content and are not assumed to be 24-fold.

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
| A4 | 1600 px is a shared working envelope derived from GPT-5.6 and Claude; GPT-6 square ceilings and current provider resizing are unknown | Independently probe target model's adjacent square boundaries and delivered pixels | Profile choice, not universal model compatibility |
| A5 | Escapes are acceptable for unsupported scripts | Round-trip Unicode/control fixtures; inspect non-Latin use cases | Arbitrary UTF-8 transport, not native-script readability |
| A6 | Preserving whitespace is required unless reflow is requested | Compare reconstructed escaped stream and original SHA-256 | Fidelity and pagination |

| Impact | Additional pattern | Boundary / probe |
|---|---|---|
| High | OCR can substitute symbols or bind a correct value to the wrong record | No exact transcription guarantee; retain canonical source and validate extracted identifiers independently |
| Medium | Leading-zero runs caused many rejected reference codewords | Textizer preserves them; it does not silently canonicalize data or claim a tested repair |
| Medium | Tight packing may reduce model readability despite pixel equivalence | Compare `safe`, `data`, `prose`, and `large` on held-out target content |
| Medium | Full-width pages create longer lines than the historical 64-column data preset | Use compact mode and an explicit 64-column limit when comparing high-entropy reads; full-page capacity is not an accuracy result |
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
node scripts/verify_options.mjs
BROWSER=/path/to/chrome node scripts/verify_browser.mjs
```

The independent Pillow oracle checks decoded RGB, not PNG file hashes. The Node
test instantiates the same web-target WASM module and tests multi-page output,
metadata, escaping, deterministic PNGs, typed arrays and error propagation.
The browser test uses an isolated headless Chromium profile and a temporary local
HTTP server; Node >= 22 is required. It verifies native browser PNG decoding,
the example UI's generation of downloadable images, and the web UI's rendering,
outside-editor paste and history restore. It also checks full-size 1600/1932
profiles, automatic columns, compact mode, defaults and saved profile restore.
Live model inference remains outside
this validation.

Verified locally: 15 Rust tests, Clippy with warnings denied, exact decoded RGB
matches across the historical fonts (including both full resolutions), the Node WASM API, Chromium
PNG decoding on six pages, the example browser UI and the web UI. The release
WASM artifact size depends on the build and embedded glyph atlases.

Quality gates: implementation decisions are factual/technical (QG1); assumptions
and probes are above (QG2); native and WASM usage are covered (QG3); pixel formulas
and bounds are explicit (QG4); edge cases have regression tests (QG5); reference
hashes, font origins and standards are recorded (QG6); additional implications are
bounded above (QG7). No inference accuracy is claimed from renderer tests.

Font origins and redistributed notices are listed in
[assets/NOTICE.md](assets/NOTICE.md). The Python import/verification scripts are
development tools only.

## Output cropping

Cropping is enabled by default (`crop: true`). The 1600/1932 px settings remain
layout limits. After pagination, unused trailing rows and columns are removed
from each PNG at glyph-cell boundaries; text is never scaled. Trailing blank
source rows and spaces remain in row metadata for exact reconstruction. Leading
indentation and interior whitespace are preserved. An empty page is one blank
cell. Disable the crop switch or pass `--no-crop` for fixed-size canvases.

The maximum-capacity indicator refers to the layout limits; per-page capacity
and dimensions refer to the cropped raster. Cropping changes geometric patch
counts, which are recomputed from the actual PNG dimensions. Full-mode exact
canvas descriptions above apply when cropping is disabled.

## JetBrains size and antialiasing

The font size control accepts 8 through 16 px. Default: 13 px with antialiasing
enabled. Every size has its own embedded raster atlas, generated directly from
the original TTF through Pillow/FreeType. This uses the rasterizer's native-size
font rendering; it does not add a custom hinting engine or RGB subpixel rendering.
No bitmap is enlarged or reduced at runtime. Glyphs use fixed-cell boundaries.

With antialiasing on, JetBrains PNGs use opaque 8-bit grayscale and retain
intermediate coverage values. With it off, coverage is thresholded at 128 and
output is 1-bit grayscale. Older bitmap fonts remain 1-bit regardless of this
setting. Dark and light themes remain exact inverses; cropping applies to both.

CLI: `--font-size 10` and optionally `--no-antialias`. WASM JSON fields:
`font_size: 10`, `antialias: true`. Cells and atlas hashes are recorded in
`assets/jetbrains-sizes.json`. The importer requires Pillow and fontTools only
at development time. The UI recalculates capacity when size changes.

| Size (px) | Cell (px) | Maximum characters at 1600 x 1600 |
|---|---|---:|
| 8 | 5 x 12 | 42560 |
| 9 | 6 x 13 | 32718 |
| 10 | 6 x 14 | 30324 |
| 11 | 7 x 16 | 22800 |
| 12 | 8 x 17 | 18800 |
| 13 | 8 x 18 | 17600 |
| 14 | 9 x 20 | 14160 |
| 15 | 9 x 21 | 13452 |
| 16 | 10 x 22 | 11520 |

These are completely filled cells with automatic columns. Recognition accuracy
for smaller sizes and grayscale remains unmeasured. Wide glyph overhangs are
clipped to the fixed cell, as with the original atlas. An 8-bit full 1600 x 1600
page needs 2560000 raw raster bytes versus 320000 for 1-bit, before compression.

## File and folder sets

Drop files or directories, use **open file** / **open folder**, or paste file
entries supplied by the browser. Folder traversal is recursive and drains every
`readEntries()` batch. The file list supports individual removal, a path prefix,
and combined or per-file images. Each included file begins with `# path` and LF.
In per-file mode each file starts a new native document; long files can still
produce multiple pages. Combined mode packs files consecutively in path order.
Files are never reflowed, so path headers retain their line breaks.

Browsers expose selected-folder-relative paths, not arbitrary absolute OS paths.
For a selected `project` folder, enter its parent (e.g. `/Users/me`) as the prefix
for headers such as `# /Users/me/project/src/main.rs`. The prefix is descriptive;
it never grants the page filesystem access. The editor is a read-only preview
while a file set is active; only the first 256 Ki UTF-16 units are previewed.
The complete accepted set is rendered and stored in IndexedDB, with its mode
and prefix, and is restored after reload. Removing a file updates the output.

Finder folder paste is conditional on the browser exposing readable directory
entries. The same paste handler supports those entries and multiple files, even
when the read-only preview is focused. When native clipboard data contains only
an inaccessible local path or unreadable folder reference, **open folder** is the
fallback permission flow. Arbitrary `file://` paths are never fetched or treated
as file contents. A synthesized directory paste is exercised by the browser
tests; native Finder copy/paste behavior is browser-dependent and not certified
by that test. See the [directory entry API](https://developer.mozilla.org/en-US/docs/Web/API/DataTransferItem/webkitGetAsEntry)
and [WebKit clipboard behavior](https://webkit.org/blog/8170/clipboard-api-improvements/).

Text detection uses MIME types, known binary signatures, strict UTF-8 (or
BOM-marked UTF-16) decoding, and rejection of binary control characters. It does
not trust a `.txt` extension. Rejected files are listed with reasons. Detection
is a heuristic: an arbitrary all-printable byte stream is indistinguishable from
text; some text containing terminal control codes is deliberately excluded.
BOM encoding markers are consumed during decoding. UTF-16 becomes UTF-8 text.

Limits: 4 MiB per file, 16 MiB decoded text and 512 accepted files per set,
10000 visited entries, and directory depth 64. Larger combined streams and
header-prefixed files are split at Unicode scalar boundaries into native inputs
of at most 4 MiB. Across all inputs, the 4096-page limit still applies. Only one
native document is retained for on-demand PNG generation; the plan records each
page's source input and original file path. ZIP exports include all PNGs,
`rows.json`, and a combined manifest with file metadata and output mode.

Validation: `node scripts/verify_files.mjs` covers directory batches, binary
filtering, UTF-16, headers, Unicode chunk boundaries, and per-file versus
combined plans. `verify_browser.mjs` covers nested entry drop/paste, real folder
input, individual removal, persistent settings, and ZIP export contents.

File-set assumptions and probes:

| ID | Assumption / boundary | Probe |
|---|---|---|
| F1 | The browser exposes only selected-folder-relative paths | Real Chromium folder-input test; an explicit prefix constructs absolute headers |
| F2 | A native clipboard may omit directory entries | Directory-entry paste is tested synthetically; real Finder behavior remains browser-dependent and uses the picker fallback |
| F3 | Encoding and byte signatures distinguish ordinary text from common binaries, not every possible format | Invalid UTF-8, PNG/PDF/executable signatures, NUL/control bytes, UTF-16, and empty-file tests |
| F4 | File boundaries are preserved independently of layout choices | Combined/per-file native plans, reflow disabled for sets, persisted removal, and ZIP header checks |

Collection takes O(N + B + F log F) time and O(B + F) retained space, where N is
visited entries, B decoded bytes, and F accepted files. Directory depth and total
entries are bounded. Rendering adds the existing layout cost for each bounded
chunk; only one native document is cached at a time. A large set can still take
noticeable time; navigation invalidates an in-progress import rather than merging
its late results into another open entry.
