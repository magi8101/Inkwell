# Inkwell features

What exists today, and what could come next. Updated 2026-10-29 (app version 0.2.6).

## Shipped

**Writing**
- Pen, highlighter, stroke eraser, pixel eraser, lasso, ruler, laser pointer, text boxes, shapes
  (rectangle, ellipse, diamond, line, arrow with four head sizes).
- Pressure, tilt, hover, palm rejection, side button and eraser end, prediction, a low-latency canvas
  (Auto, Low-latency or Standard), and a pen calibration that fits smoothing, speed, pressure range
  and stroke-start spikes to your own pen, including rubber-tip styluses.
- Recent custom colours, an eyedropper, saved favourite pens.

**Pages and notes**
- Notebooks, folders (nested), pages; infinite canvas or A4, A3 or Letter; templates (Cornell, music
  staff, graph, your own picture).
- Markdown notes with `[[page links]]`, tables, task lists, code blocks that run on Compiler Explorer.
- Handwriting to text, and search that finds your handwriting (on this device).

**Files**
- `.inkw` files: save a page, folder, notebook or everything in one file with its pictures, optionally
  locked with a password; readable without Inkwell (`docs/inkw-spec.md`, `tools/inkw.py`).
- Open PDFs as one long page (or one page per PDF page), OneNote sections, Excalidraw files, zips and
  folders; save back to Excalidraw.
- Export as PDF, PNG or SVG; copy a selection as a picture; stamps (reusable selections).
- Back up everything to one file; old backups still restore.
- Read-only share links (encrypted in the browser, the key never leaves the link), and live sessions.

**Everywhere**
- Website (including iPad), Windows, macOS, Linux and Android apps, with updates from within the app.
- A "Report a problem" text report for testers, and a pen report from the calibration.

## Candidates for next

Small
- Report a problem in a more visible place (main menu).
- Protractor on the ruler.
- A stronger scroll hint on the phone toolbar.
- Page thumbnails written into `.inkw` files.

Medium
- Double-click and "open with" for `.inkw` on every OS (needs real machines to test).
- A routine test workflow on GitHub (the checks and browser tests currently run by hand).
- Ink on Markdown notes.
- Continuous scrolling pages for paper notebooks.
- Pen textures (fountain, brush, pencil).
- Layers; tags and bookmarks; a PDF text layer so imported PDFs are searchable.
- Hold a drawn line to make it a real, editable shape.

Large
- Audio recording linked to ink.
- Google Drive sync (needs an OAuth client set up once).
- Handwriting to maths (LaTeX).
- Converters: in from `.xopp`, out to InkML.
- A Chromium-based desktop build for Linux, if pen problems there keep coming.
