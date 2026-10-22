import { Locate, Maximize, Scan, ZoomIn, ZoomOut } from 'lucide';
import { capture, h, icon, openMenu } from './dom';
import { drawImages, imageBox, onImageLoaded } from './images';
import { type Background, type Page, page, state, subscribe } from './store';
import { bbox as bboxOf, drawStroke, drawTextBox, setRenderTuning } from './stroke';

const GRID = 32;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

export const view = { x: 0, y: 0, scale: 1 };

const canvas = document.querySelector<HTMLCanvasElement>('#bg')!;
const ctx = canvas.getContext('2d', { alpha: false })!;
const zoomChip = document.querySelector<HTMLButtonElement>('#zoom')!;
const textLayer = document.querySelector<HTMLDivElement>('#texts')!;
let rect = canvas.getBoundingClientRect();
let dpr = devicePixelRatio;
let queued = false;

export function pageColor(c: string): string {
  if (c !== 'auto') return c;
  // The CSS minifier shortens #ffffff to #fff; everything that reads a page colour expects 6 digits.
  const css = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  return /^#[\da-f]{3}$/i.test(css) ? `#${[...css.slice(1)].map((d) => d + d).join('')}` : css;
}

export function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

const mod = (a: number, b: number) => ((a % b) + b) % b;

/** Paints the page colour and pattern. All values are in device pixels. */
export function drawBackground(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: Background,
  color: string,
  v: { x: number; y: number; scale: number },
  px = 1,
) {
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  if (bg === 'blank') return;
  let step = GRID * v.scale;
  while (step < 12 * px) step *= 2; // drop detail when zoomed far out
  c.fillStyle = isDark(color) ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)';
  const ox = mod(v.x, step);
  const oy = mod(v.y, step);
  if (bg === 'dots') {
    const r = Math.max(px, Math.min(2.5 * px, 1.5 * v.scale));
    for (let y = oy; y < h; y += step) {
      for (let x = ox; x < w; x += step) c.fillRect(x - r / 2, y - r / 2, r, r);
    }
    return;
  }
  for (let y = oy; y < h; y += step) c.fillRect(0, Math.round(y), w, px);
  if (bg === 'grid') for (let x = ox; x < w; x += step) c.fillRect(Math.round(x), 0, px, h);
}

/** Background plus every stroke, for the main canvas and for thumbnails. */
export function drawPage(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: Page,
  v: { x: number; y: number; scale: number },
  px = 1,
  withText = true,
) {
  const color = pageColor(p.pageColor);
  drawBackground(c, w, h, p.background, color, v, px);
  c.save();
  c.setTransform(v.scale, 0, 0, v.scale, v.x, v.y);
  const dark = isDark(color);
  drawImages(c, p.images); // pictures sit under all ink, like printouts on paper
  // Highlighter sits under pen ink, like a real highlighter on paper.
  for (const s of p.strokes) if (s.tool === 'highlighter') drawStroke(c, s, dark);
  for (const s of p.strokes) if (s.tool !== 'highlighter') drawStroke(c, s, dark);
  if (withText) for (const t of p.texts) drawTextBox(c, t, dark);
  c.restore();
}

export const pageIsDark = () => isDark(pageColor(page().pageColor));

export const toWorld = (clientX: number, clientY: number) => ({
  x: (clientX - rect.left - view.x) / view.scale,
  y: (clientY - rect.top - view.y) / view.scale,
});

function render() {
  queued = false;
  drawPage(
    ctx,
    canvas.width,
    canvas.height,
    page(),
    { x: view.x * dpr, y: view.y * dpr, scale: view.scale * dpr },
    dpr,
    false, // the live page shows text as editable boxes instead
  );
  textLayer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomChip.textContent = `${Math.round(view.scale * 100)}%`;
  updateLost();
}

export function redraw() {
  if (!queued) {
    queued = true;
    requestAnimationFrame(render);
  }
}

function zoomAt(cx: number, cy: number, factor: number) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
  const f = next / view.scale;
  view.x = cx - (cx - view.x) * f;
  view.y = cy - (cy - view.y) * f;
  view.scale = next;
  redraw();
}

