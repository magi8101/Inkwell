import { capture, h } from './dom';
import { predict, type Sample } from './predict';
import { densify, recognize } from './shape';
import {
  type ImageItem,
  inkTool,
  page,
  type Stroke,
  state,
  subscribe,
  type TextBox,
  uid,
  update,
} from './store';
import { cut, hits, inkColor, outline, tipDiameter } from './stroke';
import {
  isPalm,
  localToWorld,
  pageIsDark,
  penSeen,
  redraw,
  screenBox,
  toScreen,
  touchCount,
  toWorld,
  view,
  viewMatrix,
} from './viewport';

const MAX_HISTORY = 500;

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
// Wet ink (the stroke being drawn) uses two layers above the page, both `desynchronized` so
// Chromium can skip the compositor:
//  - live: the full, smoothed, pressure-shaped stroke, redrawn once per frame (pointermove);
//  - tip: a short segment from the end of that stroke to the pen's newest raw position, plus a
//    predicted lead, redrawn on every pen sample (pointerrawupdate where supported) with only
//    its own small area cleared. This recreates what Windows' OS ink trail does — ink under the
//    pen before the app's next frame — on macOS, Linux and every browser.
// Translucent strokes put their opacity on the wrapper, so where the layers overlap it doesn't
// double up.
const wet = document.querySelector<HTMLDivElement>('#wet')!;
const live = document.querySelector<HTMLCanvasElement>('#live')!;
const tip = document.querySelector<HTMLCanvasElement>('#tip')!;
// Where the OS ink trail exists (Edge/WebView2 on Windows) it is the fast path, and its spec says
// not to combine it with desynchronized canvases or app-side prediction — so only use those
// everywhere else. (A canvas's mode is fixed at creation, hence the check up front.)
// Other platforms may expose navigator.ink too, but it isn't documented to draw an OS trail
// there, so they get our own verified pipeline instead.
type UAData = { userAgentData?: { platform?: string } };
const IS_WINDOWS =
  (navigator as Navigator & UAData).userAgentData?.platform === 'Windows' ||
  /Windows/.test(navigator.userAgent);
const OS_TRAIL = IS_WINDOWS && 'ink' in navigator;
// Android draws desynchronized canvases straight to the screen without transparency on many
// GPUs, so the see-through wet-ink layers covered the page in black whenever nothing was being
// drawn. Android gets normal canvases; prediction still hides most of the delay.
const IS_ANDROID = /Android/.test(navigator.userAgent);
const LOW_LATENCY = !OS_TRAIL && !IS_ANDROID;
const ctx = live.getContext('2d', { desynchronized: LOW_LATENCY })!;
const tctx = tip.getContext('2d', { desynchronized: LOW_LATENCY })!;
let dpr = devicePixelRatio;
new ResizeObserver(() => {
  dpr = devicePixelRatio;
  for (const c of [live, tip]) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
  }
}).observe(live);

const RAW_EVENTS = 'onpointerrawupdate' in window;
const MAX_LEAD_PX = 28; // the predicted lead never extends further than this on screen
const RAW_HISTORY = 16;

/** Live numbers for the Pen feel panel (exponential moving averages, measured while inking). */
export const inkStats = {
  rawEvents: RAW_EVENTS,
  predictor: 'off' as 'off' | 'browser' | 'built-in',
  tipMs: 0,
  /** Measured display frame interval. */
  frameMs: 1000 / 60,
  /** Pen sample timestamp → its tip drawn (event queueing + our handler). */
  inputToDrawMs: 0,
  /** Newest pen sample → start of the frame that shows it (the app's share of latency). */
  inputToFrameMs: 0,
};
const ema = (old: number, v: number, k = 0.15) => old + (v - old) * k;

// One frame probe at a time while inking: measures the refresh interval and how old the newest
// sample is when the frame is produced. Nothing runs when the pen is idle.
let probing = false;
let lastFrameT = 0;
function probeFrame(a: Gesture) {
  if (probing) return;
  probing = true;
  requestAnimationFrame((t) => {
    probing = false;
    if (lastFrameT && t - lastFrameT > 4 && t - lastFrameT < 50) {
      inkStats.frameMs = ema(inkStats.frameMs, t - lastFrameT);
    }
    lastFrameT = t;
    const head = a.raw[a.raw.length - 1];
    if (head && t >= head.t) inkStats.inputToFrameMs = ema(inkStats.inputToFrameMs, t - head.t);
  });
}

/** How far ahead to predict: one display frame (automatic) or the manual setting. */
const leadMs = () =>
  state.tuning.predictAuto ? Math.min(24, Math.max(6, inkStats.frameMs)) : state.tuning.predictMs;

