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
- **Lost on the canvas?** A _Back to your notes_ button appears whenever nothing on the page is on screen; Shift+1 (or the zoom chip menu) fits everything, Ctrl+0 returns to 100%.
- **Laser pointer (K):** a glowing red trail for presenting that fades from its tail after about a second; hovering shows the red dot. Never saved, never in undo.
- **Shapes:** draw a line, arrow, triangle, rectangle, circle or ellipse and hold the pen still for half a second to snap it clean (toggle with S).
- **Ruler (R):** straight lines that snap to 15° steps (always with Shift), with a live length/angle readout.
- **Text (T):** tap to type; tap a box to select, double-tap to edit, drag to move, drag the edge to resize; format bar for font, size, colour, bold, italic.
- **Lasso (L):** loop around ink and text to move, resize, rotate, recolour, copy/cut/paste/duplicate or delete.
- **Export (Ctrl+E):** PDF (this page, chosen pages or the whole notebook; fit-to-content, A4 or Letter; vector ink and real text) or PNG.

| Key         | Action                | Key                      | Action                |
| ----------- | --------------------- | ------------------------ | --------------------- |
| P           | Pen                   | Ctrl+Z / Ctrl+Y          | Undo / redo           |
| H           | Highlighter           | [ / ]                    | Thinner / thicker     |
| E / Shift+E | Stroke / pixel eraser | Tab                      | Hide toolbar          |
| L           | Lasso                 | Ctrl+\                   | Sidebar               |
| T           | Text box              | Ctrl+F                   | Search                |
| R           | Ruler                 | Ctrl+N                   | New page              |
| S           | Shape auto-snap       | Ctrl+0 / Ctrl+= / Ctrl+- | Reset / zoom in / out |

Not built yet: image/PDF import and file-based autosave (notes currently live in browser storage). PDF export uses the standard PDF fonts, so non-Latin text prints as "?".
