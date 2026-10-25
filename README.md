# Inkwell

Pen-first handwritten notes for Windows (built for Surface Pro 7 + Surface Pen). Tauri 2 desktop app with a Vite + TypeScript front end; the same front end also runs in a browser.

## Run

```sh
npm install
npm run web        # browser only, http://localhost:1420
npm run dev        # desktop window (Tauri), needs Rust
```

## Build

```sh
npm run build      # Windows installer (.exe, NSIS) in src-tauri/target/release/bundle/nsis
npm run web:build  # static site in dist/
npm run deploy     # web build to Cloudflare (wrangler.jsonc)
```

The Windows installer must be built on Windows (or with a cross-compile toolchain).

## Checks

```sh
npm run lint       # Biome, TypeScript, rustfmt, clippy (warnings fail)
npm run check      # eraser geometry self-test
npm run format     # auto-fix formatting
```

## Low-latency ink

Modelled on Windows Ink, which draws "wet" ink on a high-priority path and "dries" it later:
- **Windows (Edge/Chrome/WebView2):** the OS ink trail (`navigator.ink`) draws the newest segment in the system compositor, as Microsoft designed it.
- **macOS, Linux and other browsers:** two wet-ink layers. The full pressure stroke is redrawn each frame; a fast tip from its end to the newest raw pen sample (`pointerrawupdate` where supported) plus a predicted lead is redrawn on every sample, on a `desynchronized` canvas. Prediction is a least-squares velocity fit (`src/predict.ts`) used when the browser offers none; tune it with _Predict_ in the Pen feel panel.
- **Drying off the input path:** saving and the sidebar refresh run when idle (and are flushed when the page is hidden), so lifting the pen costs well under a millisecond and never delays the next stroke.

## Using it