export const zoomBy = (f: number) => zoomAt(rect.width / 2, rect.height / 2, f);

export function resetView() {
  cancelAnimationFrame(anim);
  view.x = 0;
  view.y = 0;
  view.scale = 1;
  redraw();
}

// --- Smooth view moves, fit to content, and "back to your notes" ---

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let anim = 0;

function animateTo(target: { x: number; y: number; scale: number }, ms = 320) {
  cancelAnimationFrame(anim);
  if (reducedMotion.matches) {
    Object.assign(view, target);
    redraw();
    return;
  }
  const from = { ...view };
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const k = 1 - (1 - t) ** 3; // ease-out
    // Interpolate zoom in log space so it feels even at every scale.
    const scale = from.scale * (target.scale / from.scale) ** k;
    const mid = (a: number, b: number) => a + (b - a) * k;
    view.scale = scale;
    view.x = mid(from.x, target.x);
    view.y = mid(from.y, target.y);
    render();
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

const boxCache = new WeakMap<
  Page['strokes'],
  { texts: Page['texts']; images: Page['images']; box: number[] | null }
>();
/** World-space box around the page's ink and text, or null for an empty page. */
function contentBox(p: Page): number[] | null {
  const hit = boxCache.get(p.strokes);
  if (hit && hit.texts === p.texts && hit.images === p.images) return hit.box;
  let b: number[] | null = null;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    b = b
      ? [Math.min(b[0]!, x0), Math.min(b[1]!, y0), Math.max(b[2]!, x1), Math.max(b[3]!, y1)]
      : [x0, y0, x1, y1];
  };
  for (const s of p.strokes) {
    const k = bboxOf(s);
    grow(k[0], k[1], k[2], k[3]);
  }
  for (const im of p.images) {
    const k = imageBox(im);
    grow(k[0], k[1], k[2], k[3]);
  }
  // Text height is approximate (explicit lines only); good enough to frame it.
  for (const t of p.texts)
    grow(t.x, t.y, t.x + t.w, t.y + t.text.split('\n').length * t.size * 1.3);
  boxCache.set(p.strokes, { texts: p.texts, images: p.images, box: b });
  return b;
}

const FIT_PAD = 56;
const FIT_MAX_ZOOM = 2;

export function fitContent() {
  const b = contentBox(page());
  if (!b) {
    animateTo({ x: 0, y: 0, scale: 1 });
    return;
  }
  const w = Math.max(1, b[2]! - b[0]!);
  const hgt = Math.max(1, b[3]! - b[1]!);
  const scale = Math.min(
    FIT_MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min((rect.width - FIT_PAD * 2) / w, (rect.height - FIT_PAD * 2) / hgt)),
  );
  animateTo({
    x: rect.width / 2 - (b[0]! + w / 2) * scale,
    y: rect.height / 2 - (b[1]! + hgt / 2) * scale,
    scale,
  });
}

export const actualSize = () => {
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  animateTo({
    x: cx - ((cx - view.x) / view.scale) * 1,
    y: cy - ((cy - view.y) / view.scale) * 1,
    scale: 1,
  });
};

const lostBtn = h(
  'button',
  {
    class: 'chip lost',
    hidden: true,
    title: 'Zoom to fit your notes (Shift+1)',
    onclick: fitContent,
  },
  icon(Locate, 16),
  h('span', {}, 'Back to your notes'),
);
canvas.parentElement!.append(lostBtn);

/** Shows the button only when the page has content and none of it is on screen. */
function updateLost() {
  const b = contentBox(page());
  const off =
    !!b &&
    (b[2]! * view.scale + view.x < 0 ||
      b[0]! * view.scale + view.x > rect.width ||
      b[3]! * view.scale + view.y < 0 ||
      b[1]! * view.scale + view.y > rect.height);
  lostBtn.hidden = !off;
}

new ResizeObserver(() => {
  rect = canvas.getBoundingClientRect();
  dpr = devicePixelRatio;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  render();
}).observe(canvas);

