# The `.inkw` file format, version 1.0

Status: frozen for implementation, 2026-10-25. Background and decisions: `plans/ink-format.md`.
The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Identity

- Extension `.inkw`. Media type `application/vnd.inkwell.notebook+zip`.
- A file is recognised by its content, not its name: it is a ZIP whose first entry is named
  `mimetype`, stored (compression method 0), with no extra field, whose content is exactly the media
  type above. The media type therefore starts at byte offset 38 of the file.

## 2. Container

A ZIP archive (PKWARE APPNOTE). Entries, after `mimetype`, in any order:

| Entry | Content |
|---|---|
| `inkw.json` | Manifest (section 3) |
| `notebooks/<nid>.json` | A notebook's tree (section 4) |
| `pages/<pid>/page.json` | A page without its strokes (section 5) |
| `pages/<pid>/strokes.bin` | The page's strokes (section 6) |
| `blobs/<sha256-hex>.<ext>` | A picture or background, stored once; method 0 (not recompressed) |
| `thumbnails/<pid>.png` | Preview of a page (optional) |
| `thumbnail.png` | Preview of the first page (optional; for file managers) |

All JSON is UTF-8. An **id** (`nid`, `pid`, stroke id) is a string of 1 to 64 characters from
`[A-Za-z0-9_-]`. `<sha256-hex>` is 64 lower-case hexadecimal characters: the SHA-256 of the blob's
bytes (a reader MUST check it). `<ext>` is 1 to 8 lower-case letters or digits.

Entries other than those above are **unknown entries**: a reader MUST ignore them, and a program that
writes the file back MUST keep them.

## 3. Manifest: `inkw.json`

```json
{ "format": "inkw", "version": { "major": 1, "minor": 0 },
  "created": "2026-10-25T12:00:00.000Z", "modified": "2026-10-25T12:00:00.000Z",
  "generator": "Inkwell 0.2.5", "notebooks": ["n1"], "locked": false, "extra": {} }
```

`format` MUST be `"inkw"`. `notebooks` lists the notebook ids present, in order. `extra` is free for
future additions. Unknown keys MUST be ignored and kept.

**Versions.** A reader that finds a `major` greater than it supports MUST refuse the file with a
message saying a newer version of the program is needed. A greater `minor` MUST open; it only adds
keys, entries and stroke channels. A program MUST read `inkw.json` before anything else.

## 4. Notebook: `notebooks/<nid>.json`

```json
{ "id": "n1", "name": "Maths",
  "sections": [ { "id": "s1", "name": "Algebra", "color": "#3e63dd",
                  "parent": "s0", "collapsed": false, "pages": ["p1", "p2"] } ] }
```

`parent` and `collapsed` are optional. Folders nest through `parent`; `pages` lists page ids in
order. A page id appears in exactly one section.

## 5. Page: `pages/<pid>/page.json`

Every field of an Inkwell page except `strokes`:

| Key | Value |
|---|---|
| `title` | string |
| `background` | `blank`, `grid`, `dots`, `lines`, `cornell`, `staff`, `graph` or `picture` |
| `pageColor` | `"auto"` or `#rrggbb` |
| `paper` | `a4`, `a3` or `letter` (absent: infinite canvas); `landscape`: boolean |
| `texts` | text boxes (`id, x, y, w, text, font, size, color, bold, italic, angle?`) |
| `shapes` | shapes (`kind`, geometry, style, `head?`, bindings, `group?`, `locked?`) |
| `codes` | code blocks (`id, x, y, w, lang, code, ...`) |
| `md` | Markdown source; present only on Markdown notes |
| `images` | `[{ id, blob, cx, cy, w, h, angle }]`; `blob` is a `<sha256-hex>` naming `blobs/<hash>.<ext>` |
| `backdrop` | a blob hash, when `background` is `picture` |
| `inkText` | the page's handwriting read as text (optional) |

A page that names a blob missing from the file MUST still open (the picture is left out and the
reader reports a warning). Unknown keys are ignored and kept. The exact field list of each kind
follows the Inkwell `Page` type for the same `generator` version.

## 6. Strokes: `pages/<pid>/strokes.bin`

All integers are unsigned LEB128 varints unless a width is given; **zigzag** of a signed integer `n`
is `(n << 1) ^ (n >> 31)`.

```
file    = "INKS" · version u8 (= 1) · stroke_count varint · stroke*
stroke  = id_len varint · id (UTF-8) · tool u8 · flags u8 · rgb[3] · width varint ·
          opacity u8 · channels u8 · n varint · point*
tool    = 0 pen | 1 highlighter | other values reserved (a reader MUST refuse the page)
flags   = bit 0: pressure is real (not simulated); other bits MUST be written as 0
rgb     = the stroke colour, one byte per channel
width   = stroke width in 1/16 px
opacity = 0..255
channels= bit 0: pressure (always set in 1.0); bits 1..7 reserved: a reader that sees one it does not
          know MUST refuse the page (the point layout is unknown)
point   = x, y, pressure as below, repeated n times
```

