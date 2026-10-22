import { ClipboardPaste, Copy, CopyPlus, RotateCw, Scissors, Trash2, X } from 'lucide';
import { capture, clamp, h, icon, toast } from './dom';
import { commitSnapshot, type Snapshot, snapshot } from './ink';
import { PALETTE, page, type Stroke, state, subscribe, type TextBox, uid, update } from './store';
import { bbox, LINE_HEIGHT } from './stroke';
import { renderTexts } from './text';
import { colorName, shown } from './toolbar';
import { isPalm, penSeen, redraw, touchCount, toWorld, view } from './viewport';

// Lasso (L): draw a loop around ink and text boxes to select them. Drag inside the frame to move,
// the corner handle to resize, the round handle to rotate. Text boxes move and scale with the
// selection but stay upright. Selected items keep their ids, so a selection survives transforms.

type Pt = { x: number; y: number };
/** x' = a·x + c·y + e, y' = b·x + d·y + f */
type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const STROKE_INSIDE = 0.6; // share of a stroke's points that must be inside the loop
const PASTE_OFFSET = 24;

const stage = document.querySelector<HTMLElement>('#stage')!;
const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const textLayer = document.querySelector<HTMLDivElement>('#texts')!;

let selected = { strokes: new Set<string>(), texts: new Set<string>() };
let clipboard: { strokes: Stroke[]; texts: TextBox[] } | null = null;
let pasteCount = 0;

const hasSelection = () => selected.strokes.size + selected.texts.size > 0;
const pickedStrokes = () => page().strokes.filter((s) => selected.strokes.has(s.id));
const pickedTexts = () => page().texts.filter((t) => selected.texts.has(t.id));

function inside(p: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
}

/** Text height isn't stored; measure the rendered box (layer is in world units). */
function textHeight(t: TextBox) {
  const el = textLayer.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
  return el ? el.offsetHeight : t.size * LINE_HEIGHT;
}

function worldBox(strokes: Stroke[], texts: TextBox[]) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) {
    const k = bbox(s);
    b[0] = Math.min(b[0]!, k[0]);
    b[1] = Math.min(b[1]!, k[1]);
    b[2] = Math.max(b[2]!, k[2]);
    b[3] = Math.max(b[3]!, k[3]);
  }
  for (const t of texts) {
    b[0] = Math.min(b[0]!, t.x);
    b[1] = Math.min(b[1]!, t.y);
    b[2] = Math.max(b[2]!, t.x + t.w);
    b[3] = Math.max(b[3]!, t.y + textHeight(t));
  }
  return { x: b[0]!, y: b[1]!, w: b[2]! - b[0]!, h: b[3]! - b[1]! };
}

function transform(pivot: Pt, scale: number, angle: number, dx: number, dy: number): Matrix {
  const a = scale * Math.cos(angle);
  const b = scale * Math.sin(angle);
  return {
    a,
    b,
    c: -b,
    d: a,
    e: pivot.x - a * pivot.x + b * pivot.y + dx,
    f: pivot.y - b * pivot.x - a * pivot.y + dy,
  };
}
const apply = (m: Matrix, x: number, y: number): Pt => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
});
const round = (n: number) => Math.round(n * 100) / 100;

function transformed(base: Snapshot, m: Matrix, scale: number): Snapshot {
  return {
    strokes: base.strokes.map((s) => {
      if (!selected.strokes.has(s.id)) return s;
      const points = s.points.slice();
      for (let i = 0; i < points.length; i += 3) {
        const p = apply(m, points[i]!, points[i + 1]!);
        points[i] = round(p.x);
        points[i + 1] = round(p.y);
      }
      return { ...s, points, width: s.width * scale };
    }),
    texts: base.texts.map((t) => {
      if (!selected.texts.has(t.id)) return t;
      const p = apply(m, t.x, t.y);
      return { ...t, x: p.x, y: p.y, w: t.w * scale, size: t.size * scale };
    }),
  };
}

// --- Overlay: lasso path, selection frame with handles, action bar ---

