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

## Using it

- **Pen draws, fingers navigate.** Until a pen is detected, one finger (or the mouse) draws; two fingers pan and pinch-zoom. Middle mouse pans, Ctrl+wheel zooms.
- **Palm rejection:** touch is ignored while the pen hovers and for a short time after; large or spreading contacts are palms for their whole lifetime, and so are fingers that land next to a resting palm.
- **Pen feel panel** (gauge button, Ctrl+Shift+D): smoothing, pressure, pressure curve, palm size and pen grace time, plus live pressure/contact/sample-rate readings to tune on your own device.
- **Pen side button** or right-click opens the radial tool and colour picker.

| Key         | Action                | Key                      | Action                |
| ----------- | --------------------- | ------------------------ | --------------------- |
| P           | Pen                   | Ctrl+Z / Ctrl+Y          | Undo / redo           |
| H           | Highlighter           | [ / ]                    | Thinner / thicker     |
| E / Shift+E | Stroke / pixel eraser | Tab                      | Hide toolbar          |
| L           | Lasso                 | Ctrl+\                   | Sidebar               |
| T           | Text box              | Ctrl+F                   | Search                |
| R           | Ruler                 | Ctrl+N                   | New page              |
| S           | Shape auto-snap       | Ctrl+0 / Ctrl+= / Ctrl+- | Reset / zoom in / out |

Not built yet: lasso, text boxes, ruler, shape snapping, image/PDF import, export, and file-based autosave (notes currently live in browser storage).
