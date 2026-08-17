//! Foreign file → Markdown import.
//!
//! Adapted from SoloMD's `convert.rs` (MIT). Pure-Rust, no external tools:
//! DOCX/PPTX are ZIP-of-XML, XLSX via `calamine`, HTML via `htmd`, CSV/JSON/XML
//! and PDF-text extraction built in. It runs ONLY when a non-`.md` file is
//! opened, so it costs nothing to startup or typing.
//!
//! This module never touches the atomic writer in `lib.rs`: it reads a foreign
//! file and returns a Markdown String. The caller writes the result through the
//! normal atomic save path, so byte-stability and the writer quarantine hold.

use std::io::Read;
use std::path::Path;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::UTF_8;

/// Ceiling on a single zip entry. A compressed entry declares nothing about how
/// much it expands to — a few KB can claim gigabytes — and a failed Rust
/// allocation aborts the whole process rather than returning an Err, taking any
/// unsaved buffer with it. Everything else in this module is bounded by the real
/// file size; these are the only unbounded reads. A truncated XML fails its
/// parse and comes back as an error, which is the contract.
const MAX_ZIP_ENTRY_BYTES: u64 = 64 * 1024 * 1024;


/// Convert a foreign file to Markdown. Returns the Markdown text or an error.
#[tauri::command]
pub async fn convert_file_to_markdown(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || convert_inner(&path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn convert_inner(path: &str) -> Result<String, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "docx" => convert_docx(path),
        "html" | "htm" => convert_html(path),
        "csv" => convert_csv(path),
        "xlsx" | "xls" => convert_xlsx(path),
        "json" => convert_json(path),
        "xml" => convert_xml_file(path),
        "pptx" => convert_pptx(path),
        "pdf" => convert_pdf(path),
        _ => Err(format!("Can't import .{ext} files — unsupported format.")),
    }
}

/// Which encoding these bytes are (UTF-8/16 BOM, else chardetng) and how many
/// BOM bytes to skip.
fn detect_encoding(bytes: &[u8]) -> (&'static encoding_rs::Encoding, usize) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (UTF_8, 3)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE, 2)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE, 2)
    } else {
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
        detector.feed(bytes, true);
        (detector.guess(None, Utf8Detection::Allow), 0)
    }
}

/// The name of the encoding these bytes look like ("UTF-16LE", "windows-1251").
/// Used to tell the user what a note that isn't UTF-8 actually is.
pub fn encoding_name(bytes: &[u8]) -> &'static str {
    detect_encoding(bytes).0.name()
}

/// Read a file with automatic encoding detection (UTF-8/16 BOM, else chardetng).
fn read_with_encoding(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let (encoding, skip) = detect_encoding(&bytes);
    let (text, _, _) = encoding.decode(&bytes[skip..]);
    Ok(text.into_owned())
}

// ── DOCX → Markdown (ZIP of XML) ────────────────────────────────────────────

fn convert_docx(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid DOCX: {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("no document.xml in DOCX: {e}"))?
        .take(MAX_ZIP_ENTRY_BYTES)
        .read_to_string(&mut xml)
        .map_err(|e| format!("read DOCX: {e}"))?;
    docx_xml_to_markdown(&xml)
}

