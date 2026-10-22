import { capture, h } from './dom';
import { densify, recognize } from './shape';
import { inkTool, page, type Stroke, state, subscribe, type TextBox, uid, update } from './store';
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

// --- Undo/redo: each entry is a snapshot of the page's strokes and text boxes. Both lists are
// replaced, never mutated, so a snapshot is just two array references. ---
export interface Snapshot {
  strokes: Stroke[];
  texts: TextBox[];
}
const history = new Map<string, { undo: Snapshot[]; redo: Snapshot[] }>();
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
export const snapshot = (): Snapshot => ({ strokes: page().strokes, texts: page().texts });

function restore(s: Snapshot) {
  update(() => {
    page().strokes = s.strokes;
    page().texts = s.texts;
  });
}

/** Records `before` for undo and makes `after` the page content. */
export function commitSnapshot(before: Snapshot, after: Snapshot) {
  if (before.strokes === after.strokes && before.texts === after.texts) return;
  const h = stacks();
  h.undo.push(before);
  if (h.undo.length > MAX_HISTORY) h.undo.shift();
  h.redo = [];
  restore(after);
}

const commit = (before: Stroke[], after: Stroke[]) =>
  commitSnapshot({ strokes: before, texts: page().texts }, { strokes: after, texts: page().texts });

export function undo() {
  const h = stacks();
  const prev = h.undo.pop();
  if (!prev) return;
  h.redo.push(snapshot());
  restore(prev);
}

export function redo() {
  const h = stacks();
  const next = h.redo.pop();
  if (!next) return;
  h.undo.push(snapshot());
  restore(next);
}

// --- Drawing ---
type Mode = 'ink' | 'erase' | 'cut' | 'line';
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
  /** Where the pen started holding still (screen px) and the timer that snaps the shape. */
  hold: { x: number; y: number; timer: number } | null;
  /** Clean replacement strokes once the hand-drawn one was recognised as a shape. */
  shape: number[][] | null;
  /** Side-button gesture: does nothing until it moves; a quick still press is a tap (tool ring). */
  barrel: { x: number; y: number; t: number; armed: boolean } | null;
}

const BARREL_SLOP_PX = 6;
const BARREL_TAP_MS = 500;

// Hold the pen still this long at the end of a stroke to snap it into a clean shape.
const HOLD_MS = 450;
const HOLD_SLOP_PX = 4;

function watchHold(a: Gesture, e: PointerEvent) {
  if (!state.snap || a.mode !== 'ink' || a.shape) return;
  if (a.hold && Math.hypot(e.clientX - a.hold.x, e.clientY - a.hold.y) < HOLD_SLOP_PX) return;
  if (a.hold) clearTimeout(a.hold.timer);
  a.hold = { x: e.clientX, y: e.clientY, timer: window.setTimeout(() => snapShape(a), HOLD_MS) };
}

function snapShape(a: Gesture) {
  if (active !== a) return;
  const found = recognize(a.points);
  if (!found) return;
  a.shape = found.strokes;
  clearLive();
  ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.x * dpr, view.y * dpr);
  ctx.globalAlpha = a.opacity;
  ctx.fillStyle = inkColor(a.color, pageIsDark());
  for (const pts of a.shape) ctx.fill(outline(pts, { ...a, pressure: false }, true));
}
let active: Gesture | null = null;

function modeFor(e: PointerEvent): Mode | null {
  // Flipping the Surface Pen to its eraser end always erases.
  if (e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32)) return 'erase';
  // Side (barrel) button held while touching: erase as you drag; a tap opens the tool ring.
  if (e.pointerType === 'pen' && (e.button === 2 || e.buttons & 2)) {
    if (state.tuning.sideButton === 'menu') return null;
    return state.tuning.sideButton === 'pixelEraser' ? 'cut' : 'erase';
  }
  if (e.button !== 0) return null;
  if (e.pointerType === 'touch' && (penSeen || isPalm(e) || touchCount() !== 1)) return null;
  if (state.tool === 'pen' || state.tool === 'highlighter') return 'ink';
  if (state.tool === 'eraser') return 'erase';
  if (state.tool === 'pixelEraser') return 'cut';
  if (state.tool === 'ruler') return 'line';
  return null;
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
  if (a.shape) return; // snapped: the clean shape stays until the pen lifts
  if (a.barrel && !a.barrel.armed) {
    if (Math.hypot(e.clientX - a.barrel.x, e.clientY - a.barrel.y) < BARREL_SLOP_PX) return;
    a.barrel.armed = true; // it's a drag: start erasing from where the press began
    a.last = { ...toWorld(a.barrel.x, a.barrel.y), p: 0.5 };
  }
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
    if (a.mode === 'line') {
      const start = a.points.length ? { x: a.points[0]!, y: a.points[1]! } : w;
      a.points = straightLine(start, w, e.shiftKey);
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
  watchHold(a, e);
  drawLive(a, e);
}

// Ruler: lines snap to every 15° when within this many degrees (always with Shift).
const ANGLE_SNAP_DEG = 4;
// CSS reference pixels per centimetre at 100% zoom (96 px per inch).
const PX_PER_CM = 96 / 2.54;