// Windows Ink API (Edge/WebView2): the OS draws the trail under the pen tip between our frames.
interface InkPresenter {
  updateInkTrailStartPoint(e: PointerEvent, style: { color: string; diameter: number }): void;
}
type InkNavigator = Navigator & {
  ink?: { requestPresenter(o: { presentationArea: Element }): Promise<InkPresenter> };
};
let presenter: InkPresenter | null = null;
(OS_TRAIL ? (navigator as InkNavigator).ink : undefined)
  ?.requestPresenter({ presentationArea: live })
  .then(
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
  /** Omitted by edits that don't touch pictures: they stay as they are. */
  images?: ImageItem[];
}
/** One edit: the page content just before and just after it. */
interface Step {
  before: Snapshot;
  after: Snapshot;
}
const history = new Map<string, { undo: Step[]; redo: Step[] }>();
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
export const snapshot = (): Snapshot => ({
  strokes: page().strokes,
  texts: page().texts,
  images: page().images,
});

function restore(s: Snapshot) {
  update(() => {
    page().strokes = s.strokes;
    page().texts = s.texts;
    if (s.images) page().images = s.images;
  });
}

/**
 * Moves `cur` from `from` to `to` by changing only what that edit changed (by item id), so
 * strokes others added meanwhile (a live session) survive an undo. With nothing else changed it's
 * exactly `to`.
 */
function rebase<T extends { id: string }>(cur: T[], from: T[], to: T[]): T[] {
  if (cur === from) return to;
  const inFrom = new Set(from);
  const inTo = new Set(to);
  const gone = new Set(from.filter((x) => !inTo.has(x)).map((x) => x.id));
  const back = new Map(to.filter((x) => !inFrom.has(x)).map((x) => [x.id, x]));
  const out: T[] = [];
  for (const x of cur) {
    const replacement = back.get(x.id);
    if (replacement) {
      out.push(replacement); // changed in place (moved, resized…): keeps its layer
      back.delete(x.id);
    } else if (!gone.has(x.id)) out.push(x);
  }
  return [...out, ...back.values()];
}

function apply(from: Snapshot, to: Snapshot) {
  const cur = snapshot();
  restore({
    strokes: rebase(cur.strokes, from.strokes, to.strokes),
    texts: rebase(cur.texts, from.texts, to.texts),
    images: rebase(cur.images ?? [], from.images ?? [], to.images ?? []),
  });
}

/** Records `before` for undo and makes `after` the page content. */
export function commitSnapshot(before: Snapshot, after: Snapshot) {
  if (
    before.strokes === after.strokes &&
    before.texts === after.texts &&
    (after.images === undefined || before.images === after.images)
  ) {
    return;
  }
  const h = stacks();
  const images = before.images ?? page().images;
  h.undo.push({
    before: { ...before, images },
    after: { ...after, images: after.images ?? images },
  });
  if (h.undo.length > MAX_HISTORY) h.undo.shift();
  h.redo = [];
  restore(after);
}

const commit = (before: Stroke[], after: Stroke[]) =>
  commitSnapshot({ strokes: before, texts: page().texts }, { strokes: after, texts: page().texts });

export function undo() {
  const h = stacks();
  const step = h.undo.pop();
  if (!step) return;
  h.redo.push(step);
  apply(step.after, step.before);
}

export function redo() {
  const h = stacks();
  const step = h.redo.pop();
  if (!step) return;
  h.undo.push(step);
  apply(step.before, step.after);
}

// --- Drawing ---
type Mode = 'ink' | 'erase' | 'cut' | 'line';
interface Gesture {
  id: number;
  /** pointerType that started it ('pen', 'touch', 'mouse'). */
  type: string;
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
  /** Canvas-relative position of the canvas, captured at pen-down (raw events lack offsetX). */
  origin: { left: number; top: number };
  /** Newest raw pen samples in canvas px, for the fast tip and prediction. */
  raw: (Sample & { p: number; seen?: boolean })[];
  /** The browser's own predicted points from the latest frame, canvas px (if it gives any). */
  predicted: Sample[];
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
  ctx.setTransform(...viewMatrix(dpr));
  ctx.globalAlpha = 1; // opacity is on the wet-ink wrapper
  ctx.fillStyle = inkColor(a.color, pageIsDark());
  for (const pts of a.shape) ctx.fill(outline(pts, { ...a, pressure: false }, true));
}
let active: Gesture | null = null;

