//! Deterministic text-to-bitmap packing. No platform fonts or graphics API required.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ESCAPED_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGES: usize = 4096;
/// Largest measured square in the reference corpus (Claude); not a universal model limit.
pub const MAX_DIMENSION: u32 = 1932;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageMode {
    /// Minimize area, then prefer fewer pages within 15% of the minimum.
    #[default]
    Compact,
    /// Paginate at max_width by max_height; cropping may trim unused output.
    Full,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    #[default]
    JetbrainsMono,
    Safe,
    Data,
    Prose,
    Large,
}

impl Preset {
    fn font(self, size: u32) -> Font {
        match self {
            Self::JetbrainsMono => jetbrains_font(size),
            Self::Safe => Font {
                name: "8x16",
                width: 8,
                height: 16,
                pixels: include_bytes!("../assets/8x16.bin"),
                codepoints: None,
                grayscale: false,
            },
            Self::Data => Font {
                name: "6x13",
                width: 6,
                height: 13,
                pixels: include_bytes!("../assets/6x13.bin"),
                codepoints: None,
                grayscale: false,
            },
            Self::Prose => Font {
                name: "clR5x10",
                width: 5,
                height: 10,
                pixels: include_bytes!("../assets/clR5x10.bin"),
                codepoints: None,
                grayscale: false,
            },
            Self::Large => Font {
                name: "9x18",
                width: 9,
                height: 18,
                pixels: include_bytes!("../assets/9x18.bin"),
                codepoints: None,
                grayscale: false,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub preset: Preset,
    pub font_size: u32,
    pub antialias: bool,
    pub theme: Theme,
    /// Remove unused trailing rows and columns without changing glyph size.
    pub crop: bool,
    pub max_width: u32,
    pub max_height: u32,
    /// Zero uses every column that fits the selected canvas.
    pub max_columns: u32,
    pub page_mode: PageMode,
    /// 224 aligns the historical 28 px and 32 px grids; also accepts 28 or 32.
    pub grid: u32,
    /// Explicitly permits loss of original whitespace; false preserves it.
    pub reflow: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            preset: Preset::JetbrainsMono,
            font_size: 13,
            antialias: true,
            theme: Theme::Dark,
            crop: true,
            max_width: 1600,
            max_height: 1600,
            max_columns: 64,
            page_mode: PageMode::Compact,
            grid: 32,
            reflow: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
fn err(message: impl Into<String>) -> Error {
    Error(message.into())
}

#[derive(Clone, Copy)]
struct Font {
    name: &'static str,
    width: u32,
    height: u32,
    pixels: &'static [u8],
    codepoints: Option<&'static [u8]>,
    grayscale: bool,
}

fn jetbrains_font(size: u32) -> Font {
    let (name, width, height, pixels): (&str, u32, u32, &[u8]) = match size {
        8 => (
            "JetBrains Mono NL Regular 8px",
            5,
            12,
            include_bytes!("../assets/jetbrains-mono-8.gray.bin"),
        ),
        9 => (
            "JetBrains Mono NL Regular 9px",
            6,
            13,
            include_bytes!("../assets/jetbrains-mono-9.gray.bin"),
        ),
        10 => (
            "JetBrains Mono NL Regular 10px",
            6,
            14,
            include_bytes!("../assets/jetbrains-mono-10.gray.bin"),
        ),
        11 => (
            "JetBrains Mono NL Regular 11px",
            7,
            16,
            include_bytes!("../assets/jetbrains-mono-11.gray.bin"),
        ),
        12 => (
            "JetBrains Mono NL Regular 12px",
            8,
            17,
            include_bytes!("../assets/jetbrains-mono-12.gray.bin"),
        ),
        13 => (
            "JetBrains Mono NL Regular 13px",
            8,
            18,
            include_bytes!("../assets/jetbrains-mono-13.gray.bin"),
        ),
        14 => (
            "JetBrains Mono NL Regular 14px",
            9,
            20,
            include_bytes!("../assets/jetbrains-mono-14.gray.bin"),
        ),
        15 => (
            "JetBrains Mono NL Regular 15px",
            9,
            21,
            include_bytes!("../assets/jetbrains-mono-15.gray.bin"),
        ),
        16 => (
            "JetBrains Mono NL Regular 16px",
            10,
            22,
            include_bytes!("../assets/jetbrains-mono-16.gray.bin"),
        ),
        _ => unreachable!("validated font size"),
    };
    Font {
        name,
        width,
        height,
        pixels,
        codepoints: Some(include_bytes!("../assets/jetbrains-mono-codepoints.bin")),
        grayscale: true,
    }
}

impl Font {
    fn glyph_index(self, ch: char) -> Option<usize> {
        let Some(points) = self.codepoints else {
            return (' '..='~').contains(&ch).then(|| ch as usize - 32);
        };
        let mut low = 0;
        let mut high = points.len() / 4;
        while low < high {
            let mid = low + (high - low) / 2;
            let code = u32::from_le_bytes(points[mid * 4..mid * 4 + 4].try_into().unwrap());
            match code.cmp(&(ch as u32)) {
                std::cmp::Ordering::Equal => return Some(mid),
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
            }
        }
        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub text: String,
    /// True only when the source contained a newline here (not a visual wrap).
    pub hard_break: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Page {
    pub index: usize,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    pub first_row: usize,
    pub row_count: usize,
    pub capacity_rows: u32,
    pub capacity_characters: u32,
    pub ink_characters: usize,
    pub patches_28: u32,
    pub patches_32: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub format: &'static str,
    pub mime_type: &'static str,
    pub pixel_format: &'static str,
    pub text_encoding: &'static str,
    pub source_sha256: String,
    pub input_bytes: usize,
    pub escaped_bytes: usize,
    pub options: Options,
    pub font: &'static str,
    pub cell_width: u32,
    pub cell_height: u32,
    pub columns: u32,
    pub total_rows: usize,
    pub pages: Vec<Page>,
}

/// Owns text/layout only. PNGs are generated on demand, one bounded frame at a time.
pub struct Document {
    manifest: Manifest,
    rows: Vec<Row>,
    font: Font,
}

impl Document {
    pub fn new(text: &str, options: Options) -> Result<Self, Error> {
        if text.len() > MAX_INPUT_BYTES {
            return Err(err("input exceeds 4 MiB UTF-8 limit"));
        }
        if !(8..=16).contains(&options.font_size) {
            return Err(err("font_size must be between 8 and 16 pixels"));
        }
        if ![28, 32, 224].contains(&options.grid) {
            return Err(err("grid must be 28, 32, or 224 pixels"));
        }
        if !(options.grid..=MAX_DIMENSION).contains(&options.max_width)
            || !(options.grid..=MAX_DIMENSION).contains(&options.max_height)
        {
            return Err(err("dimensions must be between grid size and 1932 pixels"));
        }
        if options.max_columns != 0 && !(12..=512).contains(&options.max_columns) {
            return Err(err(
                "max_columns must be 0 (automatic) or between 12 and 512",
            ));
        }
        let source = if options.reflow {
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        } else {
            text.to_owned()
        };
        let font = options.preset.font(options.font_size);
        let escaped = escape_text(&source, font);
        if escaped.len() > MAX_ESCAPED_BYTES {
            return Err(err("escaped text exceeds 16 MiB limit"));
        }
        let chosen = if options.page_mode == PageMode::Full {
            let columns = columns_for(options.max_width, font.width, options.max_columns);
            if columns < 12 {
                return Err(err("canvas is too narrow for 12 font columns"));
            }
            let capacity = (options.max_height / font.height) as usize;
            let pages = wrap(&escaped, columns as usize).len().div_ceil(capacity);
            if pages > MAX_PAGES {
                return Err(err("layout exceeds 4096-page limit"));
            }
            Candidate {
                width: options.max_width,
                height: options.max_height,
                columns,
                capacity,
                pages,
                pixels: u64::from(options.max_width) * u64::from(options.max_height) * pages as u64,
            }
        } else {
            // Wrap once per candidate width. Enumerate heights arithmetically, without rasterising.
            let mut previous_columns = 0;
            let mut candidates = Vec::new();
            for width in (options.grid..=options.max_width).step_by(options.grid as usize) {
                let columns = columns_for(width, font.width, options.max_columns);
                if columns < 12 {
                    continue;
                }
                // Wider canvases with identical text columns can only waste pixels.
                if previous_columns == columns {
                    continue;
                }
                previous_columns = columns;
                let rows = wrap(&escaped, columns as usize);
                let count = rows.len();
                for height in (options.grid..=options.max_height).step_by(options.grid as usize) {
                    let capacity = (height / font.height) as usize;
                    if capacity == 0 {
                        continue;
                    }
                    let pages = count.div_ceil(capacity);
                    if pages > MAX_PAGES {
                        continue;
                    }
                    let last_rows = count - (pages - 1) * capacity;
                    let last_height = align(last_rows as u32 * font.height, options.grid);
                    let pixels = u64::from(width)
                        * ((pages as u64 - 1) * u64::from(height) + u64::from(last_height));
                    candidates.push(Candidate {
                        width,
                        columns,
                        height,
                        capacity,
                        pages,
                        pixels,
                    });
                }
            }
            let minimum = candidates
                .iter()
                .map(|c| c.pixels)
                .min()
                .ok_or_else(|| err("no layout fits dimensions and 4096-page limit"))?;
            // Within 15% of minimum area, prefer fewer attachments; integer arithmetic.
            candidates
                .into_iter()
                .filter(|c| c.pixels * 100 <= minimum * 115)
                .min_by_key(|c| (c.pages, c.pixels, c.width, c.height))
                .unwrap()
        };
        let layout = Layout {
            width: chosen.width,
            columns: chosen.columns,
            rows: wrap(&escaped, chosen.columns as usize),
        };
        let mut pages = Vec::with_capacity(chosen.pages);
        for (index, chunk) in layout.rows.chunks(chosen.capacity).enumerate() {
            let mut height = if options.page_mode == PageMode::Compact && index + 1 == chosen.pages
            {
                align(chunk.len() as u32 * font.height, options.grid)
            } else {
                chosen.height
            };
            let mut width = layout.width;
            if options.crop {
                let used_rows = chunk
                    .iter()
                    .rposition(|r| !r.text.trim_end_matches(' ').is_empty())
                    .map_or(1, |i| i + 1);
                let used_columns = chunk
                    .iter()
                    .map(|r| r.text.trim_end_matches(' ').chars().count())
                    .max()
                    .unwrap_or(1)
                    .max(1);
                width = used_columns as u32 * font.width;
                height = used_rows as u32 * font.height;
            }
            pages.push(Page {
                index,
                filename: format!("page{:04}.png", index + 1),
                width,
                height,
                first_row: index * chosen.capacity,
                row_count: chunk.len(),
                capacity_rows: height / font.height,
                capacity_characters: (width / font.width) * (height / font.height),
                ink_characters: chunk.iter().map(|r| r.text.chars().count()).sum(),
                patches_28: width.div_ceil(28) * height.div_ceil(28),
                patches_32: width.div_ceil(32) * height.div_ceil(32),
            });
        }
        let manifest = Manifest {
            format: "textizer-v1",
            mime_type: "image/png",
            pixel_format: if font.grayscale && options.antialias {
                "8-bit grayscale; opaque; polarity in options.theme"
            } else {
                "1-bit grayscale; opaque; polarity in options.theme"
            },
            text_encoding: "UTF-8 font-supported glyphs with backslash escapes: \\\\, \\t, \\r, \\u{hex}; LF is a hard row break",
            source_sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            input_bytes: text.len(),
            escaped_bytes: escaped.len(),
            options,
            font: font.name,
            cell_width: font.width,
            cell_height: font.height,
            columns: layout.columns,
            total_rows: layout.rows.len(),
            pages,
        };
        Ok(Self {
            manifest,
            rows: layout.rows,
            font,
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn manifest_json(&self) -> Result<String, Error> {
        serde_json::to_string_pretty(&self.manifest).map_err(|e| err(e.to_string()))
    }
    pub fn page_rows(&self, index: usize) -> Result<&[Row], Error> {
        let page = self
            .manifest
            .pages
            .get(index)
            .ok_or_else(|| err("page index out of range"))?;
        Ok(&self.rows[page.first_row..page.first_row + page.row_count])
    }
    /// Display transcript; contains visual wraps. Use row hard_break metadata to reconstruct.
    pub fn page_text(&self, index: usize) -> Result<String, Error> {
        Ok(self
            .page_rows(index)?
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"))
    }
    pub fn page_png(&self, index: usize) -> Result<Vec<u8>, Error> {
        let page = self
            .manifest
            .pages
            .get(index)
            .ok_or_else(|| err("page index out of range"))?;
        let smooth = self.font.grayscale && self.manifest.options.antialias;
        let stride = if smooth {
            page.width
        } else {
            page.width.div_ceil(8)
        } as usize;
        let mut raster = vec![255u8; stride * page.height as usize];
        for (row_index, row) in self
            .page_rows(index)?
            .iter()
            .take((page.height / self.font.height) as usize)
            .enumerate()
        {
            for (column, ch) in row.text.trim_end_matches(' ').chars().enumerate() {
                let glyph = self
                    .font
                    .glyph_index(ch)
                    .ok_or_else(|| err("unsupported glyph in rendered row"))?;
                let base = glyph * (self.font.width * self.font.height) as usize;
                for y in 0..self.font.height as usize {
                    for x in 0..self.font.width as usize {
                        let sample = self.font.pixels[base + y * self.font.width as usize + x];
                        let coverage = if self.font.grayscale {
                            sample
                        } else if sample != 0 {
                            255
                        } else {
                            0
                        };
                        if coverage != 0 {
                            let px = column * self.font.width as usize + x;
                            let py = row_index * self.font.height as usize + y;
                            if smooth {
                                raster[py * stride + px] = 255 - coverage;
                            } else if coverage >= 128 {
                                raster[py * stride + px / 8] &= !(0x80 >> (px % 8));
                            }
                        }
                    }
                }
            }
        }
        if self.manifest.options.theme == Theme::Dark {
            for byte in &mut raster {
                *byte = !*byte;
            }
        }
        let mut output = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut output, page.width, page.height);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(if smooth {
                png::BitDepth::Eight
            } else {
                png::BitDepth::One
            });
            let mut writer = encoder.write_header().map_err(|e| err(e.to_string()))?;
            writer
                .write_image_data(&raster)
                .map_err(|e| err(e.to_string()))?;
        }
        Ok(output)
    }
}

struct Layout {
    width: u32,
    columns: u32,
    rows: Vec<Row>,
}
struct Candidate {
    width: u32,
    columns: u32,
    height: u32,
    capacity: usize,
    pages: usize,
    pixels: u64,
}
fn align(value: u32, grid: u32) -> u32 {
    value.div_ceil(grid) * grid
}

fn columns_for(width: u32, cell_width: u32, limit: u32) -> u32 {
    let capacity = width / cell_width;
    if limit == 0 {
        capacity
    } else {
        capacity.min(limit)
    }
}

/// Escape unrenderable characters, and escape literal backslashes to avoid ambiguity.
fn escape_text(text: &str, font: Font) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push(ch),
            _ if font.glyph_index(ch).is_some() => out.push(ch),
            _ => {
                write!(out, "\\u{{{:x}}}", ch as u32).unwrap();
            }
        }
    }
    out
}

/// Preserve every byte, wrapping at spaces when possible; never split an escape sequence.
fn wrap(text: &str, columns: usize) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for (line_index, line) in text.split('\n').enumerate() {
        if line_index != 0
            && let Some(row) = rows.last_mut()
        {
            row.hard_break = true;
        }
        let mut buffer = String::new();
        let mut cursor = 0;
        while cursor < line.len() {
            let size = if line.as_bytes()[cursor] == b'\\' {
                if line.as_bytes().get(cursor + 1) == Some(&b'u') {
                    line[cursor..].find('}').unwrap() + 1
                } else {
                    2
                }
            } else {
                line[cursor..].chars().next().unwrap().len_utf8()
            };
            let atom = &line[cursor..cursor + size];
            let atom_columns = atom.chars().count();
            if buffer.chars().count() + atom_columns > columns {
                let split = buffer.rfind(' ').map_or(buffer.len(), |p| p + 1);
                let tail = buffer.split_off(split);
                rows.push(Row {
                    text: std::mem::replace(&mut buffer, tail),
                    hard_break: false,
                });
                if buffer.chars().count() + atom_columns > columns {
                    rows.push(Row {
                        text: std::mem::take(&mut buffer),
                        hard_break: false,
                    });
                }
            }
            buffer.push_str(atom);
            cursor += size;
        }
        rows.push(Row {
            text: buffer,
            hard_break: false,
        });
    }
    rows
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// Render pages lazily. Call free() when the document is no longer needed.
    #[wasm_bindgen]
    pub struct PackedText {
        inner: Document,
    }

    #[wasm_bindgen]
    impl PackedText {
        #[wasm_bindgen(constructor)]
        pub fn new(text: &str, options_json: Option<String>) -> Result<PackedText, JsValue> {
            let options = match options_json {
                Some(json) => serde_json::from_str(&json).map_err(js_error)?,
                None => Options::default(),
            };
            Ok(Self {
                inner: Document::new(text, options).map_err(js_error)?,
            })
        }
        #[wasm_bindgen(getter, js_name = pageCount)]
        pub fn page_count(&self) -> usize {
            self.inner.manifest.pages.len()
        }
        #[wasm_bindgen(js_name = manifestJson)]
        pub fn manifest_json(&self) -> Result<String, JsValue> {
            self.inner.manifest_json().map_err(js_error)
        }
        #[wasm_bindgen(js_name = pagePng)]
        pub fn page_png(&self, index: usize) -> Result<Vec<u8>, JsValue> {
            self.inner.page_png(index).map_err(js_error)
        }
        #[wasm_bindgen(js_name = pageText)]
        pub fn page_text(&self, index: usize) -> Result<String, JsValue> {
            self.inner.page_text(index).map_err(js_error)
        }
        #[wasm_bindgen(js_name = pageRowsJson)]
        pub fn page_rows_json(&self, index: usize) -> Result<String, JsValue> {
            serde_json::to_string(self.inner.page_rows(index).map_err(js_error)?).map_err(js_error)
        }
    }
    fn js_error(error: impl fmt::Display) -> JsValue {
        JsValue::from_str(&error.to_string())
    }
}
