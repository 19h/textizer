use textizer::{Document, Options, PageMode, Preset, Theme};

fn legacy() -> Options {
    Options {
        preset: Preset::Safe,
        theme: Theme::Light,
        antialias: false,
        font_size: 13,
        crop: false,
        ..Options::default()
    }
}

fn escaped(doc: &Document) -> String {
    let mut out = String::new();
    for i in 0..doc.manifest().pages.len() {
        for row in doc.page_rows(i).unwrap() {
            out.push_str(&row.text);
            if row.hard_break {
                out.push('\n');
            }
            assert!(row.text.chars().count() <= doc.manifest().columns as usize);
        }
    }
    out
}

#[test]
fn preserves_whitespace_and_escapes_without_ambiguous_backslashes() {
    let input = "  alpha   beta\t\\u{41}\r\n\nUnicode: \u{03b1}\u{1f9ec}\0\n";
    let doc = Document::new(
        input,
        Options {
            max_width: 224,
            max_height: 224,
            grid: 224,
            ..legacy()
        },
    )
    .unwrap();
    assert_eq!(
        escaped(&doc),
        "  alpha   beta\\t\\\\u{41}\\r\n\nUnicode: \\u{3b1}\\u{1f9ec}\\u{0}\n"
    );
    assert_eq!(doc.manifest().source_sha256.len(), 64);
}

#[test]
fn page_boundaries_never_drop_or_duplicate_text() {
    let input = (0..1000)
        .map(|i| format!("item_{i:04} abcdef0123456789 \n"))
        .collect::<String>();
    let doc = Document::new(
        &input,
        Options {
            max_width: 224,
            max_height: 224,
            grid: 224,
            ..legacy()
        },
    )
    .unwrap();
    assert!(doc.manifest().pages.len() > 1);
    assert_eq!(escaped(&doc), input);
    for page in &doc.manifest().pages {
        assert_eq!(page.width % 224, 0);
        assert_eq!(page.height % 224, 0);
        assert!(page.row_count * 16 <= page.height as usize);
    }
}

#[test]
fn long_tokens_and_escape_atoms_fit_all_presets() {
    for preset in [Preset::Safe, Preset::Data, Preset::Prose, Preset::Large] {
        for grid in [28, 32, 224] {
            let input = format!("{}\u{10ffff}{}", "x".repeat(200), "y".repeat(200));
            let doc = Document::new(
                &input,
                Options {
                    preset,
                    grid,
                    max_columns: 12,
                    ..legacy()
                },
            )
            .unwrap();
            assert_eq!(
                escaped(&doc),
                format!("{}\\u{{10ffff}}{}", "x".repeat(200), "y".repeat(200))
            );
            for i in 0..doc.manifest().pages.len() {
                for row in doc.page_rows(i).unwrap() {
                    if row.text.contains('\\') {
                        assert!(row.text.contains("\\u{10ffff}"));
                    }
                }
            }
        }
    }
}

#[test]
fn png_is_one_bit_grayscale_and_deterministic() {
    let doc = Document::new("Hello, world!", legacy()).unwrap();
    let bytes = doc.page_png(0).unwrap();
    assert_eq!(bytes, doc.page_png(0).unwrap());
    let decoder = png::Decoder::new(bytes.as_slice());
    let reader = decoder.read_info().unwrap();
    assert_eq!(reader.info().bit_depth, png::BitDepth::One);
    assert_eq!(reader.info().color_type, png::ColorType::Grayscale);
    assert_eq!(reader.info().width, doc.manifest().pages[0].width);
}

#[test]
fn empty_input_is_a_single_blank_page() {
    let doc = Document::new("", Options::default()).unwrap();
    assert_eq!(doc.manifest().pages.len(), 1);
    assert_eq!(escaped(&doc), "");
    assert_eq!(doc.manifest().pages[0].ink_characters, 0);
}

