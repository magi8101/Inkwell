# `.inkw`: one portable Inkwell file that any OS can read

Status: plan v2, nothing built. Written 2026-10-25. Replaces plan v1 (a custom chunked binary
container), which research showed was the wrong layer to invent: see "What changed".

## Goal

A page, a section or a whole notebook as **one file** a person can double-click, send, keep, and
open on any OS, and that other programs can read **without Inkwell**, from a written spec, with
tools that already exist on every system. Not goals for v1: live collaboration, editing the file in
place from other tools, replacing notebook folders (they keep working).

## What changed since v1, and why

v1 invented a PNG-style chunk container with its own index, CRCs, offsets and appending. Research
found that this is exactly what ZIP and SQLite already give, with readers on every OS and in every
language. Writing three readers (TypeScript, Rust, Python) for a new container is the largest part
of that plan and buys nothing. v2 uses an existing container and invents only what is
Inkwell-specific: the **schema** and the **stroke codec**.

## Research findings (sources at the end; confidence stated)

| Finding | Source | Confidence |
|---|---|---|
| Wacom's Universal Ink Model is a **RIFF container with Protocol Buffers**; strokes are Catmull-Rom control points; an open-source pure-Python reader/writer exists (versions 3.0.0 and 3.1.0) | Wacom developer docs, PyPI | Structure confirmed; byte layout not read |
| Xournal++ `.xopp` is **gzipped XML**; PDFs are *not* embedded, so deleting the PDF loses the background; a new format that stores attachments internally is being introduced | Xournal++ README mirrors | Confirmed for `.xopp`; no formal spec found |
| Rnote stores **gzipped JSON** | a third-party page | Secondary source; check Rnote's repository |
| Microsoft ISF: most compact ink representation, extensible with GUID-keyed attributes | Microsoft docs | Confirmed |
| W3C InkML: XML with optional channels (time, tilt, tip force); verbose | W3C | Confirmed |
| **SQLite as an application file format**: single file, atomic updates, incremental writes (a zip must be rewritten), works across 32/64-bit and byte orders, any file suffix | sqlite.org | Author's own case for it; drawbacks not covered |
| SQLite in the browser needs sqlite-wasm; the default OPFS mode needs special headers; the "sahpool" mode allows only one open connection; Safari 17+ looked fine | sqlite.org wasm docs, WebKit bug | iPadOS limits not found |
| **`.ink` is claimed several times**: Mimio Notebook (whiteboard), Microsoft Journal ISF, inkle's Ink scripts, Pantone data, "Inker" drawings, InkML | fileinfo.com, fileformat.com | Multiple sources |
| Searching for `.inkw` found **no results** | web search | Absence of results is not proof; check registries before shipping |
| Tauri v2 `bundle.fileAssociations` takes `ext` (no dot) and `mimeType` (needed for Android matching); Apple needs an `exportedType` for custom extensions; `RunEvent::Opened` delivers files on macOS, iOS and Android, and fires at startup if the file launched the app, so the paths must be stored for the page | Tauri docs | Confirmed; the Windows/Linux (command-line argument) route was **not** confirmed |
| CBOR deterministic encoding has several incompatible profiles; unknown-field handling is up to the application | IETF drafts | Confirmed; no library comparison found |

## Options for the container