function modeFor(e: PointerEvent): Mode | null {
  // Flipping the pen to its eraser end always erases: whole strokes or pixels, as set.
  if (e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32)) {
    return state.tuning.eraserEnd === 'pixelEraser' ? 'cut' : 'erase';
  }
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
  liveBox = null;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tip.width, tip.height);
  tipBox = null;
}

// --- Fast tip ---

/** The Windows OS trail is drawing this stroke's newest segment for us. */
const osTrailActive = (a: Gesture) =>
  presenter !== null && state.tuning.inkTrail && a.tool === 'pen' && a.opacity === 1;

let tipBox: { x0: number; y0: number; x1: number; y1: number } | null = null;

/**
 * A pointer event's samples in time order with usable pressure. Safari's coalesced events
 * (iOS 18.2+) are incomplete: they can lack pressure (0) as well as target and pointerId. Treating
 * that 0 as "unknown → 0.5" made the width jump between 0.5 and the real pressure on every sample,
 * so fast iPad writing came out as a chain of beads. They inherit the dispatched event's pressure.
 */
function samplesOf(e: PointerEvent): { ev: PointerEvent; p: number }[] {
  const list = e.getCoalescedEvents?.() ?? [];
  const evs = list.length ? [...list].sort((x, y) => x.timeStamp - y.timeStamp) : [e];
  const fallback = e.pressure > 0 ? e.pressure : 0.5;
  return evs.map((ev) => ({ ev, p: ev.pressure > 0 ? ev.pressure : fallback }));
}

function addRaw(a: Gesture, samples: { ev: PointerEvent; p: number }[]) {
  for (const { ev, p } of samples) {
    const x = ev.clientX - a.origin.left;
    const y = ev.clientY - a.origin.top;
    const last = a.raw[a.raw.length - 1];
    // Skip samples already seen via pointerrawupdate (same time and place), or out of order.
    // Timestamps alone aren't unique: coarse timers can give two real samples the same time.
    if (
      last &&
      (ev.timeStamp < last.t || (ev.timeStamp === last.t && x === last.x && y === last.y))
    ) {
      continue;
    }
    a.raw.push({ x, y, t: ev.timeStamp, p });
  }
  // Trim history, but never a sample that isn't in the stroke yet (it would be lost on lift).
  while (a.raw.length > RAW_HISTORY && a.raw[0]!.seen) a.raw.shift();
}

/** This sample (and everything before it) is now part of the smoothed stroke. */
function markSeen(a: Gesture, ev: PointerEvent) {
  const x = ev.clientX - a.origin.left;
  const y = ev.clientY - a.origin.top;
  for (let i = a.raw.length - 1; i >= 0; i--) {
    const r = a.raw[i]!;
    if (r.t === ev.timeStamp && r.x === x && r.y === y) {
      for (let k = 0; k <= i; k++) a.raw[k]!.seen = true;
      return;
    }
  }
}