fn docx_xml_to_markdown(xml: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut line = String::new();
    let mut in_table_row = false;
    let mut cells: Vec<String> = Vec::new();
    let mut table_started = false;
    let mut heading: u8 = 0;
    let mut bold = false;
    let mut italic = false;
    let mut list_item = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match String::from_utf8_lossy(e.local_name().as_ref()).as_ref() {
                    "p" => {
                        line.clear();
                        heading = 0;
                        list_item = false;
                    }
                    "pStyle" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"w:val" {
                                let val =
                                    String::from_utf8_lossy(&attr.value).to_ascii_lowercase();
                                if val.starts_with("heading") || val.starts_with("title") {
                                    heading = val
                                        .chars()
                                        .last()
                                        .and_then(|c| c.to_digit(10))
                                        .unwrap_or(1) as u8;
                                }
                                if val.contains("list") {
                                    list_item = true;
                                }
                            }
                        }
                    }
                    // Emphasis is a run property: reset at each run start so a
                    // self-closing <w:b/> (no End event) can't bleed into later
                    // runs. Its <w:rPr> children below re-enable it for this run.
                    "r" => {
                        bold = false;
                        italic = false;
                    }
                    "b" => bold = true,
                    "i" => italic = true,
                    "tr" => {
                        in_table_row = true;
                        cells.clear();
                    }
                    "tc" => line.clear(),
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    if bold && italic {
                        line.push_str(&format!("***{text}***"));
                    } else if bold {
                        line.push_str(&format!("**{text}**"));
                    } else if italic {
                        line.push_str(&format!("*{text}*"));
                    } else {
                        line.push_str(&text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                match String::from_utf8_lossy(e.local_name().as_ref()).as_ref() {
                    "b" => bold = false,
                    "i" => italic = false,
                    "p" => {
                        let text = line.trim().to_string();
                        if in_table_row {
                            cells.push(escape_table_cell(&text));
                        } else if !text.is_empty() {
                            if heading > 0 && heading <= 6 {
                                out.push_str(&format!("{} {text}\n\n", "#".repeat(heading as usize)));
                            } else if list_item {
                                out.push_str(&format!("- {text}\n"));
                            } else {
                                out.push_str(&format!("{text}\n\n"));
                            }
                        }
                        line.clear();
                    }
                    "tr" => {
                        if !cells.is_empty() {
                            out.push_str(&format!("| {} |\n", cells.join(" | ")));
                            if !table_started {
                                out.push('|');
                                for _ in &cells {
                                    out.push_str(" --- |");
                                }
                                out.push('\n');
                                table_started = true;
                            }
                        }
                        in_table_row = false;
                    }
                    "tbl" => {
                        table_started = false;
                        out.push('\n');
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("DOCX XML parse: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(out.trim().to_string())
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

fn convert_html(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    let clean = strip_html_noise(&raw);
    htmd::convert(&clean).map_err(|e| format!("HTML conversion failed: {e}"))
}

/// Drop <style>/<script>/<head>/<nav>/<footer>/<noscript> blocks and comments
/// before conversion, so their contents don't leak into the Markdown as text.
fn strip_html_noise(html: &str) -> String {
    use std::borrow::Cow;
    let mut s: Cow<str> = Cow::Borrowed(html);
    for tag in &["style", "script", "head", "nav", "footer", "noscript"] {
        let re_str = format!(r"(?i)<{tag}[\s>][\s\S]*?</{tag}\s*>");
        if let Ok(re) = regex_lite::Regex::new(&re_str) {
            if let Cow::Owned(o) = re.replace_all(&s, "") {
                s = Cow::Owned(o);
            }
        }
    }
    if let Ok(re) = regex_lite::Regex::new(r"<!--[\s\S]*?-->") {
        if let Cow::Owned(o) = re.replace_all(&s, "") {
            s = Cow::Owned(o);
        }
    }
    s.into_owned()
}

// ── CSV → Markdown table ────────────────────────────────────────────────────

fn escape_table_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace('\r', "<br>")
        .replace('\n', "<br>")
}

fn convert_csv(path: &str) -> Result<String, String> {
    let text = read_with_encoding(path)?;
    let mut rdr = csv::Reader::from_reader(text.as_bytes());
    let mut out = String::new();

    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| format!("CSV header: {e}"))?
        .iter()
        .map(escape_table_cell)
        .collect();
    if !headers.is_empty() {
        out.push_str(&format!("| {} |\n|", headers.join(" | ")));
        for _ in &headers {
            out.push_str(" --- |");
        }
        out.push('\n');
    }
    for result in rdr.records() {
        let record = result.map_err(|e| format!("CSV row: {e}"))?;
        let cells: Vec<String> = record.iter().map(escape_table_cell).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    Ok(out.trim().to_string())
}

// ── XLSX/XLS → Markdown table(s) ────────────────────────────────────────────

fn convert_xlsx(path: &str) -> Result<String, String> {
    use calamine::{open_workbook_auto, Data, Reader};

    let mut workbook = open_workbook_auto(path).map_err(|e| format!("open spreadsheet: {e}"))?;
    let mut out = String::new();
    let sheets: Vec<String> = workbook.sheet_names().to_vec();

    for name in &sheets {
        if let Ok(range) = workbook.worksheet_range(name) {
            if sheets.len() > 1 {
                out.push_str(&format!("## {name}\n\n"));
            }
            let mut first_row = true;
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|cell| {
                        let value = match cell {
                            Data::Empty => String::new(),
                            Data::String(s) => s.clone(),
                            Data::Float(f) => format!("{f}"),
                            Data::Int(i) => format!("{i}"),
                            Data::Bool(b) => format!("{b}"),
                            Data::Error(e) => format!("#{e:?}"),
                            _ => cell.to_string(),
                        };
                        escape_table_cell(&value)
                    })
                    .collect();
                out.push_str(&format!("| {} |\n", cells.join(" | ")));
                if first_row {
                    out.push('|');
                    for _ in &cells {
                        out.push_str(" --- |");
                    }
                    out.push('\n');
                    first_row = false;
                }
            }
            out.push('\n');
        }
    }
    Ok(out.trim().to_string())
}

// ── JSON / XML → fenced code block ──────────────────────────────────────────

fn convert_json(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    let pretty = serde_json::from_str::<serde_json::Value>(&raw)
        .map(|v| serde_json::to_string_pretty(&v).unwrap_or_else(|_| raw.clone()))
        .unwrap_or(raw);
    Ok(format!("```json\n{pretty}\n```"))
}

fn convert_xml_file(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    Ok(format!("```xml\n{raw}\n```"))
}

// ── PDF → Markdown (text extraction, lossy) ─────────────────────────────────

fn convert_pdf(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF extraction failed: {e}"))?;
    if text.trim().is_empty() {
        return Err("No text found in this PDF (it may be scanned/image-only).".to_string());
    }

    let mut out = String::new();
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if is_pdf_garbage(trimmed) {
            continue;
        }
        let cleaned = clean_pdf_line(trimmed);
        let cleaned = cleaned.trim();
        if !cleaned.is_empty() {
            out.push_str(cleaned);
            out.push('\n');
        }
    }
    let collapsed = regex_lite::Regex::new(r"\n{3,}")
        .map(|re| re.replace_all(&out, "\n\n").into_owned())
        .unwrap_or(out);
    Ok(collapsed.trim().to_string())
}

/// Heuristic: PDF extraction emits resource IDs / font hashes as garbage lines.
fn is_pdf_garbage(line: &str) -> bool {
    if line.len() > 20 && !line.contains(' ') {
        let digits = line.chars().filter(|c| c.is_ascii_digit()).count();
        let uppercase = line.chars().filter(|c| c.is_ascii_uppercase()).count();
        let lowercase = line.chars().filter(|c| c.is_ascii_lowercase()).count();
        let hashy = line
            .chars()
            .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '~'))
            .count();
        if digits >= 4
            && uppercase >= 4
            && lowercase >= 4
            && hashy as f64 / line.len() as f64 > 0.85
        {
            return true;
        }
    }
    line.ends_with("~~") && line.len() > 10
}

