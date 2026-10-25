# A portable Inkwell file: one binary any OS can read

Status: plan, nothing built. Written 2026-10-25.

## Why

Today a note lives in three shapes: the app's own storage (IndexedDB), `.inkwell` JSON files in a
notebook folder, and `.inkbackup` (a zip). None is a file a person can double-click, send, open on
another OS, or read from another program. Goal: **one self-describing binary file for a page, a
section or a whole notebook**, with a written spec and readers that need nothing from Inkwell.

Non-goals (for the first version): live collaboration, a database, replacing notebook folders (they
keep working), editing the file in place from other tools.

## Decision needed first: the extension

`.ink` is taken. Microsoft Journal / the Tablet PC SDK use `.ink` for ISF (Ink Serialized Format) and
inkle's Ink scripting language uses `.ink` for story scripts. If Inkwell registers `.ink` with the OS,
it can hijack or be hijacked by those on Windows and macOS (and double-click would offer the wrong
app). Options:

| | Extension | MIME | Note |
|---|---|---|---|
| A (recommended) | `.inkw` | `application/vnd.inkwell.notebook` | Unclaimed as far as I found; short; still contains "ink". |
| B | `.inkwell` | same | Already used for the JSON page files in notebook folders; would need one to be renamed. |
| C | `.ink` | same | What was asked for. Works, but the collision above is real. The magic bytes below identify the file whatever it is called, so a renamed file still opens. |

The format does not depend on the choice. Check the extension against the OS registries before
shipping (I did not).

## Prior art, and what we take

Found by search (only part was covered; Wacom UIM, `.xopp` and Rnote were **not** confirmed):

- **ISF (Microsoft):** described by Microsoft as the most compact ink representation, extensible
  with GUID-keyed attributes on ink, strokes and points. Take: compactness matters, and
  extensibility must be designed in.
- **InkML (W3C):** XML, captures position over time plus optional channels (tilt, tip force);
  easy to extend but verbose. Take: *channels* per point (so time, tilt, pressure can be added
  later). Offer InkML as an export, not the native format.

Not verified, so not relied on: Wacom Universal Ink Model, Xournal++ `.xopp` (gzip XML), Rnote.
Read their specs before the spec is frozen.

## Measured: how compact can strokes get

A spike (not committed) encoded 400 simulated handwriting strokes (21,200 points, a Surface-pen-like
noisy profile, so a pessimistic case: sensor noise inflates deltas):

| Encoding | Bytes | Per point |
|---|---|---|
| JSON as the app stores it today | 433,514 | 20.4 |
| JSON + gzip | 146,137 | 6.9 |
| Binary, x/y in 1/64 px with second-order deltas, pressure 0..255, zigzag varints | 105,616 | 5.0 |
| Same + deflate | 82,347 | 3.9 |

So about 5× smaller than today's JSON and 1.8× smaller than gzipped JSON. Real, smoother pens
should do better. **Re-measure on real notebooks before freezing the codec.**

## Format design

One file, little-endian throughout, chunked like PNG so readers can skip what they do not know.

```
file    = header · chunk* · index · footer
header  = magic[8] · major u8 · minor u8 · flags u16 · header_crc32 u32
magic   = 89 49 4E 4B 0D 0A 1A 0A      (non-ASCII first byte and line-ending bytes catch text-mode
                                         damage; this identifies the file whatever its extension)
chunk   = type[4] · length u64 · payload · crc32 u32
index   = chunk listing every other chunk's type, id and byte offset (random access)
footer  = index_offset u64 · whole-file sha256 (optional) · magic[8] reversed
```

Chunk type letters follow PNG's rule: an **uppercase first letter means critical** (a reader that
does not understand it must refuse the file), lowercase means ancillary (skip it, and keep it when
saving so a newer file survives an older editor).

| Chunk | Contents |
|---|---|
| `META` | CBOR: title, created, modified, app and version, notebook tree, page order |
| `PAGE` | CBOR for one page: size, paper, background, colour, text boxes, shapes, code blocks, Markdown, pictures placed on it, a list of stroke-block ids |
| `STRK` | The strokes of one page in the compact binary encoding above, deflate-compressed; a stroke is tool, colour, width, opacity, flags, channel list, then points |
| `BLOB` | One picture or file, addressed by its SHA-256 so the same picture is stored once; compressed only if it is not already |
| `thmb` | PNG preview of the page, for file managers and quick look |
| `ENCR` | Wraps all following chunks: AES-256-GCM with a PBKDF2-SHA256 key (the scheme already in `src/backup.ts` and `src/share-crypto.ts`) |
| `ink?` | Reserved for later: handwriting text index, audio track and its stroke times, etc. |

