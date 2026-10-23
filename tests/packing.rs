use textizer::{Document, Options, Preset};

fn escaped(doc: &Document) -> String {
    let mut out = String::new();
    for i in 0..doc.manifest().pages.len() {
        for row in doc.page_rows(i).unwrap() {
            out.push_str(&row.text);
            if row.hard_break {
                out.push('\n');
            }
            assert!(row.text.len() <= doc.manifest().columns as usize);
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
            ..Options::default()
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
            ..Options::default()
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
                    ..Options::default()
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
    let doc = Document::new("Hello, world!", Options::default()).unwrap();
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
                ..Options::default()
            }
        )
        .is_err()
    );
    assert!(
        Document::new(
            "a",
            Options {
                max_columns: 0,
                ..Options::default()
            }
        )
        .is_err()
    );
    assert!(
        Document::new(
            "a",
            Options {
                max_width: u32::MAX,
                ..Options::default()
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
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(escaped(&doc), "a b c");
    assert!(doc.manifest().options.reflow);
}