With `X_i = round(x_i * 64)` and `Y_i = round(y_i * 64)` (1/64 px), `X_-1 = X_-2 = 0`, and likewise `Y`:

- `x` is `zigzag(X_i - 2*X_{i-1} + X_{i-2})`, `y` the same with `Y`;
- `pressure` is `zigzag(P_i - P_{i-1})` with `P_i = round(p_i * 255)` and `P_-1 = 0`.

Rounding to 1/64 px moves a point by at most 1/128 px. A reader MUST reject a file whose counts do
not fit in the remaining bytes, whose varints exceed 5 bytes, or whose version it does not know.
A stroke with non-finite coordinates, coordinates beyond 4,000,000 px, a colour that is not
`#rrggbb`, or a point list that is not a multiple of 3 numbers cannot be written; a writer MUST
leave it out and SHOULD tell the user how many were left out. A stroke id that is not a valid id
MUST be rewritten (other characters become `_`, cut to 56 characters, made unique with `-1`, `-2`...).

**Worked example.** One pen stroke, id `s1`, colour `#1c1c1e`, width 2 px, opacity 1, real pressure,
two points `(10, 20, 1.0)` and `(11, 20, 1.0)` is these 29 bytes:

```
49 4E 4B 53  01  01  02 73 31  00  01  1C 1C 1E  20  FF  01  02
80 0A 80 14 FE 03   FF 08 FF 13 00
```

(`INKS`, version 1, one stroke, id length 2 and `s1`, pen, flags 1, colour, width 32 = 2 px × 16,
opacity 255, channels 1, two points; point 0: x = zigzag(640) = 1280, y = zigzag(1280) = 2560,
pressure = zigzag(255) = 510; point 1: x = zigzag(704 - 1280) = zigzag(-576) = 1151,
y = zigzag(1280 - 2560) = zigzag(-1280) = 2559, pressure = 0.)

## 7. Locking (optional)

A locked file is the ZIP of sections 1 to 6 wrapped: the 8 bytes `INKWLK1\0`, a 16-byte random salt, a
12-byte random IV, then the AES-256-GCM encryption of the whole ZIP (16-byte tag at the end). The key
is PBKDF2 with HMAC-SHA-256, 250,000 iterations, the password's UTF-8 bytes and the salt, 32 bytes
long. A wrong password and a damaged file both fail authentication and MUST be reported as
"Wrong password". There is no recovery for a lost password.

## 8. What a reader enforces (a file is untrusted input)

- At most 100,000 entries; at most 512 MB for one entry and 4 GB in all after decompression. Sizes
  declared in the ZIP headers MUST NOT be trusted: stop decompressing at the limit.
- Reject an entry name that contains `..`, starts with `/` or `\`, has a drive letter, or repeats an
  earlier name. Ignore any symlink attribute; never create files on disk from entry names.
- Reject a stroke or point count that does not fit the remaining bytes; cap JSON nesting depth.
- Check every blob hash. Treat everything decoded as data: validate it as the app does for pages that
  arrive over the network.

## 9. Registry check (2026-10-25)

| Where | Result |
|---|---|
| This machine's shared MIME database (`/usr/share/mime`) | no `.inkw` and no `inkwell` type |
| Web search: `.inkw`, `application/vnd.inkwell` | no result for either; IANA lists InkML as `application/inkml+xml` |
| IANA media-type registry | no registration found by search; the vendor-tree registration is a form to submit later |
| Windows | register `.inkw` per user (`HKCU\Software\Classes`) with a ProgID such as `Inkwell.Notebook.1`; on uninstall leave the extension mapping alone (Microsoft guidance) |
| Apple | declare an exported type with identifier `app.inkwell.notebook`, `public.filename-extension` `inkw`, conforming to `public.data` (the root a file-format type needs), and also declare the document type the app handles; Apple's DTS engineers advise that a longer extension avoids collisions, which `.inkw` (4 letters) accepts as a risk |

Not checked: Apple's current registered-UTI list and Windows' installed-program registrations on
other machines (no access). Re-check before shipping the OS file association.

## 10. Considered

- **Rnote** (`.rnote`, read from its source): gzipped JSON with a version wrapper read first, and a
  chain of converters from each older version (`RnoteFileMaj0Min13` and so on). Taken: read the
  version before anything else, and keep a reader for every older major rather than dropping it. It
  also sizes its buffer from the length stored in the gzip trailer; section 8 forbids trusting
  declared sizes for that reason.
- **Wacom Universal Ink Model**: RIFF with Protocol Buffers and spline control points; only its
  documentation summary was read, not the schema. No change made; an export is a later option.
- **InkML**: per-point channels (time, tilt, force). Taken: the `channels` byte reserves bits for
  them.
- **Layers, authorship and per-stroke tool styles** (present in some formats): not in 1.0; they would
  arrive as new keys or stroke channels in a minor version.