#[test]
fn invalid_options_and_page_indices_return_errors() {
    assert!(
        Document::new(
            "a",
            Options {
                grid: 0,
                ..legacy()
            }
        )
        .is_err()
    );
    assert!(
        Document::new(
            "a",
            Options {
                max_columns: 7,
                ..legacy()
            }
        )
        .is_err()
    );
    assert!(
        Document::new(
            "a",
            Options {
                max_width: u32::MAX,
                ..legacy()
            }
        )
        .is_err()
    );
    assert!(Document::new(&"a".repeat(4 * 1024 * 1024 + 1), Options::default()).is_err());
    assert!(serde_json::from_str::<Options>(r#"{"typo":true}"#).is_err());
    let doc = Document::new("a", Options::default()).unwrap();
    assert!(doc.page_png(1).is_err());
    assert!(doc.page_rows(usize::MAX).is_err());
}

#[test]
fn reflow_is_explicit_and_metadata_records_it() {
    let doc = Document::new(
        " a\t b\n\nc ",
        Options {
            reflow: true,
            ..legacy()
        },
    )
    .unwrap();
    assert_eq!(escaped(&doc), "a b c");
    assert!(doc.manifest().options.reflow);
}

#[test]
fn full_shared_pages_reach_1600_and_paginate_at_actual_capacity() {
    let input = "a".repeat(20_001);
    let doc = Document::new(
        &input,
        Options {
            page_mode: PageMode::Full,
            max_columns: 0,
            ..legacy()
        },
    )
    .unwrap();
    assert_eq!(doc.manifest().columns, 200);
    assert_eq!(doc.manifest().pages.len(), 2);
    assert_eq!(doc.manifest().pages[0].ink_characters, 20_000);
    assert_eq!(escaped(&doc), input);
    for page in &doc.manifest().pages {
        assert_eq!((page.width, page.height), (1600, 1600));
        assert_eq!(page.patches_32, 2500);
        let png = doc.page_png(page.index).unwrap();
        let decoder = png::Decoder::new(png.as_slice());
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (1600, 1600));
    }
}

#[test]
fn full_claude_prose_matches_the_research_capacity() {
    let input = "a".repeat(74_499);
    let doc = Document::new(
        &input,
        Options {
            preset: Preset::Prose,
            theme: Theme::Light,
            antialias: false,
            font_size: 13,
            crop: false,
            max_width: 1932,
            max_height: 1932,
            max_columns: 0,
            grid: 28,
            page_mode: PageMode::Full,
            reflow: false,
        },
    )
    .unwrap();
    assert_eq!(doc.manifest().columns, 386);
    assert_eq!(doc.manifest().pages.len(), 2);
    assert_eq!(doc.manifest().pages[0].row_count, 193);
    assert_eq!(doc.manifest().pages[0].ink_characters, 74_498);
    assert_eq!(doc.manifest().pages[0].patches_28, 4761);
    assert_eq!(escaped(&doc), input);
    for page in &doc.manifest().pages {
        assert_eq!((page.width, page.height), (1932, 1932));
    }
}

#[test]
fn full_mode_preserves_explicit_columns_and_ignores_grid_rounding() {
    let doc = Document::new(
        &"x".repeat(1000),
        Options {
            page_mode: PageMode::Full,
            grid: 224,
            max_columns: 64,
            ..legacy()
        },
    )
    .unwrap();
    assert_eq!(doc.manifest().columns, 64);
    assert_eq!(
        (
            doc.manifest().pages[0].width,
            doc.manifest().pages[0].height
        ),
        (1600, 1600)
    );
    assert!(
        Document::new(
            "x",
            Options {
                max_width: 1933,
                page_mode: PageMode::Full,
                ..legacy()
            }
        )
        .is_err()
    );
}

#[test]
fn compact_auto_columns_and_old_serialized_options_remain_supported() {
    let old: Options = serde_json::from_str(
        r#"{"max_width":1568,"max_height":1568,"grid":224,"max_columns":64,"crop":false}"#,
    )
    .unwrap();
    assert_eq!(old.page_mode, PageMode::Compact);
    let doc = Document::new("short", old).unwrap();
    assert_eq!(
        (
            doc.manifest().pages[0].width,
            doc.manifest().pages[0].height
        ),
        (224, 224)
    );
    let auto = Document::new(
        &"a".repeat(90_000),
        Options {
            preset: Preset::Prose,
            max_columns: 0,
            ..legacy()
        },
    )
    .unwrap();
    assert!(auto.manifest().columns > 256);
    for page in &auto.manifest().pages {
        assert!(page.width <= 1600 && page.height <= 1600);
    }
}

#[test]
fn jetbrains_dark_defaults_capacity_and_exact_inversion() {
    let mut options = Options {
        crop: false,
        page_mode: PageMode::Full,
        max_columns: 0,
        ..Options::default()
    };
    let dark = Document::new("JetBrains 0O 1Il != <= abcdef", options.clone()).unwrap();
    assert_eq!(dark.manifest().font, "JetBrains Mono NL Regular 13px");
    assert_eq!(dark.manifest().cell_width, 8);
    assert_eq!(dark.manifest().cell_height, 18);
    assert_eq!(dark.manifest().pages[0].capacity_rows, 88);
    assert_eq!(dark.manifest().pages[0].capacity_characters, 17_600);
    options.theme = Theme::Light;
    let light = Document::new("JetBrains 0O 1Il != <= abcdef", options).unwrap();
    fn pixels(doc: &Document) -> Vec<u8> {
        let png = doc.page_png(0).unwrap();
        let mut reader = png::Decoder::new(png.as_slice()).read_info().unwrap();
        let mut out = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut out).unwrap();
        out
    }
    let a = pixels(&dark);
    let b = pixels(&light);
    assert!(a.iter().any(|v| *v != 0));
    assert!(a.iter().zip(&b).all(|(a, b)| *a == !*b));
    assert_eq!(*a.last().unwrap(), 0);
    assert_eq!(*b.last().unwrap(), 255);
}