function straightLine(a: { x: number; y: number }, b: { x: number; y: number }, force: boolean) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  const step = Math.PI / 12;
  const snapped = Math.round(angle / step) * step;
  if (force || Math.abs(angle - snapped) < (ANGLE_SNAP_DEG * Math.PI) / 180) angle = snapped;
  const end = { x: a.x + len * Math.cos(angle), y: a.y + len * Math.sin(angle) };
  return densify([a, end]).map(round);
}

function drawRulerLabel(a: Gesture) {
  const n = a.points.length;
  if (n < 6) return;
  const [x0, y0, ,] = a.points;
  const x1 = a.points[n - 3]!;
  const y1 = a.points[n - 2]!;
  const cm = Math.hypot(x1 - x0!, y1 - y0!) / PX_PER_CM;
  const deg = Math.round(((-Math.atan2(y1 - y0!, x1 - x0!) * 180) / Math.PI + 360) % 360);
  const text = `${cm.toFixed(1)} cm · ${deg}°`;
  const sx = x1 * view.scale + view.x;
  const sy = y1 * view.scale + view.y;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = pageIsDark() ? 'rgba(244,244,245,0.92)' : 'rgba(24,24,27,0.88)';
  ctx.beginPath();
  ctx.roundRect(sx + 14, sy + 14, w, 24, 12);
  ctx.fill();
  ctx.fillStyle = pageIsDark() ? '#18181b' : '#fafafa';
  ctx.fillText(text, sx + 22, sy + 30);
}

function drawLive(a: Gesture, e: PointerEvent) {
  clearLive();
  if (a.mode === 'line') {
    ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.x * dpr, view.y * dpr);
    ctx.globalAlpha = a.opacity;
    ctx.fillStyle = inkColor(a.color, pageIsDark());
    ctx.fill(outline(a.points, { ...a, pressure: false }, true));
    drawRulerLabel(a);
    return;
  }
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
    try {
      presenter.updateInkTrailStartPoint(e, {
        color,
        diameter: Math.max(1, a.width * view.scale * (e.pressure || 0.5)),
      });
    } catch {
      // The OS trail is a bonus; it must never break drawing (it rejects synthetic events, too).
    }
  }
}

function finish(keep: boolean) {
  const a = active;
  if (!a) return;
  active = null;
  if (a.hold) clearTimeout(a.hold.timer);
  if (a.barrel && !a.barrel.armed) {
    clearLive();
    if (keep && performance.now() - a.barrel.t < BARREL_TAP_MS) {
      bg.dispatchEvent(new CustomEvent('barreltap', { detail: { x: a.barrel.x, y: a.barrel.y } }));
    }
    return;
  }
  if (!keep) {
    page().strokes = a.before;
    redraw();
  } else if (a.mode === 'line') {
    const { tool, color, width, opacity, points } = a;
    const n = points.length;
    const long = n >= 6 && Math.hypot(points[n - 3]! - points[0]!, points[n - 2]! - points[1]!) > 1;
    if (long) {
      commit(a.before, [
        ...a.before,
        { id: uid(), tool, color, width, opacity, pressure: false, points },
      ]);
    }
  } else if (a.mode === 'ink' && a.shape) {
    const { tool, color, width, opacity } = a;
    const shapes = a.shape.map((points) => ({
      id: uid(),
      tool,
      color,
      width,
      opacity,
      pressure: false,
      points,
    }));
    commit(a.before, [...a.before, ...shapes]);
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
  requestAnimationFrame(() => {
    if (!active) clearLive(); // a new stroke may already have started this frame
  });
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
    hold: null,
    shape: null,
    barrel:
      e.pointerType === 'pen' && (e.button === 2 || e.buttons & 2)
        ? { x: e.clientX, y: e.clientY, t: performance.now(), armed: false }
        : null,
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

// Hover preview: a dot under the hovering pen tip with the exact size and colour the ink will have
// at this zoom (Apple's guidance: preview the mark, don't vary it with height). Pen only — a mouse
// has its own cursor. It's a DOM element moved with a transform, so it never repaints the canvas.
const hoverDot = h('div', { class: 'hover-dot', 'aria-hidden': 'true', hidden: true });
bg.parentElement!.append(hoverDot);
const hideHover = () => {
  hoverDot.hidden = true;
};
bg.addEventListener('pointermove', (e) => {
  const inks = state.tool === 'pen' || state.tool === 'highlighter' || state.tool === 'ruler';
  if (active || e.pointerType !== 'pen' || e.buttons !== 0 || !inks || !state.tuning.hoverPreview) {
    hideHover();
    return;
  }
  const st = state.styles[inkTool(state.tool)];
  const d = Math.max(3, st.width * view.scale);
  hoverDot.hidden = false;
  hoverDot.style.cssText = `width:${d}px;height:${d}px;background:${inkColor(st.color, pageIsDark())};opacity:${Math.max(st.opacity, 0.35)};transform:translate(${e.offsetX - d / 2}px, ${e.offsetY - d / 2}px)`;
});
bg.addEventListener('pointerdown', hideHover);
bg.addEventListener('pointerleave', hideHover);

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