/** Bridge from the smoothed stroke's end to the newest raw sample, then the predicted lead. */
function drawTip(a: Gesture) {
  const t0 = performance.now();
  if (tipBox) {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(tipBox.x0, tipBox.y0, tipBox.x1 - tipBox.x0, tipBox.y1 - tipBox.y0);
    tipBox = null;
  }
  const n = a.points.length;
  const head = a.raw[a.raw.length - 1];
  if (a.mode !== 'ink' || a.shape || !n || !head) return;
  const pts: Sample[] = [{ ...toScreen(a.points[n - 3]!, a.points[n - 2]!), t: 0 }, head];
  inkStats.predictor = 'off';
  if (state.tuning.prediction && !osTrailActive(a)) {
    // Prefer the browser's own prediction when it's newer than our newest sample.
    const browser = a.predicted[a.predicted.length - 1];
    const lead = browser && browser.t > head.t ? browser : predict(a.raw, leadMs(), MAX_LEAD_PX);
    if (lead) {
      pts.push(lead);
      inkStats.predictor = lead === browser ? 'browser' : 'built-in';
    }
  }
  const w = Math.max(1, tipDiameter(a, head.p) * view.scale);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.globalAlpha = 1;
  tctx.strokeStyle = inkColor(a.color, pageIsDark());
  tctx.lineWidth = w;
  tctx.lineCap = 'round';
  tctx.lineJoin = 'round';
  tctx.beginPath();
  tctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (const p of pts.slice(1)) tctx.lineTo(p.x, p.y);
  tctx.stroke();
  const pad = w / 2 + 2;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  tipBox = {
    x0: Math.floor((Math.min(...xs) - pad) * dpr),
    y0: Math.floor((Math.min(...ys) - pad) * dpr),
    x1: Math.ceil((Math.max(...xs) + pad) * dpr),
    y1: Math.ceil((Math.max(...ys) + pad) * dpr),
  };
  const now = performance.now();
  inkStats.tipMs = ema(inkStats.tipMs, now - t0, 0.1);
  if (now >= head.t) inkStats.inputToDrawMs = ema(inkStats.inputToDrawMs, now - head.t);
  probeFrame(a);
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
  const r = state.eraserWidth / 2 / view.scale;
  let changed = false;
  for (const sample of samplesOf(e)) {
    const { ev, p: pr } = sample;
    const w = toWorld(ev.clientX, ev.clientY);
    const prev = a.last;
    a.last = { x: w.x, y: w.y, p: pr };
    if (a.mode === 'ink') {
      addRaw(a, [sample]);
      markSeen(a, ev);
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
  if (a.mode === 'ink') {
    drawTip(a); // the newest samples show immediately
    scheduleLive(a, e); // the full stroke at most once per frame
  } else {
    drawLive(a, e);
  }
}

// Safari before iOS 18.2 fires every Apple Pencil sample (240 Hz) as its own pointermove; redrawing
// the whole stroke on a full-resolution canvas for each one overloaded the iPad. The full stroke is
// now drawn once per frame, while the tip still follows every sample.
let liveQueued: Gesture | null = null;
let liveEvent: PointerEvent | null = null;
function scheduleLive(a: Gesture, e: PointerEvent) {
  liveEvent = e;
  if (liveQueued) return;
  liveQueued = a;
  requestAnimationFrame(() => {
    const g = liveQueued;
    liveQueued = null;
    if (g && g === active && liveEvent) drawLive(g, liveEvent);
  });
}

// Only the area the wet stroke covers is cleared each frame, not the whole retina-size canvas.
let liveBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
function clearLiveArea() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (liveBox)
    ctx.clearRect(liveBox.x0, liveBox.y0, liveBox.x1 - liveBox.x0, liveBox.y1 - liveBox.y0);
  else ctx.clearRect(0, 0, live.width, live.height);
  liveBox = null;
}
function rememberInkBox(a: Gesture) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < a.points.length; i += 3) {
    x0 = Math.min(x0, a.points[i]!);
    x1 = Math.max(x1, a.points[i]!);
    y0 = Math.min(y0, a.points[i + 1]!);
    y1 = Math.max(y1, a.points[i + 1]!);
  }
  if (x0 === Infinity) return;
  const pad = (a.width * view.scale) / 2 + 4;
  const sb = screenBox(x0, y0, x1, y1);
  liveBox = {
    x0: Math.floor((sb.x0 - pad) * dpr),
    y0: Math.floor((sb.y0 - pad) * dpr),
    x1: Math.ceil((sb.x1 + pad) * dpr),
    y1: Math.ceil((sb.y1 + pad) * dpr),
  };
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
  const { x: sx, y: sy } = toScreen(x1, y1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = pageIsDark() ? 'rgba(244,244,245,0.92)' : 'rgba(24,24,27,0.88)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(sx + 14, sy + 14, w, 24, 12);
  else ctx.rect(sx + 14, sy + 14, w, 24); // Safari < 16
  ctx.fill();
  ctx.fillStyle = pageIsDark() ? '#18181b' : '#fafafa';
  ctx.fillText(text, sx + 22, sy + 30);
}