// --- Palm rejection ---
// Fingers never draw once a pen has been seen; until then (mouse, phone, touchscreen laptop) one
// finger draws and two fingers pan/zoom. A touch is a palm if the pen is near, if it is (or grows)
// bigger than the palm size, or if it lands while another palm is down (the resting hand's fingers).
// Palm verdicts are sticky for the life of that touch.
let lastPen = Number.NEGATIVE_INFINITY;
export let penSeen = false;
for (const type of ['pointerover', 'pointermove', 'pointerdown'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (e.pointerType === 'pen') {
        lastPen = e.timeStamp;
        penSeen = true;
      }
    },
    { capture: true, passive: true },
  );
}
export const penNear = (t: number) => t - lastPen < state.tuning.penGraceMs;
/** Contact bigger than a fingertip (the palm size setting). */
export const tooBig = (e: PointerEvent) => Math.max(e.width, e.height) > state.tuning.palmPx;

const palms = new Set<number>();
const touches = new Map<number, { x: number; y: number }>();
let mousePan: { x: number; y: number } | null = null;

export const isPalm = (e: PointerEvent) =>
  e.pointerType === 'touch' && (palms.has(e.pointerId) || penNear(e.timeStamp) || tooBig(e));
export const touchCount = () => touches.size;

// Tap chords: two fingers = undo, three = redo, with single taps. GoodNotes needs double taps
// because single ones misfired on palms; here a chord only counts if every finger lands within
// TAP_LAND_MS, none is a palm or near the pen, none moves more than TAP_SLOP and all lift within
// TAP_MAX_MS. Any small pan the fingers caused is undone too.
const TAP_LAND_MS = 120;
const TAP_MAX_MS = 280;
const TAP_SLOP = 12;
let chord: {
  start: number;
  live: Set<number>;
  max: number;
  origin: Map<number, { x: number; y: number }>;
  spoiled: boolean;
  view: { x: number; y: number; scale: number };
} | null = null;

function chordDown(e: PointerEvent, palm: boolean) {
  if (!chord || (!chord.live.size && !touches.size)) {
    chord = {
      start: e.timeStamp,
      live: new Set(),
      max: 0,
      origin: new Map(),
      spoiled: false,
      view: { ...view },
    };
  }
  if (palm || e.timeStamp - chord.start > TAP_LAND_MS) chord.spoiled = true;
  chord.live.add(e.pointerId);
  chord.origin.set(e.pointerId, { x: e.clientX, y: e.clientY });
  chord.max = Math.max(chord.max, chord.live.size);
}

function chordUp(e: PointerEvent, cancelled: boolean) {
  if (!chord?.live.has(e.pointerId)) return;
  chord.live.delete(e.pointerId);
  if (cancelled || e.timeStamp - chord.start > TAP_MAX_MS) chord.spoiled = true;
  if (chord.live.size) return;
  const c = chord;
  chord = null;
  if (c.spoiled || c.max < 2 || c.max > 3 || !state.tuning.tapGestures) return;
  Object.assign(view, c.view);
  redraw();
  canvas.dispatchEvent(new CustomEvent('tapgesture', { detail: c.max }));
}

/** Marks a touch as a palm and tells the ink layer to drop anything that touch started. */
function rejectTouch(id: number) {
  if (chord) chord.spoiled = true;
  palms.add(id);
  touches.delete(id);
  canvas.dispatchEvent(new CustomEvent('palm', { detail: id }));
}

