import { capture } from './dom';
import { inkTool, page, type Stroke, state, subscribe, uid, update } from './store';
import { cut, hits, inkColor, outline } from './stroke';
import { isPalm, pageIsDark, penSeen, redraw, touchCount, toWorld, view } from './viewport';

const MAX_HISTORY = 500;

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const live = document.querySelector<HTMLCanvasElement>('#live')!;
// The stroke in progress gets its own layer; `desynchronized` lets Chromium skip the compositor.
const ctx = live.getContext('2d', { desynchronized: true })!;
let dpr = devicePixelRatio;
new ResizeObserver(() => {
  dpr = devicePixelRatio;
  live.width = Math.round(live.clientWidth * dpr);
  live.height = Math.round(live.clientHeight * dpr);
}).observe(live);

// Windows Ink API (Edge/WebView2): the OS draws the trail under the pen tip between our frames.
interface InkPresenter {
  updateInkTrailStartPoint(e: PointerEvent, style: { color: string; diameter: number }): void;
}
type InkNavigator = Navigator & {
  ink?: { requestPresenter(o: { presentationArea: Element }): Promise<InkPresenter> };
};
let presenter: InkPresenter | null = null;
(navigator as InkNavigator).ink?.requestPresenter({ presentationArea: live }).then(
  (p) => {
    presenter = p;
  },
  () => {},
);

// --- Undo/redo: each entry is the page's whole stroke list (strokes are immutable, so it's cheap). ---
const history = new Map<string, { undo: Stroke[][]; redo: Stroke[][] }>();
function stacks() {
  let h = history.get(page().id);
  if (!h) {
    h = { undo: [], redo: [] };
    history.set(page().id, h);
  }
  return h;
}
export const inkTrailAvailable = () => presenter !== null;
export const lowLatencyCanvas = () => ctx.getContextAttributes().desynchronized === true;

export const canUndo = () => stacks().undo.length > 0;
export const canRedo = () => stacks().redo.length > 0;

function commit(before: Stroke[], after: Stroke[]) {
  if (before === after) return;
  const h = stacks();
  h.undo.push(before);
  if (h.undo.length > MAX_HISTORY) h.undo.shift();
  h.redo = [];
  update(() => {
    page().strokes = after;
  });
}

export function undo() {
  const h = stacks();
  const prev = h.undo.pop();
  if (!prev) return;
  h.redo.push(page().strokes);
  update(() => {
    page().strokes = prev;
  });
}

export function redo() {
  const h = stacks();
  const next = h.redo.pop();
  if (!next) return;
  h.undo.push(page().strokes);
  update(() => {
    page().strokes = next;
  });
}

// --- Drawing ---
type Mode = 'ink' | 'erase' | 'cut';
interface Gesture {
  id: number;
  mode: Mode;
  tool: Stroke['tool'];
  color: string;
  width: number;
  opacity: number;
  pressure: boolean;
  points: number[];
  before: Stroke[];
  /** Last raw pointer position in world space: the eraser sweeps from here. */
  last: { x: number; y: number; p: number } | null;
}
let active: Gesture | null = null;

function modeFor(e: PointerEvent): Mode | null {
  // Flipping the Surface Pen to its eraser end always erases.
  if (e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32)) return 'erase';
  if (e.button !== 0) return null;
  if (e.pointerType === 'touch' && (penSeen || isPalm(e) || touchCount() !== 1)) return null;
  if (state.tool === 'pen' || state.tool === 'highlighter') return 'ink';
  if (state.tool === 'eraser') return 'erase';
  if (state.tool === 'pixelEraser') return 'cut';
  return null; // lasso, text and ruler come next
}

const round = (n: number) => Math.round(n * 100) / 100;

function clearLive() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, live.width, live.height);
}

function eraseAt(a: Gesture, x: number, y: number, r: number): boolean {
  const before = page().strokes;
  const after =
    a.mode === 'erase'
      ? before.filter((s) => !hits(s, x, y, r))
      : before.flatMap((s) => cut(s, x, y, r, uid));
  if (after.length === before.length && after.every((s, i) => s === before[i])) return false;
  page().strokes = after; // committed to history on pointerup
  return true;
}