fn clean_pdf_line(line: &str) -> String {
    let mut result = String::new();
    for word in line.split_whitespace() {
        if is_pdf_garbage(word) {
            continue;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(word);
    }
    result
}

// ── PPTX → Markdown (ZIP of XML, one section per slide) ─────────────────────

fn convert_pptx(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid PPTX: {e}"))?;

    let mut slides: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                slides.push(name);
            }
        }
    }
    slides.sort_by_key(|name| {
        name.strip_prefix("ppt/slides/slide")
            .and_then(|rest| rest.strip_suffix(".xml"))
            .and_then(|number| number.parse::<u32>().ok())
            .unwrap_or(u32::MAX)
    });

    let mut out = String::new();
    for (idx, slide) in slides.iter().enumerate() {
        let mut xml = String::new();
        archive
            .by_name(slide)
            .map_err(|e| format!("read {slide}: {e}"))?
            .take(MAX_ZIP_ENTRY_BYTES)
            .read_to_string(&mut xml)
            .map_err(|e| format!("read PPTX: {e}"))?;
        let texts = extract_pptx_texts(&xml);
        if !texts.is_empty() {
            out.push_str(&format!("## Slide {}\n\n", idx + 1));
            for text in &texts {
                let t = text.trim();
                if !t.is_empty() {
                    out.push_str(t);
                    out.push_str("\n\n");
                }
            }
        }
    }
    if out.is_empty() {
        return Err("No text content found in this PPTX.".to_string());
    }
    Ok(out.trim().to_string())
}