#[test]
fn supported_unicode_renders_directly_and_wraps_by_glyph_not_utf8_bytes() {
    let text = "—“”‘’…αβΩéЖ≤≥".repeat(100);
    let doc = Document::new(
        &text,
        Options {
            page_mode: PageMode::Full,
            max_columns: 12,
            max_width: 224,
            max_height: 224,
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(escaped(&doc), text);
    assert_eq!(doc.manifest().pages[0].ink_characters, 12 * 12);
    for i in 0..doc.manifest().pages.len() {
        assert!(doc.page_png(i).is_ok());
    }
    let missing = Document::new("—\u{1f9ec}", Options::default()).unwrap();
    assert_eq!(escaped(&missing), "—\\u{1f9ec}");
    let ascii = Document::new("—", legacy()).unwrap();
    assert_eq!(escaped(&ascii), "\\u{2014}");
}

#[test]
fn crop_removes_unused_canvas_without_changing_rows_or_glyphs() {
    for theme in [Theme::Dark, Theme::Light] {
        let opts = Options {
            antialias: false,
            page_mode: PageMode::Full,
            max_columns: 0,
            theme,
            ..Options::default()
        };
        let cropped = Document::new("abc   \nx\n\n", opts.clone()).unwrap();
        let full = Document::new(
            "abc   \nx\n\n",
            Options {
                crop: false,
                ..opts
            },
        )
        .unwrap();
        let pg = &cropped.manifest().pages[0];
        assert_eq!((pg.width, pg.height), (24, 36));
        assert_eq!((pg.capacity_rows, pg.capacity_characters), (2, 6));
        assert_eq!(escaped(&cropped), escaped(&full));
        let decode = |d: &Document| {
            let bytes = d.page_png(0).unwrap();
            let mut reader = png::Decoder::new(bytes.as_slice()).read_info().unwrap();
            let mut out = vec![0; reader.output_buffer_size()];
            reader.next_frame(&mut out).unwrap();
            out
        };
        let a = decode(&cropped);
        let b = decode(&full);
        for y in 0..36 {
            assert_eq!(&a[y * 3..(y + 1) * 3], &b[y * 200..y * 200 + 3]);
        }
    }
    let empty = Document::new("", Options::default()).unwrap();
    assert_eq!(
        (
            empty.manifest().pages[0].width,
            empty.manifest().pages[0].height
        ),
        (8, 18)
    );
}

#[test]
fn smaller_sizes_and_grayscale_coverage_are_real_rasters() {
    let cells = [
        (8, 5, 12),
        (9, 6, 13),
        (10, 6, 14),
        (11, 7, 16),
        (12, 8, 17),
        (13, 8, 18),
        (14, 9, 20),
        (15, 9, 21),
        (16, 10, 22),
    ];
    for (size, width, height) in cells {
        let options = Options {
            font_size: size,
            max_columns: 0,
            page_mode: PageMode::Full,
            ..Options::default()
        };
        let doc = Document::new("Wavy — é Ω", options.clone()).unwrap();
        assert_eq!(
            (doc.manifest().cell_width, doc.manifest().cell_height),
            (width, height)
        );
        assert_eq!(escaped(&doc), "Wavy — é Ω");
        let bytes = doc.page_png(0).unwrap();
        let mut reader = png::Decoder::new(bytes.as_slice()).read_info().unwrap();
        assert_eq!(reader.info().bit_depth, png::BitDepth::Eight);
        let mut raster = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut raster).unwrap();
        assert!(raster.iter().any(|p| *p > 0 && *p < 255));
        let crisp = Document::new(
            "Wavy — é Ω",
            Options {
                antialias: false,
                ..options
            },
        )
        .unwrap();
        let bytes = crisp.page_png(0).unwrap();
        assert_eq!(
            png::Decoder::new(bytes.as_slice())
                .read_info()
                .unwrap()
                .info()
                .bit_depth,
            png::BitDepth::One
        );
    }
    assert!(
        Document::new(
            "x",
            Options {
                font_size: 7,
                ..Options::default()
            }
        )
        .is_err()
    );
    assert!(
        Document::new(
            "x",
            Options {
                font_size: 17,
                ..Options::default()
            }
        )
        .is_err()
    );
}
