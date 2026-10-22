//! Inkwell's OneNote importer: parses a `.one` section (desktop or OneDrive encoding) with
//! `onenote_parser` and returns its pages as JSON in Inkwell's units (CSS px at 96 dpi).
//!
//! Exposed as a tiny C ABI so the browser can call it without any binding generator:
//! `alloc(len)` → copy the file in → `parse_section(ptr, len)` → read `[u32 len LE][JSON]` at the
//! returned pointer → `dealloc` both buffers.

use std::io::{Error, Read};

use base64::Engine;
use onenote_parser::contents::{Content, Image, Ink, OutlineItem, RichText};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::property::common::ColorRef;
use onenote_parser::{FileSystem, Parser};
use serde_json::{Value, json};
use typed_path::{TypedPath, TypedPathBuf};

/// [MS-ONE] layout positions and sizes are in half-inch increments.
const HALF_INCH_PX: f32 = 48.0;
/// Ink coordinates and pen sizes are HIMETRIC (0.01 mm).
const HIMETRIC_PX: f32 = 96.0 / 2540.0;

/// Parsing a single section from memory never touches a file system.
#[derive(Clone, Copy)]
struct NoFs;

fn no_fs() -> Error {
    Error::other("no file system in the importer")
}

impl FileSystem for NoFs {
    fn is_directory(&self, _: TypedPath) -> Result<bool, Error> {
        Err(no_fs())
    }
    fn read_dir(&self, _: TypedPath) -> Result<Vec<TypedPathBuf>, Error> {
        Err(no_fs())
    }
    fn read_file(&self, _: TypedPath) -> Result<Vec<u8>, Error> {
        Err(no_fs())
    }
    fn write_file(&self, _: TypedPath, _: &[u8]) -> Result<(), Error> {
        Err(no_fs())
    }
    fn stream_to_file(&self, _: TypedPath, _: &mut dyn Read) -> Result<(), Error> {
        Err(no_fs())
    }
    fn make_dir(&self, _: TypedPath) -> Result<(), Error> {
        Err(no_fs())
    }
    fn canonicalize(&self, _: TypedPath) -> Result<TypedPathBuf, Error> {
        Err(no_fs())
    }
    fn exists(&self, _: TypedPath) -> Result<bool, Error> {
        Err(no_fs())
    }
}

fn hex(c: Option<&ColorRef>) -> Option<String> {
    match c? {
        ColorRef::Manual { r, g, b } => Some(format!("#{r:02x}{g:02x}{b:02x}")),
        ColorRef::Auto => None,
    }
}

/// OneNote stores ink colour as `0x00BBGGRR`.
fn ink_hex(c: u32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        c & 0xff,
        (c >> 8) & 0xff,
        (c >> 16) & 0xff
    )
}

/// Flattens an ink group (and nested groups) into strokes, offset to page coordinates.
fn ink(group: &Ink, ox: f32, oy: f32, out: &mut Vec<Value>) {
    let ox = ox + group.offset_horizontal().unwrap_or(0.0) * HALF_INCH_PX;
    let oy = oy + group.offset_vertical().unwrap_or(0.0) * HALF_INCH_PX;
    for s in group.ink_strokes() {
        let path = s.absolute_path();
        if path.is_empty() {
            continue;
        }
        let pressure = s
            .pressure()
            .filter(|p| p.len() == path.len() && !s.ignore_pressure());
        let mut points = Vec::with_capacity(path.len() * 3);
        for (i, p) in path.iter().enumerate() {
            points.push(json!(p.x() * HIMETRIC_PX + ox));
            points.push(json!(p.y() * HIMETRIC_PX + oy));
            points.push(json!(pressure.map_or(0.5, |pr| pr[i])));
        }
        out.push(json!({
            "color": s.color().map_or_else(|| "#000000".to_owned(), ink_hex),
            // 0 means opaque (onenote_parser's own doc comment has this backwards).
            "opacity": 1.0 - f32::from(s.transparency().unwrap_or(0)) / 255.0,
            "width": s.width().max(s.height()) * HIMETRIC_PX,
            "pressure": pressure.is_some(),
            "points": points,
        }));
    }
    for child in group.child_groups() {
        ink(child, ox, oy, out);
    }
}

fn image(img: &Image, ox: f32, oy: f32) -> Option<Value> {
    let mut bytes = Vec::new();
    img.read()?.read_to_end(&mut bytes).ok()?;
    let w = img
        .layout_max_width()
        .or(img.picture_width())
        .unwrap_or(4.0)
        * HALF_INCH_PX;
    let h = img
        .layout_max_height()
        .or(img.picture_height())
        .unwrap_or(3.0)
        * HALF_INCH_PX;
    let x = ox + img.offset_horizontal().unwrap_or(0.0) * HALF_INCH_PX;
    let y = oy + img.offset_vertical().unwrap_or(0.0) * HALF_INCH_PX;
    Some(json!({
        "ext": img.extension().unwrap_or("png").trim_start_matches('.'),
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "background": img.is_background(),
        "x": x, "y": y, "w": w, "h": h,
    }))
}

struct Outline {
    lines: Vec<String>,
    style: Option<Value>,
}

