# `.inkw` Implementation Plan

**Goal:** Inkwell can save a page, folder or notebook to one `.inkw` file and open it again on any OS, the website included, and a stdlib-only Python reader can read the same files.

**Architecture:** A ZIP container (built on `fflate`, already a dependency) holding JSON for the schema and one compact binary file per page for strokes. Two pure modules (`inkw-codec.ts`, `inkw.ts`) with no DOM are checked in Node; a mapping module and a small UI layer connect them to the app's storage; a Python script proves any other language can read it.

**Tech Stack:** TypeScript (strict, Biome), `fflate`, WebCrypto, Node 22 (runs `*.check.ts` directly, so imports end in `.ts` and no enums), Python 3 stdlib, Playwright e2e.

**Spec:** `docs/plans/ink-format.md` (format and decisions). Out of scope here, each its own plan because each needs real machines: OS file association and "open with" (spec phase 4), converters from `.xopp` and to InkML/UIM (phase 5).

## Global Constraints

- Extension `.inkw`; MIME `application/vnd.inkwell.notebook+zip`.
- ZIP: first entry `mimetype`, stored (level 0), no extra field, content exactly the MIME type, so it starts at byte 38 of the file. Other entries: `inkw.json`, `notebooks/<nid>.json`, `pages/<pid>/page.json`, `pages/<pid>/strokes.bin`, `blobs/<sha256-hex>.<ext>` (stored, not recompressed), `thumbnails/<pid>.png`, `thumbnail.png`.
- All text UTF-8 JSON. Ids: at most 64 characters from `[A-Za-z0-9_-]`.
- `inkw.json`: `{ format: "inkw", version: { major: 1, minor: 0 }, created, modified, generator, notebooks: [ids], locked: false, extra: {} }`. A greater **major** is refused with a message naming the Inkwell version needed; a greater **minor** opens; unknown keys and unknown entries are ignored and kept on write-back.
- Stroke codec `strokes.bin`: `"INKS"` · version `u8 = 1` · stroke count varint · strokes; stroke = id length varint · id · tool `u8` (0 pen, 1 highlighter, others reserved) · flags `u8` (bit0 pressure real, other bits 0) · rgb[3] · width varint in 1/16 px · opacity `u8` (0..255) · channels `u8` (bit0 pressure, always set in v1; bits 1-2 reserved) · point count varint · points. Points: x and y as zigzag second-order deltas of values in 1/64 px (`X_-1 = X_-2 = 0`); pressure as zigzag first-order delta of 0..255 (`P_-1 = 0`). Varints are unsigned LEB128; zigzag is `(n << 1) ^ (n >> 31)`.
- Lock: magic `INKWLK1\0` · salt(16) · iv(12) · AES-256-GCM(zip); key PBKDF2-SHA256, 250,000 rounds. Wrong password and damage both fail as "Wrong password".
- Reader limits: at most 100,000 entries; 512 MB per entry and 4 GB total decompressed; reject names containing `..`, a leading `/` or `\`, a drive letter, or duplicates; ignore symlink attributes; reject counts that do not fit the remaining bytes.
- Repo rules: `npx biome check .`, `npx tsc --noEmit` and `npm run check` stay green; new pure modules get a `*.check.ts` added to the `check` script in `package.json`.

## Review Focus

Failure modes the spec implies but no task's own happy path covers, most likely first. Each has a test in the task named in brackets.

1. A legacy `.inkbackup`, a plain zip or any random file given to Open: a clear message, no crash, nothing imported. [Task 3, Task 6]
2. Corrupt app data written out: an empty stroke, a one-point stroke, a stroke with `NaN` or infinite coordinates. The notebook must still save, with that stroke skipped and counted, not lost. [Task 1, Task 4]
3. A page that names a picture hash missing from the file: the page opens without that picture and a warning, not an error. [Task 4]
4. Importing next to existing notebooks with the same ids or names: nothing is overwritten, ids are regenerated, names get ` (restored)`. [Task 4, Task 6]
5. A file from a newer Inkwell (minor higher: opens; major higher: refused with the version needed); and a locked file opened with the wrong password. [Task 3, Task 5]

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/inkw-spec.md` | The frozen byte-level spec for outside implementers (Task 0) |
| `src/inkw-codec.ts` | Pure: strokes ⇄ `strokes.bin` bytes |
| `src/inkw.ts` | Pure: container read/write, limits, locking glue, error type |
| `src/inkw.check.ts`, `src/inkw-codec.check.ts` | Node checks, golden files, hostile-file corpus |
| `src/inkw-model.ts` | Maps the app's notebooks ⇄ `InkwData`; validation of untrusted data via `sanitize.ts` |
| `src/notebook-clean.ts` | `cleanNotebooks` moved out of `backup-ui.ts` so restore and Open share it |
| `src/inkw-ui.ts` | Save and Open commands, password prompts, drop handling |
| `tools/inkw.py` | Python reader and `info` command (stdlib only) |
| `e2e/inkw.mjs` | Save in one browser, open in another, three engines |
| `docs/inkw-golden/` | Committed sample files and their expected JSON |

