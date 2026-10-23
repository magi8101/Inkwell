import { getVersion } from '@tauri-apps/api/app';
import { Info, X } from 'lucide';
import { h, icon } from './dom';

// "About Inkwell": the version, and how the app works — every algorithm it uses, in plain words.

const ALGORITHMS: [string, string][] = [
  [
    'Low-latency wet ink',
    'The stroke being drawn lives on two extra layers above the page. The pen tip is redrawn on every pen sample, not once per frame, so ink stays under the pen. On Windows the system’s own ink trail (Windows Ink) does this.',
  ],
  [
    'Pen-tip prediction',
    'Fits a straight line through the last few pen positions (least squares, which averages out sensor jitter) and draws one frame ahead, hiding the screen’s delay. Uses the browser’s own predictions where it has them.',
  ],
  [
    'Smoothing and pressure',
    'Points are lightly smoothed as they arrive, then outlined with perfect-freehand so pressure sets the width. Very fast pens (240 Hz) are thinned first so strokes don’t come out lumpy.',
  ],
  [
    'Palm rejection',
    'A touch counts as a palm if the pen is near, if the contact is bigger than your palm-size setting, or if it lands while a palm is already down. Anything a palm drew is undone.',
  ],
  [
    'Shape snapping',
    'Hold the pen still at the end of a stroke. Corners are found with Ramer–Douglas–Peucker, the stroke is classified by being closed and its corner count (line, triangle, rectangle, polygon, star, circle), and the clean shape is used only if it fits.',
  ],
  [
    'Erasers',
    'The stroke eraser removes any stroke a circle around the tip touches. The pixel eraser cuts strokes where the circle crosses them and keeps the pieces as real strokes.',
  ],
  ['Ruler', 'Straight lines snap to every 15° when they are within a few degrees of it.'],
  [
    'Lasso',
    'Selects whatever is inside the loop you draw. Moving, resizing and rotating use one matrix transform applied to all the selected ink.',
  ],
  [
    'Pen calibration',
    'Measures your own pen: how often it reports, sensor noise, pressure range, speed, palm size, buttons and delay, and turns that into settings.',
  ],
  [
    'Handwriting to text',
    'Uses the browser’s Handwriting Recognition where available, otherwise draws the ink black on white and reads it with Tesseract on the device. Optional: a Cloudflare AI vision model reads it online.',
  ],
  [
    'Live sessions',
    'Each join code is one Cloudflare Durable Object that keeps the note and relays strokes and cursors between everyone in it.',
  ],
  [
    'Notebook folders',
    'Pages are saved as files on disk. A quick hash (FNV-1a) of each file notices what changed outside the app.',
  ],
  [
    'OneNote and PDF import',
    'OneNote sections are read by a Rust importer compiled to WebAssembly, off the main thread. PDF pages are drawn with pdf.js.',
  ],
  ['Code blocks', 'Code is compiled and run on Compiler Explorer (godbolt.org) for free.'],
  [
    'Updates',
    'Installers are signed with Inkwell’s key. The app checks the newest release and only installs a download whose signature matches.',
  ],
];

export function openAbout() {
  const version = h('p', { class: 'cal-text' }, 'Website — always the newest version.');
  if ('__TAURI_INTERNALS__' in window)
    void getVersion().then((v) => {
      version.textContent = `Version ${v}`;
    });
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const close = () => {
    overlay.remove();
    removeEventListener('keydown', onKey);
  };
  const overlay = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'cal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About Inkwell' },
      h(
        'header',
        { class: 'cal-head' },
        icon(Info, 18),
        h('span', { style: 'flex: 1' }, 'About Inkwell'),
        h(
          'button',
          { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: close },
          icon(X, 18),
        ),
      ),
      h(
        'div',
        { class: 'cal-body' },
        version,
        h('h2', { class: 'cal-title' }, 'How it works'),
        h(
          'dl',
          { class: 'about-list' },
          ...ALGORITHMS.flatMap(([name, text]) => [h('dt', {}, name), h('dd', {}, text)]),
        ),
      ),
    ),
  );
  document.body.append(overlay);
  addEventListener('keydown', onKey);
}
