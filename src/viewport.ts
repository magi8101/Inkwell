import { capture } from './dom';
import { type Background, type Page, page, state, subscribe } from './store';
import { drawStroke, drawTextBox, setRenderTuning } from './stroke';

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
  return c === 'auto'
    ? getComputedStyle(document.documentElement).getPropertyValue('--page').trim()
    : c;
}

function isDark(hex: string): boolean {
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
  view.x = 0;
  view.y = 0;
  view.scale = 1;
  redraw();
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
const tooBig = (e: PointerEvent) => Math.max(e.width, e.height) > state.tuning.palmPx;

const palms = new Set<number>();
const touches = new Map<number, { x: number; y: number }>();
let mousePan: { x: number; y: number } | null = null;

export const isPalm = (e: PointerEvent) =>
  e.pointerType === 'touch' && (palms.has(e.pointerId) || penNear(e.timeStamp) || tooBig(e));
export const touchCount = () => touches.size;

/** Marks a touch as a palm and tells the ink layer to drop anything that touch started. */
function rejectTouch(id: number) {
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
    if (palms.size || isPalm(e)) {
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
  touches.delete(e.pointerId);
  palms.delete(e.pointerId);
  if (e.pointerType === 'mouse') mousePan = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01));
    } else {
      view.x -= e.shiftKey ? e.deltaY : e.deltaX;
      view.y -= e.shiftKey ? 0 : e.deltaY;
      redraw();
    }
  },
  { passive: false },
);

zoomChip.addEventListener('click', resetView);

let shownPage = '';
subscribe(() => {
  setRenderTuning(state.tuning.thinning, state.tuning.pressureGamma);
  if (page().id !== shownPage) {
    shownPage = page().id;
    resetView();
  }
  redraw();
});
shownPage = page().id;