fn extract_pptx_texts(xml: &str) -> Vec<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match String::from_utf8_lossy(e.local_name().as_ref()).as_ref() {
                    "t" => in_text = true,
                    "p" => current.clear(),
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_text {
                    if let Ok(text) = e.unescape() {
                        current.push_str(&text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                match String::from_utf8_lossy(e.local_name().as_ref()).as_ref() {
                    "t" => in_text = false,
                    "p" => {
                        let t = current.trim().to_string();
                        if !t.is_empty() {
                            paragraphs.push(t);
                        }
                        current.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    paragraphs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn docx_headings_emphasis_lists_tables() {
        // Minimal WordprocessingML: a Heading1, a bold+italic run, a list para,
        // and a one-row table.
        let xml = r#"
        <w:document xmlns:w="x"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
          <w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>strong</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>a | x</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let md = docx_xml_to_markdown(xml).unwrap();
        assert!(md.contains("# Title"), "heading: {md}");
        assert!(md.contains("***strong***"), "bold+italic: {md}");
        assert!(md.contains("- item"), "list: {md}");
        assert!(md.contains("| a \\| x | b |"), "table row: {md}");
        assert!(md.contains("| --- | --- |"), "table divider: {md}");
    }

    #[test]
    fn csv_cells_stay_inside_their_markdown_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("people.csv");
        std::fs::write(
            &path,
            "name,note\nAlice,\"a | b\"\nBob,\"line one\nline two\"\n",
        )
        .unwrap();

        let md = convert_inner(path.to_str().unwrap()).unwrap();
        assert_eq!(
            md,
            "| name | note |\n| --- | --- |\n| Alice | a \\| b |\n| Bob | line one<br>line two |"
        );
    }

    #[test]
    fn pptx_extracts_paragraph_text() {
        let xml = r#"<p:sld xmlns:a="x"><a:p><a:r><a:t>Hello</a:t></a:r>
        <a:r><a:t> world</a:t></a:r></a:p><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>"#;
        let texts = extract_pptx_texts(xml);
        assert_eq!(texts, vec!["Hello world".to_string(), "Second".to_string()]);
    }
    #[test]
    fn pptx_slides_keep_numeric_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);

        for (name, text) in [
            ("ppt/slides/slide10.xml", "Ten"),
            ("ppt/slides/slide2.xml", "Two"),
            ("ppt/slides/slide1.xml", "One"),
        ] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            write!(archive, "<p:sld><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>")
                .unwrap();
        }
        archive.finish().unwrap();

        let md = convert_inner(path.to_str().unwrap()).unwrap();
        let one = md.find("One").unwrap();
        let two = md.find("Two").unwrap();
        let ten = md.find("Ten").unwrap();
        assert!(
            one < two && two < ten,
            "slides must follow slide1, slide2, slide10: {md}"
        );
    }


    #[test]
    fn pdf_garbage_detection() {
        assert!(is_pdf_garbage("30fad226aHZ3dW6bQ9xKmnPqRs"));
        assert!(is_pdf_garbage("someresourceref~~"));
        assert!(!is_pdf_garbage("This is a normal sentence."));
        assert!(!is_pdf_garbage("Supercalifragilisticexpialidocious"));
        assert_eq!(
            clean_pdf_line("Contact alice.longname@example.com today"),
            "Contact alice.longname@example.com today"
        );
    }
}