/// Collects an outline's text (one line per paragraph), plus its images and ink.
fn outline_items(
    items: &[OutlineItem],
    o: &mut Outline,
    at: (f32, f32),
    strokes: &mut Vec<Value>,
    images: &mut Vec<Value>,
) {
    for item in items {
        match item {
            OutlineItem::Group(g) => outline_items(g.outlines(), o, at, strokes, images),
            OutlineItem::Element(el) => {
                for c in el.contents() {
                    match c {
                        Content::RichText(rt) => text_line(rt, o),
                        Content::Image(img) => images.extend(image(img, at.0, at.1)),
                        Content::Ink(group) => ink(group, at.0, at.1, strokes),
                        _ => {}
                    }
                }
                outline_items(el.children(), o, at, strokes, images);
            }
        }
    }
}

fn text_line(rt: &RichText, o: &mut Outline) {
    o.lines.push(rt.text().to_owned());
    if o.style.is_none() && !rt.text().trim().is_empty() {
        let st = rt.paragraph_style();
        // Font sizes are stored in half-points.
        let size_px = st
            .font_size()
            .map_or(14.7, |half_pt| f32::from(half_pt) / 2.0 * 96.0 / 72.0);
        o.style = Some(json!({
            "font": st.font(),
            "size": size_px,
            "bold": st.bold(),
            "italic": st.italic(),
            "color": hex(st.font_color().as_ref()),
        }));
    }
}

fn page(p: &Page) -> Value {
    let mut strokes = Vec::new();
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for content in p.contents() {
        match content {
            PageContent::Ink(group) => ink(group, 0.0, 0.0, &mut strokes),
            PageContent::Image(img) => images.extend(image(img, 0.0, 0.0)),
            PageContent::Outline(outline) => {
                let x = outline.offset_horizontal().unwrap_or(0.0) * HALF_INCH_PX;
                let y = outline.offset_vertical().unwrap_or(0.0) * HALF_INCH_PX;
                let mut o = Outline {
                    lines: Vec::new(),
                    style: None,
                };
                outline_items(outline.items(), &mut o, (x, y), &mut strokes, &mut images);
                let text = o.lines.join("\n");
                if !text.trim().is_empty() {
                    texts.push(json!({
                        "x": x, "y": y,
                        "w": outline.layout_max_width().map_or(400.0, |w| w * HALF_INCH_PX),
                        "text": text,
                        "style": o.style,
                    }));
                }
            }
            _ => {}
        }
    }
    json!({
        "title": p.title_text().unwrap_or("Untitled page"),
        "strokes": strokes,
        "texts": texts,
        "images": images,
    })
}

fn parse(bytes: &[u8]) -> Value {
    match Parser::new_with_fs(NoFs).parse_section_buffer(bytes, TypedPath::derive("section.one")) {
        Ok(section) => {
            let pages: Vec<Value> = section
                .page_series()
                .iter()
                .flat_map(|s| s.pages().iter().map(page))
                .collect();
            json!({ "ok": true, "name": section.display_name(), "pages": pages })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Allocates `len` bytes for the caller to fill (the `.one` file).
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees a buffer returned by `alloc` or `parse_section`.
///
/// # Safety
/// `ptr` must come from `alloc(cap)` or `parse_section` (whose buffer capacity is `4 + json len`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, cap: usize) {
    // SAFETY: the caller passes a pointer and capacity this module allocated.
    unsafe { drop(Vec::from_raw_parts(ptr, 0, cap)) };
}

/// Parses a `.one` file and returns a buffer `[u32 length, little-endian][UTF-8 JSON]`.
///
/// # Safety
/// `ptr..ptr+len` must be a buffer obtained from `alloc(len)` and fully written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_section(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: the caller guarantees the buffer is initialised and `len` long.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json = parse(bytes).to_string().into_bytes();
    let n = u32::try_from(json.len()).unwrap_or(u32::MAX);
    let mut out = Vec::with_capacity(4 + json.len());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&json);
    let ptr = out.as_mut_ptr();
    std::mem::forget(out);
    ptr
}

#[cfg(test)]
mod tests {
    #[test]
    fn colours_are_bgr() {
        assert_eq!(super::ink_hex(0x00CC_BB_AA), "#aabbcc");
    }

    /// Parses the sample notebook section when it's present (it isn't committed).
    #[test]
    fn parses_sample_if_present() {
        let Ok(bytes) = std::fs::read("../Unit 4.one") else {
            return;
        };
        let v = super::parse(&bytes);
        assert_eq!(v["ok"], true, "{v}");
        let pages = v["pages"].as_array().unwrap();
        let strokes: usize = pages
            .iter()
            .map(|p| p["strokes"].as_array().unwrap().len())
            .sum();
        let images: usize = pages
            .iter()
            .map(|p| p["images"].as_array().unwrap().len())
            .sum();
        let with_pressure = pages
            .iter()
            .flat_map(|p| p["strokes"].as_array().unwrap())
            .filter(|s| s["pressure"] == true)
            .count();
        println!(
            "pages {} strokes {strokes} (pressure {with_pressure}) images {images}",
            pages.len()
        );
        let first = &pages[0]["strokes"][0];
        println!(
            "first stroke: colour {} width {} opacity {} points {}",
            first["color"],
            first["width"],
            first["opacity"],
            first["points"].as_array().unwrap().len() / 3
        );
        println!(
            "first points: {:?}",
            &first["points"].as_array().unwrap()[..9]
        );
        assert!(strokes > 0 && with_pressure > 0);
    }
}
