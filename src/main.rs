use std::{
    error::Error,
    fs,
    io::{self, Read},
    path::PathBuf,
};
use textizer::{Document, Options, PageMode, Preset, Theme};

fn main() {
    if let Err(error) = run() {
        eprintln!("textizer: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let mut input = None;
    let mut out = PathBuf::from("packed");
    let mut options = Options::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!(
                    "textizer [INPUT|-] [--out DIR] [--preset jetbrains_mono|safe|data|prose|large]\n\
                    [--theme dark|light] [--no-crop] [--font-size 8..16] [--no-antialias]\n\
                    [--max-width PX] [--max-height PX] [--max-columns N]\n\
                    [--grid 224|28|32] [--page-mode compact|full] [--reflow]\n\n\
                    --max-columns 0 uses the full canvas width; dimensions are limited to 1932 px.\n\
                    Reads UTF-8 from INPUT or stdin. Writes PNG pages, row metadata and manifest.json.\n\
                    Output files are created exclusively; existing files are never overwritten."
                );
                return Ok(());
            }
            "--out" => out = args.next().ok_or("--out requires a directory")?.into(),
            "--preset" => {
                options.preset = match args.next().as_deref() {
                    Some("jetbrains_mono") => Preset::JetbrainsMono,
                    Some("safe") => Preset::Safe,
                    Some("data") => Preset::Data,
                    Some("prose") => Preset::Prose,
                    Some("large") => Preset::Large,
                    _ => {
                        return Err(
                            "--preset requires jetbrains_mono, safe, data, prose, or large".into(),
                        );
                    }
                }
            }
            "--theme" => {
                options.theme = match args.next().as_deref() {
                    Some("dark") => Theme::Dark,
                    Some("light") => Theme::Light,
                    _ => return Err("--theme requires dark or light".into()),
                }
            }
            "--no-crop" => options.crop = false,
            "--font-size" => options.font_size = args.next().ok_or("missing font size")?.parse()?,
            "--no-antialias" => options.antialias = false,
            "--max-width" => options.max_width = args.next().ok_or("missing width")?.parse()?,
            "--max-height" => options.max_height = args.next().ok_or("missing height")?.parse()?,
            "--max-columns" => {
                options.max_columns = args.next().ok_or("missing column count")?.parse()?
            }
            "--grid" => options.grid = args.next().ok_or("missing grid")?.parse()?,
            "--page-mode" => {
                options.page_mode = match args.next().as_deref() {
                    Some("compact") => PageMode::Compact,
                    Some("full") => PageMode::Full,
                    _ => return Err("--page-mode requires compact or full".into()),
                }
            }
            "--reflow" => options.reflow = true,
            "-" => {
                if input.replace(arg).is_some() {
                    return Err("only one input allowed".into());
                }
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}").into()),
            _ => {
                if input.replace(arg).is_some() {
                    return Err("only one input allowed".into());
                }
            }
        }
    }
    // Bound reads as well as library input so a large file/pipe cannot exhaust memory first.
    let mut reader: Box<dyn Read> = match input.as_deref() {
        None | Some("-") => Box::new(io::stdin()),
        Some(path) => Box::new(fs::File::open(path)?),
    };
    let mut text = String::new();
    reader
        .by_ref()
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    let document = Document::new(&text, options)?;
    fs::create_dir_all(&out)?;
    // Reserve every destination before writing so collisions cannot mix old/new documents.
    let mut paths: Vec<_> = document
        .manifest()
        .pages
        .iter()
        .map(|p| out.join(&p.filename))
        .collect();
    paths.push(out.join("rows.json"));
    paths.push(out.join("manifest.json"));
    let mut files = Vec::new();
    for path in &paths {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => files.push(file),
            Err(error) => {
                drop(files);
                for created in paths.iter().take_while(|p| *p != path) {
                    let _ = fs::remove_file(created);
                }
                return Err(error.into());
            }
        }
    }
    use std::io::Write;
    let result = (|| -> Result<(), Box<dyn Error>> {
        let page_count = document.manifest().pages.len();
        for (i, file) in files.iter_mut().take(page_count).enumerate() {
            file.write_all(&document.page_png(i)?)?;
        }
        let rows: Vec<_> = (0..page_count)
            .map(|i| document.page_rows(i))
            .collect::<Result<_, _>>()?;
        serde_json::to_writer(&mut files[page_count], &rows)?;
        files[page_count + 1].write_all(document.manifest_json()?.as_bytes())?;
        Ok(())
    })();
    if result.is_err() {
        drop(files);
        for path in &paths {
            let _ = fs::remove_file(path);
        }
    }
    result?;
    println!(
        "{} page(s), {} font, manifest: {}",
        document.manifest().pages.len(),
        document.manifest().font,
        out.join("manifest.json").display()
    );
    Ok(())
}