function gesture() {
  const pts = [...touches.values()];
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const [a, b] = pts;
  const d = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  return { cx, cy, d };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    const palm = palms.size > 0 || isPalm(e);
    chordDown(e, palm);
    if (palm) {
      palms.add(e.pointerId);
      return;
    }
    touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    capture(canvas, e.pointerId);
    // A second finger turns a one-finger drawing into a pan/zoom.
    if (penSeen || touches.size > 1) canvas.dispatchEvent(new Event('panstart'));
  } else if (e.pointerType === 'mouse' && e.button === 1) {
    e.preventDefault();
    mousePan = { x: e.clientX, y: e.clientY };
    capture(canvas, e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (mousePan && e.pointerType === 'mouse') {
    view.x += e.clientX - mousePan.x;
    view.y += e.clientY - mousePan.y;
    mousePan = { x: e.clientX, y: e.clientY };
    redraw();
    return;
  }
  const o = chord?.origin.get(e.pointerId);
  if (chord && o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > TAP_SLOP) chord.spoiled = true;
  if (!touches.has(e.pointerId)) return;
  // Palms often land small and spread; re-check every move, and drop everything if the pen arrives.
  if (penNear(e.timeStamp)) {
    for (const id of [...touches.keys()]) rejectTouch(id);
    return;
  }
  if (tooBig(e)) {
    rejectTouch(e.pointerId);
    return;
  }
  const before = gesture();
  touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  if (!penSeen && touches.size < 2) return; // that finger is drawing
  const after = gesture();
  view.x += after.cx - before.cx;
  view.y += after.cy - before.cy;
  if (before.d && after.d) zoomAt(after.cx, after.cy, after.d / before.d);
  redraw();
});

const endPointer = (e: PointerEvent) => {
  if (e.pointerType === 'touch') chordUp(e, e.type === 'pointercancel');
  touches.delete(e.pointerId);
  palms.delete(e.pointerId);
  if (e.pointerType === 'mouse') mousePan = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Wheel deltas come in pixels, lines (Firefox on Linux for mouse wheels) or pages; without
// normalising, a Ctrl+wheel notch in Firefox zoomed ~3% and looked broken.
const LINE_PX = 16;
const wheelPx = (d: number, mode: number) =>
  mode === WheelEvent.DOM_DELTA_LINE
    ? d * LINE_PX
    : mode === WheelEvent.DOM_DELTA_PAGE
      ? d * rect.height
      : d;
let safariPinch = false;

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const dx = wheelPx(e.deltaX, e.deltaMode);
    const dy = wheelPx(e.deltaY, e.deltaMode);
    // Trackpad pinch arrives as Ctrl+wheel (Chrome, Edge, Firefox); Cmd+scroll zooms on macOS.
    if (e.ctrlKey || e.metaKey) {
      if (safariPinch) return; // Safari already reported this pinch as a gesture
      const factor = Math.min(2, Math.max(0.5, Math.exp(-dy * 0.01)));
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    } else {
      view.x -= e.shiftKey ? dy : dx;
      view.y -= e.shiftKey ? 0 : dy;
      redraw();
    }
  },
  { passive: false },
);

// Safari and macOS/WKWebView report trackpad pinch only as (non-standard) gesture events, with a
// cumulative scale. Prevent them everywhere so Safari doesn't zoom the whole page instead.
type GestureLike = Event & { scale: number; clientX: number; clientY: number };
let gestureScale = 1;
addEventListener('gesturestart', (e) => {
  e.preventDefault();
  safariPinch = true;
  gestureScale = 1;
});
addEventListener('gesturechange', (e) => {
  e.preventDefault();
  const g = e as GestureLike;
  if (!g.scale || !canvas.parentElement!.contains(e.target as Node)) return;
  zoomAt(g.clientX - rect.left, g.clientY - rect.top, g.scale / gestureScale);
  gestureScale = g.scale;
});
addEventListener('gestureend', (e) => {
  e.preventDefault();
  safariPinch = false;
});

zoomChip.addEventListener('click', () =>
  openMenu(zoomChip, [
    { label: 'Fit to content (Shift+1)', icon: Maximize, run: fitContent },
    { label: 'Actual size (Ctrl+0)', icon: Scan, run: actualSize },
    { label: 'Zoom in (Ctrl+=)', icon: ZoomIn, run: () => zoomBy(1.25) },
    { label: 'Zoom out (Ctrl+-)', icon: ZoomOut, run: () => zoomBy(0.8) },
  ]),
);

let shownPage = '';
onImageLoaded(() => redraw());

subscribe(() => {
  setRenderTuning(state.tuning.thinning, state.tuning.pressureGamma);
  if (page().id !== shownPage) {
    shownPage = page().id;
    resetView();
  }
  redraw();
});
shownPage = page().id;