function drawLive(a: Gesture, e: PointerEvent) {
  if (a.shape) return; // a snapped shape owns the layer now
  if (a.mode === 'ink') clearLiveArea();
  else clearLive(); // ruler label and eraser ring: rare, small layers, clear everything
  if (a.mode === 'line') {
    ctx.setTransform(...viewMatrix(dpr));
    ctx.globalAlpha = 1; // opacity is on the wet-ink wrapper
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
  // Predicted points hide latency; they're drawn on the tip layer and never saved.
  a.predicted = state.tuning.prediction
    ? (e.getPredictedEvents?.() ?? []).map((p) => ({
        x: p.clientX - a.origin.left,
        y: p.clientY - a.origin.top,
        t: p.timeStamp,
      }))
    : [];
  const color = inkColor(a.color, pageIsDark());
  ctx.setTransform(...viewMatrix(dpr));
  ctx.globalAlpha = 1; // opacity is on the wet-ink wrapper
  ctx.fillStyle = color;
  ctx.fill(outline(a.points, a, false));
  rememberInkBox(a);
  drawTip(a);
  if (presenter && osTrailActive(a)) {
    try {
      presenter.updateInkTrailStartPoint(e, {
        color,
        diameter: Math.max(1, tipDiameter(a, e.pressure || 0.5) * view.scale),
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
    // Raw samples newer than the last frame were already shown by the fast tip; keep them so
    // the stroke doesn't shrink back when the pen lifts.
    for (const r of a.raw) {
      if (r.seen) continue;
      const w = localToWorld(r.x, r.y);
      points.push(round(w.x), round(w.y), round(r.p));
    }
    commit(a.before, [...a.before, { id: uid(), tool, color, width, opacity, pressure, points }]);
  } else {
    commit(a.before, page().strokes);
  }
  // Clear after the main canvas has painted the committed stroke, so it never blinks.
  requestAnimationFrame(() => {
    if (active) return; // a new stroke may already have started this frame
    clearLive();
    wet.style.opacity = '';
  });
}

/** The newest presses and what became of each, for the pen report (Pen feel → Calibrate). */
export const pressLog: {
  at: number;
  type: string;
  buttons: number;
  took: boolean;
  why: string;
  sinceLift: number;
}[] = [];
let lastLift = 0;
function logPress(e: PointerEvent, took: boolean, why = '') {
  pressLog.push({
    at: Math.round(e.timeStamp),
    type: e.pointerType,
    buttons: e.buttons,
    took,
    why,
    sinceLift: lastLift ? Math.round(e.timeStamp - lastLift) : -1,
  });
  if (pressLog.length > 40) pressLog.shift();
}
/** Why modeFor said no, in words (it only has to be right enough to read a report). */
function whyNot(e: PointerEvent) {
  if (e.pointerType === 'touch') {
    if (penSeen) return 'touch while a pen is in use';
    if (isPalm(e)) return 'looks like a palm';
    if (touchCount() !== 1) return `${touchCount()} touches (pan/zoom)`;
  }
  return e.button !== 0 ? `button ${e.button}` : 'this tool does not draw';
}

bg.addEventListener('pointerdown', (e) => {
  if (active) {
    // A pen writes one stroke at a time, so a new pen press means the last one's lift never
    // arrived (it is how a stroke can get stuck "active" and swallow every press after it).
    if (e.pointerType === 'pen' && active.type === 'pen') finish(true);
    else {
      logPress(e, false, 'a stroke was still active');
      return;
    }
  }
  const mode = modeFor(e);
  if (!mode) {
    logPress(e, false, whyNot(e));
    return;
  }
  logPress(e, true);
  capture(bg, e.pointerId);
  const tool = inkTool(state.tool);
  active = {
    id: e.pointerId,
    type: e.pointerType,
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
    origin: (({ left, top }) => ({ left, top }))(bg.getBoundingClientRect()),
    raw: [],
    predicted: [],
  };
  lastFrameT = 0; // don't count the idle gap before this stroke as a frame
  const translucent = (mode === 'ink' || mode === 'line') && active.opacity < 1;
  wet.style.opacity = translucent ? String(active.opacity) : '';
  addPoints(active, e);
});

bg.addEventListener('pointermove', (e) => {
  if (active?.id === e.pointerId) addPoints(active, e);
});
// Raw samples arrive as soon as the hardware reports them instead of once per frame; they only
// move the fast tip. The smoothed stroke still updates on the frame-aligned pointermove.
if (RAW_EVENTS) {
  bg.addEventListener('pointerrawupdate' as 'pointermove', (e) => {
    const a = active;
    if (!a || a.id !== e.pointerId || a.mode !== 'ink' || a.shape || a.barrel) return;
    addRaw(a, samplesOf(e));
    drawTip(a);
  });
}
bg.addEventListener('pointerup', (e) => {
  lastLift = e.timeStamp;
  if (active?.id === e.pointerId) finish(true);
});
bg.addEventListener('pointercancel', (e) => {
  lastLift = e.timeStamp;
  logPress(e, false, 'pointercancel: the system took this touch');
  if (active?.id === e.pointerId) finish(false);
});
// iPad Safari: Scribble (Apple Pencil handwriting) takes Pencil touches that start on the page and
// can drop or delay the pointer events of the stroke after one ("the next letter only works 1-2
// seconds later"; WebKit bug 217430). Cancelling the Pencil's touch events stops that, and the
// pointer events that draw still arrive. Pencil touches only (iOS Safari marks them with
// touchType 'stylus'), so fingers still pan and pinch; on the canvas only, so the Pencil can
// still press buttons and type in text boxes.
for (const type of ['touchstart', 'touchmove'] as const) {
  bg.addEventListener(
    type,
    (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if ((e.changedTouches[i] as Touch & { touchType?: string }).touchType === 'stylus') {
          e.preventDefault();
          return;
        }
      }
    },
    { passive: false },
  );
}

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
