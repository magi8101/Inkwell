# Opening (and saving) OneNote notebooks in Inkwell

Research date: 2026-10-22. Scope: `.one` / `.onetoc2` / `.onepkg` → Inkwell import, editing, and writing back.
Sources are linked inline. Statements marked **[verified locally]** were checked against the user's sample
`Unit 4.one` (3.4 MB) or by compiling code. Statements marked **[unverified]** could not be confirmed from a primary source.

## TL;DR

- **Import is solved.** [`onenote_parser`](https://crates.io/crates/onenote_parser) 2.1.0 (Rust, MPL-2.0, released 2026-10-19) reads **both** the desktop revision-store encoding and the OneDrive/FSSHTTP encoding, plus `.onetoc2` and (behind a feature flag) `.onepkg`. It builds for `wasm32-unknown-unknown`, so it runs in iPad Safari and also natively in Tauri. It parsed the user's `Unit 4.one`: 1 page, 1,014 ink strokes, 147,054 points, 2 images **[verified locally]**.
- **Pressure is in the file, but onenote_parser leaves it out.** Every stroke in the sample has X, Y, NormalPressure (0–32767), azimuth and altitude channels. `onenote_parser`'s public `InkStroke` only exposes X/Y. Getting pressure back takes a small patch (about 20 lines) to [`crates/parser/src/onenote/ink.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/onenote/ink.rs), either upstreamed or kept as a fork.
- **Ink is not in Microsoft's specification.** [MS-ONE] documents text, outlines, images, tables and embedded files. It never mentions ink. Every ink JCID and PropertyID used by open-source tools was reverse-engineered.
- **Writing `.one`:** the only open-source writer is [OfficeIMO.OneNote](https://github.com/EvotecIT/OfficeIMO/tree/master/OfficeIMO.OneNote) (.NET, MIT). It claims read/edit/write for desktop and FSSHTTP `.one`, `.onetoc2` and `.onepkg`, including ink. It is .NET, so it is not usable in the browser without Blazor/WASM work. It is also young: it was published in 2026 and is only "partly" validated against OneNote. I also found what looks like a **pressure-GUID byte-order bug** in its source (see §3.2).
- **Recommendation:** (a) import with a WASM build of `onenote_parser`, patched for pressure. (b) Don't round-trip into `.one` yet. Send Inkwell edits back to OneNote through the **Microsoft Graph page-creation API**, with ink as InkML if that write path is confirmed (it is undocumented), or as PDF/PNG. Treat native `.one` writing as an experimental Tauri-only option behind OfficeIMO.

---

## 1. File formats

### 1.1 Two physical encodings of the same revision store

| | Desktop "revision store" | FSSHTTP "alternative packaging" |
|---|---|---|
| Spec | [MS-ONESTORE] §2.1–2.6 ([§2.3 File Structure](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-onestore/a1d17d79-f0aa-45fc-a90f-e70f9df16f34)) | [MS-ONESTORE] [§2.7](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-onestore/189f186c-84ea-4892-afca-633c22bf9389) / [§2.8](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-onestore/c65f7aa8-4f0e-45dc-aabd-96db97cedbd4) + [MS-FSSHTTPB](https://learn.microsoft.com/en-us/openspecs/sharepoint_protocols/ms-fsshttpb/f59fc37d-2232-4b14-baac-25f98e9e7b5a) |
| Where you get it | OneNote 2010–2016/2019/LTSC local notebooks and backups | Files downloaded from OneDrive/SharePoint ("Download notebook") |
| Header | `guidFileType` (.one = `{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}`, .onetoc2 = `{43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}`), then at 0x30 `guidFileFormat` = `{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}` ([MS-ONESTORE PDF v20250520, §2.3.1](https://officeprotocoldocs-f5hpbjgea6b8gneq.b02.azurefd.net/files/MS-ONESTORE/%5bMS-ONESTORE%5d.pdf)) | Same `guidFileType`, but `guidFileFormat` = `{638DE92F-A6D4-4bc1-9A36-B3FC2511A5B7}`, followed by an FSSHTTPB data-element package (§2.8.1) |
| Structure | File node lists → object space manifests → revision manifests → objects with property sets, plus a transaction log and free-chunk list | Storage manifest, cells, revisions, object groups (FSSHTTPB data elements) mapped onto the same object spaces (§2.7) |

§2.8 says the alternative format "is used as the file format for .one and .onetoc2 files stored on a server".
In both encodings the logical model is the same: object spaces containing objects (property sets identified by a **JCID**).
That is why one parser can serve both.

**User's sample** **[verified locally]**: `Unit 4.one` has `guidFileType` `{7B5C52E4-…}` at 0x00 and `guidFileFormat` `{109ADD3F-…}` at 0x30. `ffvLastCodeThatWroteToThisFile` and the other three ffv fields are `0x2A` at 0x40–0x4C, which matches the spec value for desktop `.one` (§2.3.1). It is the **desktop** encoding.

### 1.2 `.onetoc2` and `.onepkg`

- **`.onetoc2`** is a revision-store file of the same kind, holding the notebook table of contents: the section order and the section groups. A notebook is a **directory**: one `.onetoc2`, one `.one` per section, and subdirectories for section groups ([MS-ONE §2.1.15/§2.1.14](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-one/73d22548-a613-4350-8c23-07d15576be50)). The parser resolves sections by name relative to the `.onetoc2`. That lookup was the source of a path-traversal CVE (§3.1).
- **`.onepkg`** ("Export notebook") is a **Microsoft Cabinet (CAB)** archive holding the `.onetoc2` and its `.one` files. Microsoft does not document `.onepkg` itself **[unverified by a Microsoft primary source]**. The CAB claim rests on the `MSCF` magic, on the onenote_parser source ([`onepkg.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/onepkg.rs): "A package is a Microsoft cabinet (CAB) archive that contains a single `.onetoc2` … plus the `.one` section files"), and on OfficeIMO's reader. The CAB container format is specified in [MS-CAB] (listed in [Microsoft's Exchange Server archive](https://learn.microsoft.com/en-us/openspecs/archive/ms-oxarchlp/f56b904d-9048-455d-bcc9-279a9df64f60)). Folders may be stored uncompressed or compressed with MSZIP or LZX.

### 1.3 How a page is structured ([MS-ONE](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-one/73d22548-a613-4350-8c23-07d15576be50), v3.4 / 2022-11-15)

- A section file contains a **SectionObjectSpace** (§2.1.14). Each page is its own **PageObjectSpace** (§2.1.10), whose content root is a `jcidPageManifestNode` (0x00060037). That node has exactly one child, a `jcidPageNode` (0x0006000B) (§2.2.34, §2.2.47). The metadata root is `jcidPageMetaData`.
- `jcidPageNode` carries `PageWidth`/`PageHeight` "in half-inch increments" (§2.3.6/2.3.7) and margins. Its direct children (`ElementChildNodesOfPage`, §2.2.49) are positioned **outlines** (text containers), **images**, **embedded files** and a title.
- Positions: `OffsetFromParentHoriz`/`Vert` are floats "in half-inch increments, of content from the page origin" ([§2.3.18](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-one/5fb9e84a-c9e9-4537-ab14-e5512f24669a), [§2.3.19](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-one/5c4992ba-1db5-43e9-83dd-7299c562104d)). One half-inch is **48 CSS px**.
- **Rich text:** `jcidOutlineNode` → `jcidOutlineElementNode` → `jcidRichTextOENode` (0x0006000E). The text is in `RichEditTextUnicode` (§2.2.5, UTF-16) or `TextExtendedAscii`. Formatting comes from text-run indices plus `jcidParagraphStyleObject` (font, size, bold, italic, colour, highlight; §2.2.43–2.2.44). Width comes from `LayoutMaxWidth` (§2.3.21).
- **Images:** `jcidImageNode` (§2.2.24) has a `PictureContainer` property pointing to a `jcidPictureContainer14` (0x00080039, §2.2.36). That object is a file-data object (`ObjectDeclarationFileData3RefCountFND`, [MS-ONESTORE §2.5.27](https://officeprotocoldocs-f5hpbjgea6b8gneq.b02.azurefd.net/files/MS-ONESTORE/%5bMS-ONESTORE%5d.pdf)) referencing the bytes: DIB, EMF, JPEG, PNG, etc. Size comes from `PictureWidth`/`PictureHeight` and `LayoutMaxWidth`/`Height`. Embedded files work the same way through `jcidEmbeddedFileContainer`.
- **Unknown data rule:** "If a structure is read and it does not have a PropertyID value that is listed in this table, the structure MUST be ignored and MUST be rewritten to the file as it was read" (MS-ONE §2.1.12). Unknown children of a page SHOULD likewise be "written to the file as it was read" (§2.2.49). Any writer therefore has to preserve every object it doesn't understand, and ink is one of those objects (next section).

## 2. How ink is stored

> **[MS-ONE] does not specify ink.** The PDF (v20221115) has no ink JCIDs or ink properties. A text search for "ink" only hits "hyperlink" and "pink". The onenote_parser README says it reads ink "in addition to the publicly documented contents". Everything below is reverse-engineered. It agrees across onenote_parser, Joplin's fork and OfficeIMO, and I checked it against the sample file.

### 2.1 Object graph

| Object | JCID | Key properties (PropertyID) |
|---|---|---|
| `InkContainer` (a page child, or nested) | `0x00060014` | `InkData` 0x20003415 → InkDataNode; or `ContentChildNodes` (nested groups); `InkScalingX` 0x14001C46 / `InkScalingY` 0x14001C47 (float); `OffsetFromParentHoriz/Vert` 0x14001C14/15 (half-inches) |
| `InkDataNode` | `0x0002003B` | `InkStrokes` 0x24003416 → [InkStrokeNode…]; `InkBoundingBox` 0x1C003418 (4×i32: xmin, ymin, xmax, ymax) |
| `InkStrokeNode` | `0x00020047` | `InkPath` 0x1C00340B (packet data, multi-byte signed ints); `InkStrokeProperties` 0x20003409 → StrokePropertiesNode; `InkBias` 0x0C00341C (0 handwriting, 1 drawing, 2 both); `LanguageId` |
| `StrokePropertiesNode` (shared between strokes) | `0x00120048` | `InkDimensions` 0x1C00340A; `InkColor` 0x1400340F (u32); `InkWidth` 0x1400340D / `InkHeight` 0x1400340C (f32, pen-tip size); `InkTransparency` 0x0C003414 (u8); `InkPenTip` 0x0C003412 (0 = ellipse/round, else rectangle); `InkRasterOperation` 0x0C003413; `InkIgnorePressure` 0x08003411; `InkFitToCurve` 0x80003410; `InkAntialised` 0x8000340E |
| Ink inside a text paragraph | `EmbeddedInkContainer` + `EmbeddedInkStartX/Y`, `…Width/Height`, `…OffsetHoriz/Vert` (0x1400349E–A3) | Handwriting flowed inline with typed text |
| Handwriting recognition | `RecognizedTextRoot/Line/Block/Word` 0x00020054–57 | OCR words that point at stroke IDs |

Sources: [`one/property/mod.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/one/property/mod.rs), [`one/property_set/mod.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/one/property_set/mod.rs), [`ink_container.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/one/property_set/ink_container.rs), [`stroke_properties_node.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/one/property_set/stroke_properties_node.rs). OfficeIMO's [`OneNoteWriteGraphBuilder.Ink.cs`](https://github.com/EvotecIT/OfficeIMO/blob/master/OfficeIMO.OneNote/Internal/Writing/OneNoteWriteGraphBuilder.Ink.cs) writes the same set.

### 2.2 Packet data (`InkPath` + `InkDimensions`)

- `InkDimensions` is an array of 32-byte records: `GUID (16) | logicalMin i32 | logicalMax i32 | unit u32 | resolution f32`. These are the Tablet PC [`PROPERTY_METRICS`](https://learn.microsoft.com/en-us/windows/desktop/api/tpcshrd/ns-tpcshrd-property_metrics) fields, keyed by ISF packet-property GUIDs. The GUIDs come from WPF's ISF table in [`ISFTagAndGuidCache.cs`](https://github.com/dotnet/wpf/blob/main/src/Microsoft.DotNet.Wpf/src/PresentationCore/MS/internal/Ink/InkSerializedFormat/ISFTagAndGuidCache.cs): X `598A6A8F-…`, Y `B53F9F75-…`, **NormalPressure `7307502D-F9F4-4E18-B3F2-2CE1B1A3610C`**, AzimuthOrientation `029123B4-…`, AltitudeOrientation `82DEC5C7-…`.
- `InkPath` is a **dimension-major** vector: all X values, then all Y values, then all pressure values, and so on. Each dimension stores an absolute first value followed by **first-order deltas** ([onenote_parser `ink.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/onenote/ink.rs); [OfficeIMO `OneNoteInkCodec.cs`](https://github.com/EvotecIT/OfficeIMO/blob/master/OfficeIMO.OneNote/Internal/Semantic/OneNoteInkCodec.cs): "Each InkPath dimension starts with an absolute packet followed by signed deltas").

**Sample file, from the raw bytes [verified locally]:**

| Dimension | min..max | unit ([TabletPropertyMetricUnit](https://learn.microsoft.com/en-us/windows/win32/api/msinkaut/ne-msinkaut-tabletpropertymetricunit)) | resolution | Meaning |
|---|---|---|---|---|
| X, Y | ±2³¹ | 2 = centimetres | 1000 | **1 unit = 1/1000 cm = 0.01 mm (HIMETRIC)** |
| NormalPressure | 0..32767 | 0 = default | 0 | Pressure; divide by 32767 for 0..1 |
| Azimuth, Altitude | ±3142 | 4 = radians | 1000 | Pen tilt in milliradians |

Decoding the first stroke with first-order deltas gives X 3300–3856, Y 3759–4758 and pressure 11599–25243. All stay inside the declared limits. Second-order decoding overflows the limits, which confirms first-order deltas. The stroke style was colour `13355979` = `0xCBCBCB`, width = height = 50 units (0.5 mm), `ignore_pressure = false`.

### 2.3 Units and attributes → CSS px (96 dpi, which is Inkwell's world px; see `PT_PER_PX` in `src/export.ts`)

| OneNote value | Conversion to Inkwell world px |
|---|---|
| Ink X/Y (HIMETRIC, after `InkScalingX/Y`) | `px = v × 96 / 2540` (≈ 0.0378). Joplin uses the same constant: `SVG_SCALING_FACTOR = 2540/96` ([renderer `ink.rs`](https://github.com/laurent22/joplin/blob/dev/packages/onenote-converter/renderer/src/page/ink.rs)) |
| Container/outline/image offsets, page size (half-inch) | `px = v × 48` |
| `InkWidth`/`InkHeight` (pen tip, HIMETRIC) | `px = v × 96 / 2540`. **Note:** onenote_parser swaps them internally: it reads `InkHeight` into `ink_width` and vice versa ([`stroke_properties_node.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/one/property_set/stroke_properties_node.rs)). This doesn't matter for round tips, where width = height. |
| `InkColor` u32 | COLORREF `0x00BBGGRR`: `r = c & 0xFF, g = (c >> 8) & 0xFF, b = (c >> 16) & 0xFF` (Joplin and OfficeIMO agree) |
| `InkTransparency` u8 | `opacity = 1 − t/255`, so 0 = opaque (Joplin, OfficeIMO, and the 2017 InkML API blog: "0 is opaque"). onenote_parser's doc comment says the opposite, and that comment is wrong. |
| Pressure | `raw / 32767` → 0..1. Ignore it if `InkIgnorePressure` is set. |
| Highlighter | Likely transparency combined with `InkRasterOperation` (mask-pen). **[unverified]**: I had no highlighter sample. |

## 3. Existing libraries

| Library | Language / licence | Read | Write | Desktop | FSSHTTP | `.onetoc2` / `.onepkg` | Ink fidelity | Maintenance | Advisories |
|---|---|---|---|---|---|---|---|---|---|
| **[onenote_parser](https://github.com/msiemens/onenote.rs)** (crate `onenote_parser` 2.1.0) | Rust, **MPL-2.0** | ✅ | ❌ (README "Non-Goals: The ability to write OneNote files") | ✅ since 2.0.0 (2026-08-06, [CHANGELOG](https://github.com/msiemens/onenote.rs/blob/master/CHANGELOG.md)) | ✅ | ✅ / ✅ (`onepkg` feature, uses the `cab` crate) | Points (X/Y, delta + `absolute_path()`), colour, width/height, transparency, pen tip, nested groups, offsets, OCR words. **Pressure and tilt are parsed but not exposed.** | Active. Single maintainer, Markus Siemens (sole crates.io owner, 240 of ~253 commits). Last push 2026-10-19. | [GHSA-4j5m-wc25-pvh7 / CVE-2026-46671](https://github.com/msiemens/onenote.rs/security/advisories/GHSA-4j5m-wc25-pvh7): path traversal through a crafted `.onetoc2`, fixed in 1.1.1. 2.0.0 also fixed a crafted-file ~192 GB pre-allocation DoS. |
| [one2html](https://github.com/msiemens/one2html) | Rust, MIT | ✅ (via onenote_parser 2.x) | ❌ | ✅ | ✅ | ✅ | Renders ink to SVG paths (no pressure) | Active (2026-10-19) | Inherits the parser's |
| [Joplin `onenote-converter`](https://github.com/laurent22/joplin/tree/dev/packages/onenote-converter) | Rust→WASM, MPL-2.0 (package LICENSE) | ✅ | ❌ | ✅ (`local_onestore`) | ✅ | via ZIP of the backup | SVG, uniform width, colour, opacity | Active, but a fork of an older onenote.rs | Wasm panics reported by users on the [forum](https://discourse.joplinapp.org/t/onenote-zip-file-import-not-working/47499) |
| **[OfficeIMO.OneNote](https://github.com/EvotecIT/OfficeIMO/tree/master/OfficeIMO.OneNote)** ([NuGet](https://www.nuget.org/packages/OfficeIMO.OneNote) 3.5.1, 2026-10-16) | .NET (netstandard2.0, net8, net10), **MIT** | ✅ | ✅ ("Read, edit, and save a section") | ✅ | ✅ | ✅ / ✅ (CAB: reads stored/MSZIP/LZX, writes uncompressed) | Read: X/Y/pressure, colour, width/height, opacity, tip, scaling, recognition. Write: same. **Suspected bug, see §3.2.** | Very active (pushed 2026-10-22), but new: v3.0.0 appeared in 2026 | None found. The README claims bounded CAB expansion and checksum validation. |
| [Apache Tika `OneNoteParser`](https://github.com/apache/tika/tree/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/main/java/org/apache/tika/parser/microsoft/onenote) | Java, Apache-2.0 | Text and metadata only | ❌ | ✅ | ✅ (`fsshttpb/`) | — | **No ink** (no ink classes in the source tree) | Active | [CVE-2020-9489](https://www.cve.org/CVERecord?id=CVE-2020-9489): a crafted OneNote file could trigger `System.exit`/OOM/infinite loop. Fixed in 1.24.1. |
| [pyOneNote](https://github.com/DissectMalware/pyOneNote) | Python, Apache-2.0 | Embedded files and metadata (malware triage) | ❌ | ✅ | ❌ | — | No ink | Last push 2024-07 | — |
| [libmson](https://github.com/blu-base/libmson) | C++/Qt, LGPL-2.1 | Partial | Partial (WIP) | ✅ | ❌ | — | Unknown | Dormant since 2021 | — |
| [`@mdgate/onenote`](https://www.npmjs.com/package/@mdgate/onenote) | TS, MIT | "best-effort text extraction" | ❌ | heuristic | heuristic | treats `.onepkg` as ZIP (it is CAB) | "does not reconstruct OneNote ink" | — | — |
| [libmspack](https://www.cabextract.org.uk/libmspack/) / [cabextract](https://www.cabextract.org.uk/) | C, LGPL-2 / GPL | CAB only (for `.onepkg`) | — | — | — | CAB | — | Maintained | Has a CVE history. Not needed: the Rust [`cab`](https://crates.io/crates/cab) crate (MIT, pure Rust) already covers it. |

I found no maintained pure JS/TS library that extracts OneNote ink. Commercial: Aspose.Note can read and write `.one` **[not evaluated, proprietary]**.

### 3.1 onenote_parser details that matter for Inkwell

- **API:** `Parser::new_with_fs(fs)` plus `parse_section_buffer(&[u8], name)` for a single `.one` held in memory. `parse_notebook` and `parse_package` go through the pluggable [`FileSystem` trait](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/fs/mod.rs), so a browser implementation can be a `HashMap<path, Vec<u8>>` filled from `<input type=file webkitdirectory>` or a dropped folder. Section → `page_series()` → `pages()` → `contents()` gives `PageContent::{Outline, Image, EmbeddedFile, Ink}`.
- **Pressure gap:** `parse_ink_path` locates the X and Y dimension indices and drops the rest ([`ink.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/onenote/ink.rs)). The fix is to also look up NormalPressure `7307502D-…`, slice its range the same way, prefix-sum it, and expose `InkStroke::pressure() -> Option<Vec<f32>>`. Also expose `ignore_pressure`. This fits the "bugfixes and compatibility" policy, so offer it upstream. Until then, a vendored fork under MPL-2.0 is fine: the modified files stay MPL, and Inkwell's own code is unaffected.
- **`.onepkg` bomb risk:** [`onepkg.rs`](https://github.com/msiemens/onenote.rs/blob/master/crates/parser/src/onepkg.rs) calls `read_to_end` on every CAB entry with no size cap. In a browser tab, cap the input size and run the parse in a Web Worker.

### 3.2 OfficeIMO.OneNote: notes from reading the source (not executed)

- [Current-state doc](https://github.com/EvotecIT/OfficeIMO/blob/master/Docs/officeimo.onenote.current-state.md): read-edit-write is supported for desktop `.one`, FSSHTTP `.one`, `.onetoc2` and `.onepkg`. Unknown objects are preserved opaquely. Validation in OneNote is only partial: "Manual desktop validation used Microsoft OneNote as an interoperability check" for rich text, tags, conflict pages and version history. **Ink round-trip in OneNote is not listed as validated.** Encrypted (password-protected) sections are refused.
- **Likely bug:** [`OneNoteInkCodec.cs`](https://github.com/EvotecIT/OfficeIMO/blob/master/OfficeIMO.OneNote/Internal/Semantic/OneNoteInkCodec.cs) declares `PressureDimension = new Guid("2d500773-f4f9-4e18-b3f2-2ce1b1a3610c")`. The real ISF NormalPressure GUID is `7307502d-f9f4-4e18-…` (WPF source above; and `7307502D-…` is what is stored in the sample). The first two groups are byte-swapped. Dimension GUIDs are decoded with `new Guid(byte[])`, which is little-endian, and the X/Y constants match that way. So I expect OfficeIMO to **miss pressure when reading real OneNote ink**. I also expect it to **write a pressure dimension OneNote won't recognise**. This comes from reading the source and was not run. Worth reporting upstream before relying on it.

## 4. Browser / WASM feasibility

- `onenote_parser` 2.1.0 with `default-features = false, features = ["onepkg"]` **compiles for `wasm32-unknown-unknown`** (rustc 1.94, 15 s) **[verified locally]**. Upstream CI builds the same target ([`ci.yml`](https://github.com/msiemens/onenote.rs/blob/master/.github/workflows/ci.yml): "cargo build (wasm32, no default features, lib only)").
- Dependencies are pure Rust (`bytes, encoding_rs, itertools, log, lru, uuid, time, widestring, typed-path, sanitize-filename, thiserror`, optional `cab` → `flate2`/`lzxd`). There is no threading. `std::fs` appears only in `fs/native_fs.rs`, which is gated behind the `native-fs` feature (a grep of the crate source shows nothing else). The crate already declares `crate-type = ["cdylib","lib"]`.
- What remains to build: a small `wasm-bindgen` wrapper crate that takes bytes and returns a JSON or flat-array model (see §6), plus an in-memory `FileSystem` impl. **Bundle size was not measured.**
- Tauri: the same crate runs natively with the `native-fs` feature as a Tauri command. That is useful for very large notebooks, but the WASM path already covers desktop, so one code path is enough.
- Prior art: Joplin ships exactly this setup, onenote.rs compiled to WASM inside its importer ([README](https://github.com/laurent22/joplin/blob/dev/packages/onenote-converter/README.md)).

## 5. Writing back

| Option | What OneNote gets | Ink fidelity | Risk |
|---|---|---|---|
| **A. Native `.one` writer (OfficeIMO.OneNote)** | A real section with editable ink | High in theory: X/Y/pressure, colour, width | .NET only, so it can't run in the browser (Blazor WASM is possible but heavy). The writer is new and partly validated, and ink is not validated in OneNote. There is the suspected pressure-GUID bug. Writes outside the spec's documented surface. Risk of OneNote rejecting or "repairing" files, or silent data loss in the user's notebook. Always write a **new** section and never overwrite the original. |
| **B. Write our own `.one` writer in Rust** | Same | Same | Very large job: transaction log, CRCs, file-node lists, global ID tables and revision manifests, plus the undocumented ink objects and the "rewrite unknown structures as read" rule (MS-ONE §2.1.12). Not recommended. |
| **C. Microsoft Graph OneNote API** (`POST /me/onenote/sections/{id}/pages`, [create pages](https://learn.microsoft.com/en-us/graph/onenote-create-page)) | A new page in the user's cloud notebook. HTML with absolutely positioned `div`s/`img`s ([abs-pos](https://learn.microsoft.com/en-us/graph/onenote-abs-pos)) and images as multipart parts | **Text and images: documented.** **Ink:** reading through `GET …/pages/{id}/content?includeInkML=true` is undocumented on Learn, but open-source importers call it on Graph v1.0 ([Obsidian importer](https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/onenote.ts), [Trilium](https://github.com/TriliumNext/Trilium/blob/main/apps/server/src/services/import/onenote/graph.ts)). **Writing ink** (a multipart part `application/inkml+xml`, name `presentation-onenote-inkml`, HIMETRIC integer coordinates, a pressure channel "F", brush colour/width/transparency) appears only in the [2017 beta blog](https://devblogs.microsoft.com/microsoft365dev/onenote-ink-beta-apis/) against `onenote.com/api/beta`. **Current Graph docs do not document ink writing [unverified whether it still works]**. | Needs a Microsoft account, an Entra app registration, delegated `Notes.ReadWrite` (OAuth PKCE works on iPad) and a network. Pages are new, not in-place edits. Updates use PATCH on HTML elements ([update page](https://learn.microsoft.com/en-us/graph/onenote-update-page)), which can't address ink. Learn notes that the API is unsuitable for notebook backup/restore ([get content](https://learn.microsoft.com/en-us/graph/onenote-get-content)). |
| **D. Export PDF/PNG and import into OneNote** | A "File Printout": one image per PDF page ([Microsoft support](https://support.microsoft.com/en-us/oneNote/onenote-for-mac-help-and-learning/insert-pdf-printouts-into-notes-in-onenote-for-mac)) | Visual only, not editable ink | Zero format risk. **Inkwell already exports PDF/PNG** (`src/export.ts`). |

## 6. Recommendation

### (a) Import (web, iPad, desktop): `onenote_parser` → WASM, one code path

1. Add a tiny Rust crate `onenote-wasm` (wasm-bindgen) that depends on `onenote_parser = { version = "2.1", default-features = false, features = ["onepkg"] }`. Use a vendored patch to expose pressure (§3.1) and upstream it.
2. Inputs: a single `.one` (via `parse_section_buffer`); a `.onepkg` (`parse_package` over an in-memory FS); or a notebook folder (`.onetoc2` plus `.one` files from a directory picker, desktop only, since iPad Safari has no directory picker). Run the parse in a Web Worker and cap the input size.
3. Output: a flat model. For each page: title, size; for each stroke: colour, width, opacity, ignorePressure, `Float32Array` of x/y/p; text boxes; and image bytes, which go straight into Inkwell's IndexedDB `blobs`.
4. Mapping to `src/store.ts`:

```ts
const HIMETRIC_TO_PX = 96 / 2540;  // ink coords + pen size
const HALF_INCH_TO_PX = 48;        // offsets, page size, outline/image boxes
// For each Ink container (recursively): ox/oy = offset_* × 48 (only for non-embedded ink).
// For each stroke: abs = stroke.absolute_path() (already × InkScalingX/Y)
points.push(ox + x * HIMETRIC_TO_PX, oy + y * HIMETRIC_TO_PX,
            ignorePressure || !p ? 0.5 : p[i] / 32767);
stroke = {
  tool: opacity < 1 /* or rasterOp = mask */ ? 'highlighter' : 'pen',
  color: rgbFromColorref(color ?? 0),         // 0x00BBGGRR
  opacity: 1 - (transparency ?? 0) / 255,
  width: (inkWidth * HIMETRIC_TO_PX) / 2,     // see note below
  pressure: hasPressure && !ignorePressure,
};
```

   Inkwell draws a diameter of `2 × width × t` with `t = 0.5` at mid pressure (`tipDiameter` in `src/stroke.ts`). So `width = tipPx / 2` is a reasonable first guess. Calibrate it visually against OneNote using `Unit 4.one` (keep it tunable). The sample's ink is page-level with offset (0, 0), so its coordinates map directly into page space.
5. Text: outlines become `TextBox` at `(offset × 48)` with `w = LayoutMaxWidth × 48`. Flatten paragraphs and lists to plain text with bold/italic from the first run. Tables, tags and math are lossy: flatten them to text. Inline handwriting (`EmbeddedInkContainer`) needs text-layout positions, so place it approximately below the outline.
6. **Expected fidelity:** stroke geometry exact; pressure exact after the patch; colour, width and opacity good; highlighter mapping heuristic; text position good but formatting approximate; images exact (bytes copied); password-protected sections unsupported.

### (b) Round-trip editing

- **Now:** treat `.one` as **import-only**. To get Inkwell work back into OneNote, use either:
  1. **Graph sync (online):** create a new page per Inkwell page, with text as positioned HTML and images as parts. Add ink as an InkML part (HIMETRIC = `px × 2540/96`, pressure channel `F` = `p × 32767`, colour `#RRGGBB`, transparency `round((1−opacity)×255)`) *if a spike confirms Graph still accepts it*. Otherwise fall back to a PNG/SVG rendering of the strokes on that page.
  2. **Offline:** the existing PDF export, then OneNote "Insert → PDF printout".
- **Later, experimental, desktop only:** a Tauri sidecar using OfficeIMO.OneNote to write a **new** `.one` section. Never overwrite the user's original. Gate it on (i) fixing or confirming the pressure GUID, (ii) manually validating ink round-trip in OneNote for Windows and Mac, and (iii) reading the result back with onenote_parser as a check. Native `.one` editing in place is not worth the corruption risk for a notes app.

## Unverified / open items

- Whether Graph v1.0 still accepts InkML on page creation. Needs a 30-minute spike with a test account.
- Highlighter encoding (raster op vs transparency) and pen-tip semantics. Needs a sample containing highlighter strokes.
- OfficeIMO's pressure-GUID bug: based on source reading only, not executed.
- WASM bundle size of the parser.
- No Microsoft primary document describes `.onepkg`. That it is a CAB is established by the file magic and by implementations.

## Method note

The sample's header and ink-dimension records were read with a short read-only Python script. Earlier in the session, before a later instruction not to execute third-party packages, `onenote_parser` 2.1.0 (from crates.io) was also compiled to wasm32 and run natively, reading (not writing) `Unit 4.one` in place, to collect the page and stroke statistics above. The user's file was not modified, and nothing was added to the project except this document.