const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.classList.add('lasso-path');
const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
svg.append(path);
// A resize handle on every corner (easy to reach with a finger or pencil wherever the selection
// sits); each scales from the opposite corner.
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
const scaleHandles = CORNERS.map((c) =>
  h('div', { class: `sel-handle scale ${c}`, title: 'Drag to resize', 'data-corner': c }),
);
const rotateHandle = h(
  'div',
  { class: 'sel-handle rotate', title: 'Drag to rotate' },
  icon(RotateCw, 14),
);
const frame = h('div', { class: 'sel-frame', hidden: true }, ...scaleHandles, rotateHandle);
stage.append(svg, frame);

const bar = h('div', {
  class: 'textbar selbar',
  role: 'toolbar',
  'aria-label': 'Selection',
  hidden: true,
});
document.body.append(bar);

function placeFrame() {
  frame.hidden = !hasSelection() || state.tool !== 'lasso';
  if (frame.hidden) {
    bar.hidden = true;
    return;
  }
  const b = worldBox(pickedStrokes(), pickedTexts());
  const pad = 8;
  frame.style.left = `${b.x * view.scale + view.x - pad}px`;
  frame.style.top = `${b.y * view.scale + view.y - pad}px`;
  frame.style.width = `${b.w * view.scale + pad * 2}px`;
  frame.style.height = `${b.h * view.scale + pad * 2}px`;
  placeBar();
}

function placeBar() {
  bar.hidden = frame.hidden;
  if (bar.hidden) return;
  const r = frame.getBoundingClientRect();
  const bh = bar.offsetHeight;
  const top = r.top - bh - 40 > 8 ? r.top - bh - 40 : r.bottom + 16;
  bar.style.top = `${clamp(top, 8, innerHeight - bh - 8)}px`;
  bar.style.left = `${clamp(r.left, 8, innerWidth - bar.offsetWidth - 8)}px`;
}

function renderBar() {
  const btn = (label: string, node: typeof Copy, run: () => void, extra = '') =>
    h(
      'button',
      { class: `tb-btn ${extra}`, 'aria-label': label, title: label, onclick: run },
      icon(node, 18),
    );
  bar.replaceChildren(
    btn('Copy (Ctrl+C)', Copy, copy),
    btn('Cut (Ctrl+X)', Scissors, cut),
    btn('Duplicate (Ctrl+D)', CopyPlus, duplicate),
    ...(clipboard ? [btn('Paste (Ctrl+V)', ClipboardPaste, paste)] : []),
    h(
      'div',
      { class: 'colors' },
      ...PALETTE.slice(0, 8).map((c) =>
        h('button', {
          class: 'pal',
          style: `--c:${shown(c)}`,
          'aria-label': `Recolour: ${colorName(c)}`,
          title: `Recolour: ${colorName(c)}`,
          onclick: () => recolor(c),
        }),
      ),
    ),
    btn('Delete (Del)', Trash2, remove, 'danger'),
    btn('Deselect (Esc)', X, clear),
  );
  placeBar();
}

// Touch devices have no Ctrl+V, so a Paste button shows whenever something has been copied and
// the lasso is active with nothing selected.
const pasteChip = h(
  'button',
  { class: 'chip paste', hidden: true, title: 'Paste (Ctrl+V)', onclick: () => paste() },
  icon(ClipboardPaste, 16),
  h('span', {}, 'Paste'),
);
stage.append(pasteChip);
function updatePasteChip() {
  pasteChip.hidden = !clipboard || state.tool !== 'lasso' || hasSelection();
}

function select(strokes: Iterable<string>, texts: Iterable<string>) {
  selected = { strokes: new Set(strokes), texts: new Set(texts) };
  renderBar();
  placeFrame();
  updatePasteChip();
}
const clear = () => select([], []);

// --- Actions ---

function copy() {
  if (!hasSelection()) return;
  clipboard = { strokes: pickedStrokes(), texts: pickedTexts() };
  pasteCount = 0;
  toast('Copied — tap Paste to place it.', 1800);
  updatePasteChip();
}