function addPoints(a: Gesture, e: PointerEvent) {
  const evs = e.getCoalescedEvents?.();
  const r = state.eraserWidth / 2 / view.scale;
  let changed = false;
  for (const ev of evs?.length ? evs : [e]) {
    const w = toWorld(ev.clientX, ev.clientY);
    const pr = ev.pressure || 0.5;
    const prev = a.last;
    a.last = { x: w.x, y: w.y, p: pr };
    if (a.mode === 'ink') {
      const n = a.points.length;
      if (!n) {
        a.points.push(round(w.x), round(w.y), round(pr));
        continue;
      }
      // Smooth once here so the saved stroke renders the same forever, even after erasing.
      const sx = a.points[n - 3]! + (w.x - a.points[n - 3]!) * state.tuning.smoothing;
      const sy = a.points[n - 2]! + (w.y - a.points[n - 2]!) * state.tuning.smoothing;
      if (Math.hypot(sx - a.points[n - 3]!, sy - a.points[n - 2]!) < 0.2) continue;
      a.points.push(round(sx), round(sy), round(pr));
      continue;
    }
    // Sweep the eraser along its path so fast moves don't skip over ink.
    const dist = prev ? Math.hypot(w.x - prev.x, w.y - prev.y) : 0;
    const steps = Math.min(200, Math.ceil(dist / (r / 2)) || 1);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const x = prev ? prev.x + (w.x - prev.x) * t : w.x;
      const y = prev ? prev.y + (w.y - prev.y) * t : w.y;
      if (eraseAt(a, x, y, r)) changed = true;
    }
  }
  if (changed) redraw();
  drawLive(a, e);
}

function drawLive(a: Gesture, e: PointerEvent) {
  clearLive();
  if (a.mode !== 'ink') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(e.offsetX, e.offsetY, state.eraserWidth / 2, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pageIsDark() ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
    ctx.stroke();
    return;
  }
  // Predicted points hide a frame of latency; they are drawn but never saved.
  let pts = a.points;
  const predicted = state.tuning.prediction ? (e.getPredictedEvents?.() ?? []) : [];
  if (predicted.length) {
    pts = pts.slice();
    for (const p of predicted) {
      const w = toWorld(p.clientX, p.clientY);
      pts.push(w.x, w.y, p.pressure || 0.5);
    }
  }
  const color = inkColor(a.color, pageIsDark());
  ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.x * dpr, view.y * dpr);
  ctx.globalAlpha = a.opacity;
  ctx.fillStyle = color;
  ctx.fill(outline(pts, a, false));
  if (presenter && state.tuning.inkTrail && a.tool === 'pen' && a.opacity === 1) {
    presenter.updateInkTrailStartPoint(e, {
      color,
      diameter: Math.max(1, a.width * view.scale * (e.pressure || 0.5)),
    });
  }
}

function finish(keep: boolean) {
  const a = active;
  if (!a) return;
  active = null;
  if (!keep) {
    page().strokes = a.before;
    redraw();
  } else if (a.mode === 'ink') {
    const { tool, color, width, opacity, pressure, points } = a;
    // Smoothing lags behind the pen; end exactly where it lifted.
    const n = points.length;
    if (a.last && n && (points[n - 3] !== round(a.last.x) || points[n - 2] !== round(a.last.y))) {
      points.push(round(a.last.x), round(a.last.y), round(a.last.p));
    }
    commit(a.before, [...a.before, { id: uid(), tool, color, width, opacity, pressure, points }]);
  } else {
    commit(a.before, page().strokes);
  }
  // Clear after the main canvas has painted the committed stroke, so it never blinks.
  requestAnimationFrame(clearLive);
}

bg.addEventListener('pointerdown', (e) => {
  if (active) return;
  const mode = modeFor(e);
  if (!mode) return;
  capture(bg, e.pointerId);
  const tool = inkTool(state.tool);
  active = {
    id: e.pointerId,
    mode,
    tool,
    ...state.styles[tool],
    pressure: e.pointerType === 'pen',
    points: [],
    before: page().strokes,
    last: null,
  };
  addPoints(active, e);
});

bg.addEventListener('pointermove', (e) => {
  if (active?.id === e.pointerId) addPoints(active, e);
});
bg.addEventListener('pointerup', (e) => {
  if (active?.id === e.pointerId) finish(true);
});
bg.addEventListener('pointercancel', (e) => {
  if (active?.id === e.pointerId) finish(false);
});
// A second finger means the user wants to pan, not draw.
bg.addEventListener('panstart', () => {
  if (active) finish(false);
});
// A touch that turned out to be a palm: undo whatever it drew or erased.
bg.addEventListener('palm', (e) => {
  if (active && active.id === (e as CustomEvent<number>).detail) finish(false);
});

// Eraser outline follows a hovering pen or mouse so you can see what will be erased.
bg.addEventListener('pointermove', (e) => {
  if (active || e.pointerType === 'touch') return;
  if (state.tool !== 'eraser' && state.tool !== 'pixelEraser') return;
  clearLive();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.arc(e.offsetX, e.offsetY, state.eraserWidth / 2, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = pageIsDark() ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)';
  ctx.stroke();
});
bg.addEventListener('pointerleave', () => {
  if (!active) clearLive();
});
let shownTool = state.tool;
subscribe(() => {
  if (state.tool !== shownTool && !active) clearLive(); // drop a stale eraser outline
  shownTool = state.tool;
});