| | A: ZIP + JSON + binary strokes | B: SQLite file | C: custom chunks (v1) |
|---|---|---|---|
| Readable with tools already on every OS | `unzip`, Explorer, Finder, any language's zip library | `sqlite3` and a library in every language | Nothing: new readers needed |
| Human can look inside | Yes (JSON files) | Yes (tables) | No |
| Incremental save | Append entries and rewrite the central directory (fast); compact later | Native, atomic | Designed in |
| Random access to one page | Central directory | Index / primary key | Index chunk |
| Integrity | CRC-32 per entry, built in | Page checksums optional | CRC per chunk |
| Browser cost | `fflate` already in the app, no new dependency | ~1 MB wasm, header/OPFS caveats, one-tab limits | None |
| Same pattern as | Office files, ODF, EPUB, Krita | Many apps (SQLite's own claim) | PNG, RIFF/UIM |
| Weakness | Rewrites on big saves unless appended; ZIP quirks (zip64, path tricks) | Dependency weight on the web; harder to attach a hand-written reader | Largest build, no ecosystem |

**Decision: A, ZIP.** It reuses what the app already ships (`fflate`, `src/backup.ts`), every OS can
open the file without Inkwell, and a person can unzip it and read the JSON. SQLite stays the fallback
if append-saves on very large notebooks prove too slow (measure in phase 1). The stroke codec and
the schema are independent of the container, so switching later does not change them.

Wacom UIM is an **export target** (phase 5), not the native format. I did not check whether it can
carry Inkwell's text boxes, shapes, code blocks and Markdown pages, so I am not assuming it can.

## The extension

Use **`.inkw`**, MIME **`application/vnd.inkwell.notebook+zip`**. `.ink` is out: it is claimed by at
least five other programs (above). Before shipping, check `.inkw` against shared-mime-info, Apple's
type registry, the Windows registry guidance and IANA; I only searched the web.

Identification does not depend on the name: like ODF and EPUB, the first ZIP entry is a file named
`mimetype`, stored uncompressed with no extra field, containing exactly the MIME type above, so it
sits at a fixed byte offset (the string starts at byte 38 of the file; checked with `fflate`, which
keeps entry order and writes it there). `file`, libmagic and OS sniffers can recognise a
renamed or extension-less file. The registered MIME glob is `*.inkw`.

## Specification v1

```
notebook.inkw                       a ZIP (entries listed below; any order after the first)
  mimetype                          "application/vnd.inkwell.notebook+zip"; first entry, stored
  inkw.json                         manifest
  notebooks/<nid>.json              notebook tree
  pages/<pid>/page.json             a page without its strokes
  pages/<pid>/strokes.bin           the page's strokes in the compact encoding (below)
  blobs/<sha256-hex>.<ext>          pictures and backgrounds, stored once, not recompressed
  thumbnails/<pid>.png              preview of the page (optional)
  thumbnail.png                     preview of the first page (optional; for file managers)
```

All text is UTF-8 JSON. Ids are strings of at most 64 characters from `[A-Za-z0-9_-]`. A page's
pictures are placed in `page.json` and refer to blobs by hash, so the same picture on ten pages is
stored once.

**`inkw.json`**: `{ "format": "inkw", "version": { "major": 1, "minor": 0 }, "created": ISO-8601,
"modified": ISO-8601, "generator": "Inkwell 0.x", "notebooks": [ids], "locked": false, "extra": {} }`.

**`notebooks/<nid>.json`**: `{ id, name, sections: [ { id, name, color, parent?, collapsed?, pages:
[page ids in order] } ] }` (folders nest through `parent`, as in the app).

**`pages/<pid>/page.json`**: every field the app's `Page` has except strokes: `title`, `background`,
`pageColor`, `paper`, `landscape`, `texts`, `shapes`, `codes`, `md`, `images` (each with
`blob`: the hash), `backdrop` (hash), and optional `inkText`. Unknown keys are kept and written back.

**Compatibility.** A new **major** is a break: a reader refuses it and says which Inkwell version is
needed. A **minor** only adds keys, files and stroke channels. Readers ignore unknown keys and
unknown entries, and an editor writing the file back keeps them, so a newer file survives an older
editor.

### Stroke codec (`strokes.bin`), byte level

All integers are unsigned LEB128 varints unless noted; "zigzag" means `(n << 1) ^ (n >> 31)`.

```
file      = "INKS" · version u8 (=1) · stroke_count varint · stroke*
stroke    = id_len varint · id utf8 · tool u8 · flags u8 · rgb[3] · width varint ·
            opacity u8 · channels u8 · n varint · points
tool      = 0 pen | 1 highlighter | other values reserved (reader skips the stroke's tool name)
flags     = bit0: pressure is real (not simulated); other bits reserved, must be written 0
width     = stroke width in 1/16 px
opacity   = 0..255
channels  = bit0: pressure (always set in v1); bit1: time; bit2: tilt; bits 1..2 reserved in v1
points    = for i in 0..n-1:
              x: zigzag( X_i - 2·X_{i-1} + X_{i-2} )        X in 1/64 px, X_-1 = X_-2 = 0
              y: same for Y
              pressure: zigzag( P_i - P_{i-1} ), P in 0..255, P_-1 = 0
```

Second-order deltas make straight and smoothly curving ink very small. Coordinates are rounded to
1/64 px (the app stores 0.01 px today, so a re-save moves a point by at most about 0.008 px).

**Measured (spike, simulated noisy handwriting, 400 strokes, 21,200 points):** today's JSON is 20.4
bytes per point; this encoding 5.0 B/pt; deflated by the ZIP layer 3.9 B/pt, about 5× smaller than
JSON and 1.8× smaller than gzipped JSON. The data was simulated and pessimistic (sensor noise
inflates deltas). **Re-measure on real notebooks before freezing**, and measure the per-entry ZIP
overhead on a 500-page notebook.

### Locking

A password-locked file is the plain ZIP wrapped as already done for backups in `src/backup.ts`:
magic `INKWLK1\0` · salt(16) · iv(12) · AES-256-GCM(zip), key = PBKDF2-SHA256, 250,000 rounds. A
wrong password and a damaged file both fail authentication and say so. There is no recovery.

### Limits a reader enforces (a file is untrusted input)

At most 100,000 entries; 512 MB per entry and 4 GB in all after decompression; reject entry names
containing `..`, a leading `/` or `\`, drive letters or duplicates; ignore symlink attributes; reject
a stroke count or point count that does not fit the remaining bytes; cap JSON depth. Everything
decoded goes through the same validators as live and shared pages (`src/sanitize.ts`).

## Reference implementations

1. `src/inkw.ts`: pure TypeScript reader and writer (browser, Node, desktop share it; built on
   `fflate`), no DOM. `src/inkw.check.ts` runs in Node like `backup.check.ts`.
2. A Python reader using only the standard library (`zipfile`, `json`, `struct`): about 150 lines
   including the stroke decoder, so any OS with Python can read a file.
3. `inkw` command line (Node first): `info`, `check`, `extract`, `to-svg`, `to-pdf`, `to-json`.
4. Later, a Rust crate for the desktop side. (Not needed for the app to ship.)

## How it fits into the app

- **Save / Open** a page, a section or a notebook as `.inkw` (replaces the `.inkbackup` zip; restore
  keeps reading old backups). Saves append to the open file and rewrite the directory; "Compact"
  rewrites it fully.
- **Notebook folders** keep their `.inkwell` JSON files; an `.inkw` folder mode is a later option.
- **Open with / double-click**: `bundle.fileAssociations` with the extension and MIME type (and an
  `exportedType` for Apple), an Android intent filter from the same config, a shared-mime-info XML
  (glob plus the `mimetype` magic) in the Linux packages, and a startup hand-off of the opened
  paths to the page (the file may launch the app). The Windows/Linux path (command-line argument,
  single-instance forwarding) must be confirmed against the Tauri docs.
- **Thumbnails**: `thumbnail.png` inside the file, in the layout other ZIP-based formats use, so
  file-manager thumbnailers can show it; wiring each OS's thumbnailer is out of scope for v1.

## Phases and acceptance tests

| | Work | Done when |
|---|---|---|
| 0 | Check `.inkw` against registries; read Wacom UIM's schema and Rnote's repository for ideas worth taking; freeze this spec | The spec is reviewed and the extension is cleared |
| 1 | `src/inkw.ts` writer and reader, `inkw.check.ts`, golden files | Round-trips every page type (ink, text, shapes, code, Markdown, pictures, templates, paper); every corrupted, truncated or hostile file (zip bomb, `..` path, bad varint, duplicate entry) is rejected without a crash or a hang; real-notebook size and speed measured |
| 2 | Save / Open / backup in the app, locked and unlocked | A notebook saved on Linux opens on Windows, macOS, Android and the website |
| 3 | Python reader and CLI; cross-language tests | TypeScript writes and Python reads, and the reverse, on the same golden files |
| 4 | File association and open-with on Windows, macOS, Linux, Android | Double-clicking a file opens it, tried on a real machine of each (I can only test Linux here, and not the OS flow on any) |
| 5 | Converters: in from `.xopp` and Excalidraw (already read); out to SVG, PDF (already in the app), InkML, and Wacom UIM if feasible | A `.xopp` opens; exports validate in other tools |

## Risks and unknowns

- **Extension** is only web-searched (above).
- **Freezing**: files in the wild make mistakes permanent. Hence a version field, reserved bits and a
  public spec before shipping; phase 0 is not optional.
- **Size and speed** rest on one simulated spike.
- **ZIP is easy to get subtly wrong** (zip64, names, duplicate entries, symlinks); the limits and
  the hostile-file tests exist for that.
- **Append-saves** on a notebook with thousands of pages are unmeasured; SQLite is the fallback.
- **OS integration** needs real machines (phase 4).
- **Windows/Linux open-with** in Tauri is unconfirmed.
- **Scope**: weeks of work, mostly phases 1, 2 and 4.

## Decisions for the owner

1. Is `.inkw` acceptable (and the MIME type `application/vnd.inkwell.notebook+zip`)?
2. ZIP first, SQLite only if phase 1 measurements demand it?
3. Should a locked `.inkw` be v1 (reuses `backup.ts`) or wait?

## Sources

- Wacom Universal Ink Model: https://developer-docs.wacom.com/docs/overview/specifications/universal-ink-model/ and https://pypi.org/project/universal-ink-library/2.0.0
- Xournal++ README (mirror): https://github.com/ishakhrai/xournalpp ; Rnote format (secondary): https://rustutils.com/tools/rnote/
- Microsoft ISF: https://learn.microsoft.com/en-ie/Windows/Win32/tablet/persistence-formats ; W3C InkML: https://www.w3.org/TR/2006/WD-InkML-20061023/diffmarked.html
- SQLite as an application file format: https://sqlite.org/appfileformat.html ; SQLite Wasm persistence: https://sqlite.org/wasm/doc/trunk/persistence.md ; WebKit OPFS bug: https://onbugs.webkit.org/show_bug.cgi?id=252138
- `.ink` collisions: https://fileinfo.com/extension/ink and https://docs.fileformat.com/data/ink
- Tauri mobile file associations: https://v2.tauri.app/learn/mobile-file-associations/
- Deterministic CBOR drafts (considered, not used): https://datatracker.ietf.org/doc/html/draft-rundgren-deterministic-cbor-17