function remove() {
  if (!hasSelection()) return;
  const before = snapshot();
  commitSnapshot(before, {
    strokes: before.strokes.filter((s) => !selected.strokes.has(s.id)),
    texts: before.texts.filter((t) => !selected.texts.has(t.id)),
  });
  clear();
}

function cut() {
  copy();
  remove();
}

function insert(items: { strokes: Stroke[]; texts: TextBox[] }, dx: number, dy = dx) {
  const strokes = items.strokes.map((s) => {
    const points = s.points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v));
    return { ...s, id: uid(), points };
  });
  const texts = items.texts.map((t) => ({ ...t, id: uid(), x: t.x + dx, y: t.y + dy }));
  const before = snapshot();
  commitSnapshot(before, {
    strokes: [...before.strokes, ...strokes],
    texts: [...before.texts, ...texts],
  });
  if (state.tool !== 'lasso') {
    update((s) => {
      s.tool = 'lasso';
    });
  }
  select(
    strokes.map((s) => s.id),
    texts.map((t) => t.id),
  );
}

/** Pastes into the middle of what's on screen (the original may be off-screen or on another page). */
function paste() {
  if (!clipboard) return;
  const b = worldBox(clipboard.strokes, clipboard.texts);
  const r = bg.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const step = PASTE_OFFSET * pasteCount++; // repeated pastes fan out instead of stacking
  insert(clipboard, c.x - (b.x + b.w / 2) + step, c.y - (b.y + b.h / 2) + step);
}

function duplicate() {
  if (hasSelection()) insert({ strokes: pickedStrokes(), texts: pickedTexts() }, PASTE_OFFSET);
}

function recolor(color: string) {
  const before = snapshot();
  commitSnapshot(before, {
    strokes: before.strokes.map((s) => (selected.strokes.has(s.id) ? { ...s, color } : s)),
    texts: before.texts.map((t) => (selected.texts.has(t.id) ? { ...t, color } : t)),
  });
  placeFrame();
}

// --- Gestures ---

const allowed = (e: PointerEvent) =>
  e.button === 0 && (e.pointerType !== 'touch' || (!penSeen && !isPalm(e) && touchCount() === 1));