Why these choices:

- **CBOR for structure** (RFC 8949): self-describing, binary, small, a library exists in every
  language, and unknown keys are ignored, which is what compatibility needs. Not protobuf: that
  needs generated code and a schema file shipped to every reader.
- **Custom binary only for strokes**, because that is where the bytes are.
- **Deflate, not zstd, in version 1**: deflate is in every standard library on every OS. A flag bit
  leaves room for zstd.
- **Append-friendly saves**: saving a big notebook appends changed chunks and a new index instead of
  rewriting the file; a compaction pass rewrites it. A crash leaves the old index valid.
- **Index at the end**: open a 500-page notebook by reading the footer and the index, then only
  the pages you look at.

Compatibility rules: a new **major** is a break; a **minor** only adds chunks, keys and channels.
Readers must ignore unknown keys and unknown ancillary chunks; unknown critical chunks are refused
with a message that says which version of Inkwell is needed.

## What gets built

1. `docs/ink-format-spec.md`: the byte-level spec above, with a worked example in hex.
2. `src/ink-format.ts`: pure TypeScript reader and writer (browser, Node and the desktop app share
   it), no DOM. Checked in Node like `backup.check.ts`.
3. A Rust crate (read and write; for the desktop side and a command-line tool) and a small Python
   reader (about 200 lines, standard library only, so any OS with Python can read a file).
4. `inkw` command-line tool: `info`, `check`, `extract-pictures`, `to-svg`, `to-pdf`, `to-json`.
5. Converters: **in** from `.xopp`, Excalidraw (already read), InkML; **out** to SVG and PDF
   (already in the app) and InkML.

## How it fits into the app

- **Save / Open** for a page, a section or a notebook, replacing the `.inkbackup` zip (restore
  keeps reading old backups).
- **Notebook folders** keep their `.inkwell` JSON files until the format is proven; a later phase can
  offer `.ink`-based folders.
- **File association**: Tauri `fileAssociations` for Windows, macOS and Linux (MIME entry), an
  Android intent filter, and "open with" handling that passes the path to the page. The registered
  type is by MIME and extension; the magic bytes are the real check.
- **Thumbnails**: the `thmb` chunk gives file managers a preview where the OS supports it
  (macOS Quick Look and Windows/Linux thumbnailers are separate small plugins, and out of scope
  for the first release).

## Phases

| | Work | Done when |
|---|---|---|
| 0 | Decide the extension; read Wacom UIM, `.xopp` and Rnote specs; freeze the spec | Spec written and reviewed |
| 1 | TypeScript codec and writer/reader with golden files and a fuzz test | Round-trips every page type (ink, text, shapes, code, Markdown, pictures, templates, paper) and rejects every corrupted or truncated file without crashing |
| 2 | Save / Open / backup in the app | A notebook saved on one OS opens on another, locked and unlocked |
| 3 | File association and "open with" on Windows, macOS, Linux, Android | Double-clicking a file opens it, on a real machine of each (**this is the part I cannot test from here**) |
| 4 | Rust crate, Python reader, CLI; cross-language tests in CI | TypeScript writes, Rust and Python read, and the reverse, byte for byte |
| 5 | Converters in and out | A `.xopp` and an Excalidraw file import; SVG, PDF and InkML export |

## Risks

- **Extension collision** (above).
- **Format lock-in**: once files exist in the wild, mistakes are permanent. Hence the version
  fields, critical/ancillary rule and a public spec before anything ships; phase 0 is not optional.
- **Size and speed claims** come from one spike on simulated strokes. Measure on real notebooks.
- **OS integration** (phase 3) needs real Windows, macOS and Linux machines; I can only test
  Linux here, and not the OS file-association flow on any of them.
- **Malicious files**: a file is untrusted input. Lengths are bounded, decompression has a size cap,
  CRCs are checked, and decoded pages go through the same validators as live and shared pages
  (`src/sanitize.ts`).
- **Scope**: this is weeks of work for one person, mostly in phases 1, 3 and 4.