- **Pen draws, fingers navigate.** Until a pen is detected, one finger (or the mouse) draws; two fingers pan and pinch-zoom. Middle mouse pans, Ctrl+wheel zooms.
- **Palm rejection:** touch is ignored while the pen hovers and for a short time after; large or spreading contacts are palms for their whole lifetime, and so are fingers that land next to a resting palm.
- **Pen feel panel** (gauge button, Ctrl+Shift+D): smoothing, pressure, pressure curve, palm size and pen grace time, plus live pressure/contact/sample-rate readings to tune on your own device.
- **Pen side button:** tap it for the tool and colour ring at the pen tip; hold it and drag to erase (pixel erase or menu-only in the Pen feel panel). Right-click also opens the ring.
- **Finger taps:** tap with two fingers to undo, three to redo (single taps; palms, slow or moving taps and taps right after the pen are ignored). If three-finger taps open Windows search instead, turn off _Settings → Bluetooth & devices → Touch → Three- and four-finger touch gestures_.
- **Zoom:** pinch on a touchscreen or trackpad (including Safari/macOS gestures), Ctrl/Cmd+scroll, or Ctrl/Cmd + `=`/`-`/`0` on any keyboard layout.
- **Lost on the canvas?** A _Back to your notes_ button appears whenever nothing on the page is on screen; Shift+1 (or the zoom chip menu) fits everything, Ctrl+0 returns to 100%.
- **Laser pointer (K):** a glowing red trail for presenting that fades from its tail after about a second; hovering shows the red dot. Never saved, never in undo.
- **Shapes:** draw a line, arrow, triangle, rectangle, circle or ellipse and hold the pen still for half a second to snap it clean (toggle with S).
- **Ruler (R):** straight lines that snap to 15° steps (always with Shift), with a live length/angle readout.
- **Text (T):** tap to type; tap a box to select, double-tap to edit, drag to move, drag the edge to resize; format bar for font, size, colour, bold, italic.
- **Lasso (L):** loop around ink and text to move, resize, rotate, recolour, copy/cut/paste/duplicate or delete.
- **Pictures:** Insert → _Picture from files…_ or _Paste picture_ (works on iPad: copy in Photos, then paste), drag one onto the page, or Ctrl/⌘+V. Pictures sit under the ink; select them with the lasso to move, resize, rotate, copy or delete — ink drawn on them moves with them.
- **OneNote:** Insert → _OneNote section (.one)…_ (or drag a `.one` file onto the page) opens it as a new, editable section — handwriting with pressure, colour and pen size, text as text boxes, and pictures. Both OneNote formats work (desktop OneNote 2010–2016 and OneDrive downloads). Export a section from OneNote for Windows with _File → Export → Section_. The importer is Rust compiled to WebAssembly (`onenote/`, rebuild with `npm run build:onenote`), using a vendored, MPL-2.0 `onenote_parser` patched to keep pen pressure; see `docs/research/onenote-format.md`.
- **Markdown notes:** the sidebar's note button (next to + under Pages), Insert → _Markdown file (.md)…_ or dropping a `.md` file. Typed pages that format as you type (`# ` heading, `**bold**`, `- ` list, `[ ] ` checkbox, fenced code blocks, tables), saved as Markdown and exported as `.md`. They name themselves after their first line. In a notebook kept in a folder, notes are saved as plain `<title>.md` files, and `.md` files already there (an Obsidian vault, say) open as notes and stay in sync both ways. Shared in live sessions (whole note, last edit wins). Export a note as `.md` or as PDF pages (headings, styled text, lists, checkboxes, code, quotes, tables, pictures). Not yet: ink on notes.
- **Links between pages:** in a Markdown note, type `[[Page name]]` (or `[[Page name|shown text]]`) to make a link; clicking it opens that page, or creates a note with that name when there isn't one. The file keeps plain `[[…]]` text, so it reads the same in Obsidian. A folder's ⋯ menu → _Make a contents page_ writes a note listing its pages (and folders) as links.
- **Search handwriting:** Pen feel → _Search handwriting_ (off by default) reads each page's ink as text on your device in the background (a few seconds after you stop writing, one page at a time, never online) and keeps it with the page, so the sidebar search finds what you wrote. Matching is forgiving: spaces and punctuation are ignored, and longer words may have a letter or two misread. Tesseract is built for print, so tidy writing is found best; the first read downloads its language data once.
- **Canvas:** Pen feel → _Canvas_: Auto (the low-latency canvas, which draws ink straight to the screen, wherever it is safe: not on Windows, where Windows' own ink trail is faster, and not on Android, where it can paint the page black), _Low-latency_ (force it on; try it if your Android or Windows device shows ink fine) or _Standard_. Safari and iPad ignore the low-latency canvas whatever is chosen. Changing it reloads the page.
- **Back up everything:** About → _Back up everything…_ saves every notebook with its pictures to one `.inkbackup` file, optionally locked with a password (AES-256, there is no way to recover a lost password). _Restore from a backup…_ adds the notebooks in a file next to yours, never replacing anything. **Report a problem…** (also in About) gathers a text report of the device and settings, never what you wrote, to copy or share. The pen panel keeps your recent custom colours.
- **PDFs:** Insert → _PDF (to write on)…_ (or drop one) opens the whole PDF as one long page, its pages stacked top to bottom, in a new folder named after the file, ready to write on. _PDF, one notebook page per PDF page…_ keeps the old one-page-per-PDF-page layout.
- **Zips and folders:** drop a zip or a folder on the page, or Insert → _Zip file…_ / _Folder…_. Inkwell lists the Markdown notes, PDFs and pictures inside, then imports them (the folder structure becomes sidebar folders; pictures a note shows stay in the note) or shows them in a read-only viewer without saving anything. A folder dropped or picked in Chrome, Edge or Brave stays linked while Inkwell is open: notes changed in another app update here (if a note was also changed in Inkwell, Inkwell's version is kept and you're told), and new notes appear.
- **Paper size:** Page style → _Size_: an infinite canvas (the default), or a sheet of A4, A3 or Letter, portrait or landscape, drawn at real size with its lines/grid/dots on the sheet. New pages come on the same paper, and a sheet exports to PDF at exactly its size.
- **Shapes (O):** the Shapes tool draws rectangles, ellipses, diamonds, lines and arrows (Shift for squares, circles and 15° lines) in the pen's colour and width, with no fill, a light tint, solid or hatched, and solid, dashed or dotted lines. Points snap to the edges and centres of other shapes (guide lines show it). An arrow that starts or ends on a shape stays attached when you move it. Select with the lasso: move, resize, rotate, copy, recolour, and from the bar **Shape style** and **Arrange** (bring to front, send to back, group, lock, align, distribute). The stroke eraser takes shapes too (not locked ones). Arrow heads come in four sizes (the Shapes panel for the next arrow, or _Shape style_ for selected ones). Shapes are shared in live sessions and exported as vector paths in PDFs.
- **Colour picker:** the colour panel's pipette picks a colour from the page (Chromium's own eyedropper, elsewhere a tap on the page). **`?`** lists every keyboard shortcut.
- **Share a read-only link:** Export → _Share a read-only link…_ uploads the page encrypted (AES-256-GCM, in your browser) and gives a link anyone can open to view it, pan and zoom, and keep a copy. The key is only in the link after `#`, so the server can't read the page. Links last 30 days or until you delete them (the dialog lists the ones made on this device). Up to 6 MB per page.
- **Excalidraw files:** Insert → _Excalidraw drawing (.excalidraw)…_ (or drop one on the page) opens it as a new page: rectangles, ellipses and diamonds (fill colour, hatching, dashes, groups, locks, turn), lines and arrows (bindings to shapes kept), freehand strokes (pressure kept), text and pictures; frames and embeds are left out, and Excalidraw's hand-drawn roughness isn't kept. Export → _Save page as .excalidraw_ writes the page back out, for Excalidraw and its Obsidian plugin.
- **Stamps:** select something with the lasso and tap _Save as stamp_ on its bar; Insert → _Stamps_ lists them (with previews, kept on this device) and puts a copy in the middle of the screen, selected, ready to move.
- **Templates:** Page style → _Template_: Cornell notes (title band, cue column, notes, summary), music paper (five-line staves), graph paper (16 px grid, every fifth line stronger) or your own background _Picture_, each on a sheet of paper (A4 unless you've set another size). The ruling is one description drawn identically on screen, in thumbnails, PNGs and PDFs.
- **Export (Ctrl+E):** PDF (this page, chosen pages or the whole notebook; fit-to-content, A4 or Letter; vector ink and real text), PNG, or SVG (the page as vector paths, shapes, pictures and text in one file). With a selection, the bar's _Copy as a picture_ puts it on the clipboard as a PNG to paste into chats and documents.

| Key         | Action                | Key                      | Action                |
| ----------- | --------------------- | ------------------------ | --------------------- |
| P           | Pen                   | Ctrl+Z / Ctrl+Y          | Undo / redo           |
| H           | Highlighter           | [ / ]                    | Thinner / thicker     |
| E / Shift+E | Stroke / pixel eraser | Tab                      | Hide toolbar          |
| L           | Lasso                 | Ctrl+\                   | Sidebar               |
| T           | Text box              | Ctrl+F                   | Search                |
| R           | Ruler                 | Ctrl+N                   | New page              |
| S           | Shape auto-snap       | Ctrl+0 / Ctrl+= / Ctrl+- | Reset / zoom in / out |

Notes are stored on the device in IndexedDB (older browser-storage notes migrate automatically). PDF export uses the standard PDF fonts, so non-Latin text prints as "?".