/** Shared drag loop: live preview by swapping page content, one undo step on release. */
function drag(
  e: PointerEvent,
  target: HTMLElement,
  onMove: (m: PointerEvent, base: Snapshot) => Snapshot | null,
) {
  e.preventDefault();
  e.stopPropagation();
  capture(target, e.pointerId);
  const base = snapshot();
  let last: Snapshot | null = null;
  const move = (m: PointerEvent) => {
    last = onMove(m, base);
    if (!last) return;
    // Preview without update(): no autosave or sidebar work on every pointer move.
    page().strokes = last.strokes;
    page().texts = last.texts;
    redraw();
    renderTexts();
    placeFrame();
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    if (!last) return;
    page().strokes = base.strokes;
    page().texts = base.texts;
    commitSnapshot(base, last);
    placeFrame();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

frame.addEventListener('pointerdown', (e) => {
  if (!allowed(e) || e.target !== frame) return;
  const start = toWorld(e.clientX, e.clientY);
  drag(e, frame, (m, base) => {
    const w = toWorld(m.clientX, m.clientY);
    return transformed(base, transform(start, 1, 0, w.x - start.x, w.y - start.y), 1);
  });
});

for (const handle of scaleHandles) {
  handle.addEventListener('pointerdown', (e) => {
    if (!allowed(e)) return;
    const b = worldBox(pickedStrokes(), pickedTexts());
    const c = handle.dataset.corner!;
    const pivot = { x: c.includes('w') ? b.x + b.w : b.x, y: c.includes('n') ? b.y + b.h : b.y };
    // Ratio against where the drag started, so grabbing the handle never makes the selection jump.
    const s0 = toWorld(e.clientX, e.clientY);
    const startDist = Math.hypot(s0.x - pivot.x, s0.y - pivot.y) || 1;
    drag(e, handle, (m, base) => {
      const w = toWorld(m.clientX, m.clientY);
      const s = clamp(Math.hypot(w.x - pivot.x, w.y - pivot.y) / startDist, 0.05, 20);
      return transformed(base, transform(pivot, s, 0, 0, 0), s);
    });
  });
}

rotateHandle.addEventListener('pointerdown', (e) => {
  if (!allowed(e)) return;
  const b = worldBox(pickedStrokes(), pickedTexts());
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const s0 = toWorld(e.clientX, e.clientY);
  const a0 = Math.atan2(s0.y - c.y, s0.x - c.x);
  drag(e, rotateHandle, (m, base) => {
    const w = toWorld(m.clientX, m.clientY);
    let angle = Math.atan2(w.y - c.y, w.x - c.x) - a0;
    const step = Math.PI / 12; // snap to 15° near multiples
    if (Math.abs(angle - Math.round(angle / step) * step) < 0.05)
      angle = Math.round(angle / step) * step;
    return transformed(base, transform(c, 1, angle, 0, 0), 1);
  });
});

// Drawing the loop.
bg.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'lasso' || !allowed(e)) return;
  capture(bg, e.pointerId);
  clear();
  const loop: Pt[] = [toWorld(e.clientX, e.clientY)];
  // clientX-based: Safari 18.2+ coalesced events have no target, so offsetX is unreliable.
  const origin = bg.getBoundingClientRect();
  const pt = (ev: PointerEvent) => `${ev.clientX - origin.left},${ev.clientY - origin.top}`;
  const screen: string[] = [pt(e)];
  svg.style.display = 'block';
  const move = (m: PointerEvent) => {
    for (const ev of m.getCoalescedEvents?.().length ? m.getCoalescedEvents() : [m]) {
      loop.push(toWorld(ev.clientX, ev.clientY));
      screen.push(pt(ev));
    }
    path.setAttribute('points', screen.join(' '));
  };
  const up = () => {
    bg.removeEventListener('pointermove', move);
    bg.removeEventListener('pointerup', up);
    bg.removeEventListener('pointercancel', up);
    svg.style.display = 'none';
    path.setAttribute('points', '');
    if (loop.length < 3) return;
    const strokes = page().strokes.filter((s) => {
      let n = 0;
      for (let i = 0; i < s.points.length; i += 3) {
        if (inside({ x: s.points[i]!, y: s.points[i + 1]! }, loop)) n++;
      }
      return n / (s.points.length / 3) >= STROKE_INSIDE;
    });
    const texts = page().texts.filter((t) =>
      inside({ x: t.x + t.w / 2, y: t.y + textHeight(t) / 2 }, loop),
    );
    select(
      strokes.map((s) => s.id),
      texts.map((t) => t.id),
    );
  };
  bg.addEventListener('pointermove', move);
  bg.addEventListener('pointerup', up);
  bg.addEventListener('pointercancel', up);
});

addEventListener('keydown', (e) => {
  if (
    (e.target as HTMLElement).closest(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  )
    return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'v' && clipboard) {
    e.preventDefault();
    paste();
    return;
  }
  if (!hasSelection() || state.tool !== 'lasso') return;
  const actions: Record<string, () => void> = mod
    ? { c: copy, x: cut, d: duplicate }
    : { delete: remove, backspace: remove, escape: clear };
  const run = actions[key];
  if (run) {
    e.preventDefault();
    run();
  }
});

// Drop the selection when switching tools or pages; follow the view while panning/zooming.
let shownTool = state.tool;
let shownPage = page().id;
subscribe(() => {
  if (state.tool !== shownTool || page().id !== shownPage) {
    const pageChanged = page().id !== shownPage;
    shownTool = state.tool;
    shownPage = page().id;
    if (state.tool !== 'lasso' || pageChanged) clear();
  }
  // Undo can remove selected items; keep only what still exists.
  const ids = new Set(page().strokes.map((s) => s.id));
  const tids = new Set(page().texts.map((t) => t.id));
  for (const id of selected.strokes) if (!ids.has(id)) selected.strokes.delete(id);
  for (const id of selected.texts) if (!tids.has(id)) selected.texts.delete(id);
  placeFrame();
  updatePasteChip();
});
new MutationObserver(() => placeFrame()).observe(textLayer, {
  attributes: true,
  attributeFilter: ['style'],
});