---

### Task 0: Freeze the spec and clear the extension

**Files:** Create `docs/inkw-spec.md`; Modify `docs/plans/ink-format.md` (mark phase 0 done).

**Interfaces:** Produces the spec that Tasks 1-7 cite; no code.

- [ ] **Step 1:** Copy the Global Constraints above into `docs/inkw-spec.md` as a numbered, normative spec ("MUST/SHOULD"), adding one worked example: a one-stroke page as hex bytes of `strokes.bin` (encode it by hand from the rules, then confirm it in Task 1's first test).
- [ ] **Step 2:** Check `.inkw` and the MIME type against: the shared-mime-info database (`/usr/share/mime/` on this machine, and its public repository), Apple's registered UTIs list, Microsoft's file-type registration guidance and the IANA media type list. Record each result and its date in the spec's "Registry check" section. If anything claims `.inkw`, stop and ask the owner before Task 1.
- [ ] **Step 3:** Read Rnote's repository serialization code and Wacom's UIM base schema for one thing each: a field Inkwell's schema is missing that every ink format has. Add a "Considered" list (decisions, not new work) to the spec.
- [ ] **Step 4:** Commit `docs: inkw spec v1 frozen, registry check`.

### Task 1: Stroke codec

**Files:** Create `src/inkw-codec.ts`, `src/inkw-codec.check.ts`; Modify `package.json` (`check` script).

**Interfaces:**
- Produces: `encodeStrokes(strokes: Stroke[]): { bytes: Uint8Array; skipped: number }` and `decodeStrokes(bytes: Uint8Array): Stroke[]` (`Stroke` from `store.ts`, imported as a type only); `class InkwError extends Error { code: 'format' | 'version' | 'limit' | 'password' | 'unsupported' }` exported from `src/inkw-codec.ts` (re-exported by `inkw.ts`).

- [ ] **Step 1: Write failing tests** in `inkw-codec.check.ts`:
  - `roundTripsEveryPenProfile`: for each `PROFILES` entry in `pen-sim.ts`, simulate 20 script strokes, convert to `Stroke` (`pressure` true for `real` pens), encode/decode, assert same id, tool, color, opacity within 1/255, width within 1/16, point count equal, every x and y within 1/128 px, every pressure within 1/255.
  - `matchesWorkedExample`: encoding the spec's one-stroke example produces exactly its hex bytes.
  - `emptyAndSinglePointStrokes`: a 0-point and a 1-point stroke round-trip with their point counts.
  - `nonFiniteStrokesAreSkipped`: input of three strokes, the middle one containing `NaN` and another with `Infinity`: `skipped === 2` and the output decodes to the other one.
  - `rejectsMalformed`: bad magic, version 2, truncated at every byte offset of a sample, stroke count 2^32 on a 10-byte file, a varint longer than 5 bytes: each throws `InkwError` with code `format` (or `version` for version 2), none hangs.
  - `sizeBudget`: 400 strokes of the `surface pen` profile encode to at most 6 bytes per point before deflate.
- [ ] **Step 2:** Run `node src/inkw-codec.check.ts`; expect failure (module missing).
- [ ] **Step 3:** Implement `encodeStrokes` and `decodeStrokes` per the codec in Global Constraints. Hex colour `#rrggbb` to rgb bytes and back (lower case). Keep a single `Reader` class with bounds-checked `u8()` and `varint()` so every truncation throws `InkwError('format')`. Pressure of strokes whose flag bit0 is 0 is still stored (simulated pressure is whatever the app holds).
- [ ] **Step 4:** Run the check; expect `inkw-codec checks passed`.
- [ ] **Step 5:** Add `&& node src/inkw-codec.check.ts` to the `check` script, run `npm run check`, commit `feat: inkw stroke codec`.

### Task 2: Container writer and reader (no limits yet)

**Files:** Create `src/inkw.ts`, `src/inkw.check.ts`; Modify `package.json`.

**Interfaces:**
- Consumes: Task 1's codec and `InkwError`.
- Produces:
  - `interface InkwPage { id: string; strokes: Stroke[]; json: Record<string, unknown> }` (`json` = everything in `page.json`, unknown keys kept)
  - `interface InkwNotebook { id: string; json: Record<string, unknown> }`
  - `interface InkwData { created: string; modified: string; generator: string; notebooks: InkwNotebook[]; pages: InkwPage[]; blobs: Map<string, { ext: string; bytes: Uint8Array }>; extra: Record<string, unknown>; manifestRest: Record<string, unknown>; unknownEntries: Record<string, Uint8Array>; warnings: string[] }` (`manifestRest`: unknown top-level keys of `inkw.json`, kept for write-back)
  - `writeInkw(data: InkwData): Promise<{ bytes: Uint8Array; skipped: number }>` (`skipped`: damaged strokes left out; async: SHA-256 of blobs is checked, not trusted: a blob key that is not the SHA-256 of its bytes throws `format`)
  - `readInkw(bytes: Uint8Array): Promise<InkwData>`
  - `const INKW_MIME = 'application/vnd.inkwell.notebook+zip'`

- [ ] **Step 1: Write failing tests:**
  - `mimetypeIsFirstAndAtByte38`: first 4 bytes `50 4B 03 04`; bytes 30..37 are `mimetype`; bytes 38.. are `INKW_MIME`; the entry's compression method is 0.
  - `roundTripsAFullDocument`: two notebooks, three pages, one blob used by two pages (stored once), strokes on each: `readInkw(await writeInkw(d))` deep-equals `d`.
  - `unknownKeysAndEntriesSurvive`: `page.json` with an extra key `"future": {"a": 1}`, `inkw.json` `extra`, and an unknown entry `future/x.bin`: all present after read-write-read.
  - `openedByStandardTools`: write a sample to a temp dir, run `unzip -t` (skip the check when `unzip` is absent) and assert exit 0.
  - `goldenFilesStillDecode`: for every `docs/inkw-golden/*.inkw`, `readInkw` equals the neighbouring `.expected.json` (this guards the format against accidental change; create the first golden file in this task from the round-trip document and commit it).
- [ ] **Step 2:** Run `node src/inkw.check.ts`; expect failure.
- [ ] **Step 3:** Implement with `zipSync`/`unzipSync`. Order entries so `mimetype` is first (object key insertion order; `level: 0` for `mimetype` and blobs, 6 otherwise). Blob file name is `blobs/<sha256hex>.<ext>`; compute the hash with `crypto.subtle.digest`.
- [ ] **Step 4:** Run the check; expect pass. Add to the `check` script; commit `feat: inkw container reader and writer`.

### Task 3: Limits, hostile files, versions, locking

**Files:** Modify `src/inkw.ts`, `src/inkw.check.ts`, `src/backup.ts`, `src/backup.check.ts`.

**Interfaces:**
- Consumes: Task 2.
- Produces: `readInkw(bytes, limits?: Partial<InkwLimits>)`; `interface InkwLimits { entries: number; entryBytes: number; totalBytes: number }` with the spec defaults; `writeInkwLocked(data, password): Promise<{ bytes: Uint8Array; skipped: number }>`; `readInkwLocked(bytes, password): Promise<InkwData>`; `isInkwLocked(bytes): boolean`. `backup.ts` gains an optional `magic` argument on `lock`, `unlock` and `isLocked` (default unchanged) so both file kinds share one implementation.

- [ ] **Step 1: Write failing tests** (all in `inkw.check.ts`; small limits passed in so they run fast):
  - `rejectsPathTricks`: entry names `../x`, `/etc/x`, `a\..\b`, `C:\x` each throw `InkwError('format')`.
  - `rejectsDuplicateEntries`: hand-built zip bytes with two central-directory entries of the same name throw `format` (write a 30-line helper that builds raw zips; fflate cannot make duplicates).
  - `zipBombIsStopped`: a 5 MB zero-filled entry with `entryBytes: 1_000_000` throws `limit` and returns in under 2 s.
  - `forgedSizesDoNotBypassLimits`: same bomb with the declared sizes in the headers patched to 100 bytes still throws `limit` or `format`, never allocates past the limit. If `unzipSync` cannot bound this, switch the reader to fflate's streaming `Unzip` with `UnzipInflate` and a running byte counter that aborts at the cap.
  - `tooManyEntries`: `entries: 3` on a 5-entry zip throws `limit`.
  - `majorVersionRefused` / `minorVersionOpens`: `version.major: 2` throws `version` with a message containing "newer version of Inkwell"; `{ major: 1, minor: 9 }` opens with its extra keys intact.
  - `notAnInkwFile`: a plain zip, the bytes of a `.inkbackup`, 12 random bytes, and an empty array each throw `format` with the message "Not an Inkwell file".
  - `lockedRoundTrip` / `wrongPasswordFails` / `bentByteFails`: locked bytes start with `INKWLK1\0`, contain no readable notebook name, open with the right password, and fail with code `password` for a wrong one or a changed last byte.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement limits and name validation before inflating anything; lock helpers delegate to `backup.ts` with the `INKWLK1\0` magic. Add a `backup.check.ts` case showing the default magic still produces and reads the old `INKWBK1\0` files.
- [ ] **Step 4:** Run `npm run check`; expect all pass.
- [ ] **Step 5:** Commit `feat: inkw limits, version rules and locking`.

### Task 4: Model mapping and validation

**Files:** Create `src/notebook-clean.ts`, `src/inkw-model.ts`, `src/inkw-model.check.ts`; Modify `src/backup-ui.ts` (import `cleanNotebooks` from the new file); Modify `package.json`.

**Interfaces:**
- Consumes: `InkwData`, `sanitize.ts` validators (`cleanStroke`, `cleanText`, `cleanShapes`, `cleanCodes`, `cleanMd`, `BACKGROUNDS`, `PAPERS`, `hex`, `num`).
- Produces:
  - `cleanNotebooks(raw: unknown[], pic: Map<string, string>, newId: () => string): Notebook[]` (moved from `backup-ui.ts`, id factory injected so it is Node-testable)
  - `toInkw(notebooks: Notebook[], getBlob: (id: string) => Promise<{ type: string; bytes: Uint8Array } | null>): Promise<{ data: InkwData; skipped: number }>`
  - `fromInkw(data: InkwData, newId: () => string, storePicture: (b: { type: string; bytes: Uint8Array }) => Promise<string>, existingNames: Set<string>): Promise<{ notebooks: Notebook[]; warnings: string[] }>`

- [ ] **Step 1: Write failing tests** (`inkw-model.check.ts`, in Node with a fake `getBlob`/`storePicture`):
  - `savesAndRestoresEveryPageKind`: ink, text boxes, shapes (with `head`), code blocks, a Markdown note, a paper page with a backdrop, a page with two pictures: `fromInkw(toInkw(x))` equals `x` apart from regenerated ids.
  - `skipsBadStrokesAndCountsThem`: a page with a `NaN` stroke saves with `skipped === 1` and the other strokes intact.
  - `missingPictureOpensWithWarning`: delete one blob from the data: the page comes back without that picture and `warnings` has one entry naming the page.
  - `importNeverCollides`: import the same data twice into a set of existing names: every id differs from the first import and the second notebook is named `<name> (restored)`.
  - `hostilePageJsonIsCleaned`: a `page.json` with `title` 10,000 chars, `background: "<script>"`, `pageColor: "red"`, strokes with string coordinates: title is cut to 200, background `blank`, colour `auto`, the bad strokes dropped.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Move `cleanPage`/`cleanNotebooks` out of `backup-ui.ts` (behaviour unchanged; `backup.mjs` e2e must still pass). Implement `toInkw`/`fromInkw` with the field list from the spec; pictures by SHA-256 so one picture used on many pages is one blob.
- [ ] **Step 4:** Run `npm run check` and `npm run e2e:backup`; expect pass.
- [ ] **Step 5:** Commit `feat: map notebooks to and from inkw, shared validation`.

### Task 5: Save and Open in the app

**Files:** Create `src/inkw-ui.ts`; Modify `src/export.ts` (Export panels: a "Save as .inkw…" button with scope This page / This folder / Whole notebook, and an optional password), `src/insert.ts` (Insert menu "Inkwell file (.inkw)…" and the page drop handler), `src/main.ts` (import the module), `src/about.ts` (mention in the algorithm list).

**Interfaces:**
- Consumes: Task 4 mapping, `download` from `export.ts`, `askPassword` (export it from `backup-ui.ts`), `storePicture`, `blobOf`, `state`, `update`.
- Produces: `saveInkw(scope: 'page' | 'folder' | 'notebook'): Promise<void>`; `openInkw(file: File): Promise<void>`; `isInkwFile(file: File): boolean` (extension `.inkw` or the `mimetype` bytes).

- [ ] **Step 1: Write the failing e2e** `e2e/inkw.mjs` (Chromium, Firefox, WebKit, like `e2e/share.mjs`; `npm run e2e:inkw`): draw 3 strokes and add a picture and a text box; Export → Save as .inkw (This page), capture the download; in a fresh context open it via the Insert menu file chooser: assert one new page with 3 strokes, 1 picture, 1 text. Repeat with scope Whole notebook and password `sesame`: opening prompts for a password, a wrong one imports nothing, the right one imports. Also pick a `.inkbackup` and a `.txt` through the same Open: a toast "Not an Inkwell file", nothing imported.
- [ ] **Step 2:** Run it against the preview server; expect failure (no menu item).
- [ ] **Step 3:** Implement the UI. File name `<title or notebook name> <yyyy-mm-dd>.inkw`. Show the byte size in the success toast and `skipped` strokes if any ("2 damaged strokes were left out"). The file picker input has no `accept` (desktop dialogs grey out unknown extensions; see `insert.ts`), and the type is checked after picking.
- [ ] **Step 4:** Run `npm run e2e:inkw`, `npm run e2e`, `npm run e2e:files`; expect no failures.
- [ ] **Step 5:** Commit `feat: save and open .inkw files`.

### Task 6: Back up everything writes `.inkw`

**Files:** Modify `src/backup-ui.ts`, `e2e/backup.mjs`.

**Interfaces:** Consumes Tasks 3-5. Produces: "Back up everything" writes `Inkwell backup <date>.inkw` (all notebooks, optional password); "Restore from a backup" accepts `.inkw` **and** legacy `.inkbackup`.

- [ ] **Step 1:** Update `e2e/backup.mjs`: the plain and locked backups are `.inkw`; add a case that restores a legacy `.inkbackup` produced by the previous code (commit one sample under `docs/inkw-golden/legacy.inkbackup`, made from the current `packBackup`) and expects 2 notebooks, 3 strokes. Run; expect failure on the new-name assertions.
- [ ] **Step 2:** Switch the writer to `toInkw` + `writeInkw`/`writeInkwLocked`; restore detects by magic (`PK` + `mimetype` entry text, or `INKWLK1\0`, or `INKWBK1\0`), never by name.
- [ ] **Step 3:** Run `npm run e2e:backup`; expect pass. Commit `feat: backups are .inkw files; old backups still restore`.

### Task 7: Python reader and cross-language check

**Files:** Create `tools/inkw.py`, `scripts/crosscheck-inkw.mjs`; Modify `package.json` (`"crosscheck:inkw"`).

**Interfaces:** Produces `tools/inkw.py`: `read(path) -> dict` (`manifest`, `notebooks`, `pages` with decoded `strokes` as lists of `(x, y, pressure)` floats, `blobs` names) and the command `python3 tools/inkw.py info FILE`. Stdlib only (`zipfile`, `json`, `struct`); about 150 lines.

- [ ] **Step 1:** Write `crosscheck-inkw.mjs`: for every file in `docs/inkw-golden/*.inkw`, run `python3 tools/inkw.py dump FILE` (JSON to stdout) and compare strokes against the Node decode within 1/128 px and 1/255 pressure; exit 1 on any difference; exit 0 with a notice if `python3` is absent. Run it; expect failure (no script).
- [ ] **Step 2:** Implement the reader, including the spec's limits and name checks and a clear `InkwError`-style exception; implement `dump` and `info`.
- [ ] **Step 3:** Run `npm run crosscheck:inkw`; expect pass. Add it to the CI workflow's test step (`.github/workflows/`; follow how the other checks are invoked there).
- [ ] **Step 4:** Commit `feat: python reader and cross-language check`.

### Task 8: Fuzz and hostile corpus

**Files:** Modify `src/inkw.check.ts`.

**Interfaces:** Consumes Tasks 2-3.

- [ ] **Step 1: Write the test** `fuzzNeverHangsOrCrashes`: with a seeded generator (`rng` from `pen-sim.ts`), take each golden file and apply 2,000 mutations in total (flip 1-8 random bytes, truncate at a random offset, duplicate a random slice, zero a random 16-byte span). For each mutation call `readInkw` and assert it either returns or throws `InkwError`; any other error type fails; each call must finish in under 1 s. Record the number that threw and the number that read, and print them.
- [ ] **Step 2:** Run; any non-`InkwError` exception or slow case is a reader bug: fix the reader (wrap `fflate` and `JSON.parse` failures into `InkwError('format')`), add the minimal failing mutation as a named regression test, and rerun until clean.
- [ ] **Step 3:** Commit `test: inkw fuzz and regression corpus`.

### Task 9: Measure on a realistic notebook, document, finish

**Files:** Create `scripts/inkw-measure.mjs`; Modify `README.md`, `src/about.ts`, `docs/plans/ink-format.md`.

- [ ] **Step 1:** Write `inkw-measure.mjs`: build a 500-page notebook (about 1,000,000 points total, 20 pictures of 200 KB each) from the pen simulator, write it, read it back, and print file size, bytes per point, write time and read time.
- [ ] **Step 2:** Run it. Acceptance: write and read each ≤ 5 s on this machine; ≤ 8 bytes per point overall. If either fails, write the numbers into `docs/plans/ink-format.md` as the trigger to evaluate SQLite and stop for the owner's decision; do not switch containers inside this plan.
- [ ] **Step 3:** Update the README ("Save as .inkw", "Open .inkw", the Python reader), the About algorithm list, and `ink-format.md` (phases 0-3 done, with the measured numbers).
- [ ] **Step 4:** Run the full gate: `npx biome check .`, `npx tsc --noEmit`, `npx tsc -p worker`, `npm run check`, `npm run crosscheck:inkw`, `npm run e2e`, `e2e:files`, `e2e:notes`, `e2e:shapes`, `e2e:backup`, `e2e:inkw`. All must pass.
- [ ] **Step 5:** Commit `docs: inkw saved, opened, measured`. Do not tag a release: the owner decides when.

---

## Self-Review

- **Spec coverage:** container, mimetype offset, schema, codec, versioning, lock, limits (Tasks 1-3, 0); app Save/Open and backups (5-6); Python reader (7); hostile files (3, 8); measurement and SQLite trigger (9); registry check and freeze (0). Deliberately not covered: OS association and converters (separate plans, named at the top).
- **Types:** `InkwError`, `InkwData`, `toInkw`/`fromInkw`, `writeInkw`/`readInkw`, `writeInkwLocked`/`readInkwLocked` are defined once and used with the same names in later tasks.
- **Proportion:** the plan states signatures, test names and spec values; function bodies appear nowhere.
