import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  Image as ImageIcon,
  Layers,
  Lock,
  PaintBucket,
  RotateCw,
  Scissors,
  SendToBack,
  Stamp as StampIcon,
  Trash2,
  Type,
  Ungroup,
  X,
} from 'lucide';
import { capture, clamp, h, icon, openMenu, toast } from './dom';
import { imageBox, loadAll } from './images';
import { commitSnapshot, type Snapshot, snapshot } from './ink';
import { recognizeInk } from './ocr';
import {
  shapeBox,
  centre as shapeCentre,
  ends as shapeEnds,
  byId as shapesById,
  unbindGone,
} from './shape-geom';
import { addStamp, type Stamp, setInserter } from './stamps';
import {
  type ImageItem,
  isBox,
  PALETTE,
  page,
  type Shape,
  type Stroke,
  state,
  subscribe,
  type TextBox,
  uid,
  update,
} from './store';
import { bbox, LINE_HEIGHT } from './stroke';
import { renderTexts } from './text';
import { colorName, shown } from './toolbar';
import {
  drawPage,
  isPalm,
  penSeen,
  redraw,
  tooBig,
  toScreen,
  touchCount,
  toWorld,
  view,
} from './viewport';

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

/** Everything a selection, the clipboard or a paste can hold. */
interface Items {
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  shapes?: Shape[];
}
let selected = {
  strokes: new Set<string>(),
  texts: new Set<string>(),
  images: new Set<string>(),
  shapes: new Set<string>(),
};
let clipboard: Items | null = null;
let pasteCount = 0;

const hasSelection = () =>
  selected.strokes.size + selected.texts.size + selected.images.size + selected.shapes.size > 0;
const picked = (): Items => ({
  strokes: page().strokes.filter((s) => selected.strokes.has(s.id)),
  texts: page().texts.filter((t) => selected.texts.has(t.id)),
  images: page().images.filter((i) => selected.images.has(i.id)),
  shapes: (page().shapes ?? []).filter((s) => selected.shapes.has(s.id)),
});

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

function worldBox({ strokes, texts, images, shapes = [] }: Items) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const sMap = shapesById([...(page().shapes ?? []), ...shapes]);
  for (const s of shapes) {
    const k = shapeBox(s, sMap);
    b[0] = Math.min(b[0]!, k[0]);
    b[1] = Math.min(b[1]!, k[1]);
    b[2] = Math.max(b[2]!, k[2]);
    b[3] = Math.max(b[3]!, k[3]);
  }
  for (const im of images) {
    const k = imageBox(im);
    b[0] = Math.min(b[0]!, k[0]);
    b[1] = Math.min(b[1]!, k[1]);
    b[2] = Math.max(b[2]!, k[2]);
    b[3] = Math.max(b[3]!, k[3]);
  }
  for (const s of strokes) {
    const k = bbox(s);
    b[0] = Math.min(b[0]!, k[0]);
    b[1] = Math.min(b[1]!, k[1]);
    b[2] = Math.max(b[2]!, k[2]);
    b[3] = Math.max(b[3]!, k[3]);
  }
  for (const t of texts) {
    // Corners of the (possibly rotated) box, turned around its top-left like CSS draws it.
    const cos = Math.cos(t.angle ?? 0);
    const sin = Math.sin(t.angle ?? 0);
    const th = textHeight(t);
    for (const [x, y] of [
      [0, 0],
      [t.w, 0],
      [0, th],
      [t.w, th],
    ] as const) {
      const cx = t.x + x * cos - y * sin;
      const cy = t.y + x * sin + y * cos;
      b[0] = Math.min(b[0]!, cx);
      b[1] = Math.min(b[1]!, cy);
      b[2] = Math.max(b[2]!, cx);
      b[3] = Math.max(b[3]!, cy);
    }
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
      const angle = (t.angle ?? 0) + Math.atan2(m.b, m.a);
      return { ...t, x: p.x, y: p.y, w: t.w * scale, size: t.size * scale, angle };
    }),
    // Pictures move, scale and rotate with the ink drawn on them, so annotations stay aligned.
    images: (base.images ?? page().images).map((im) => {
      if (!selected.images.has(im.id)) return im;
      const c = apply(m, im.cx, im.cy);
      const turn = Math.atan2(m.b, m.a);
      return { ...im, cx: c.x, cy: c.y, w: im.w * scale, h: im.h * scale, angle: im.angle + turn };
    }),
    shapes: transformedShapes(base.shapes ?? page().shapes ?? [], m, scale),
  };
}

/** Shapes move, scale and turn with the selection; a selected arrow keeps its binding only to
 *  shapes that move with it (otherwise its ends become plain points). */
function transformedShapes(list: Shape[], m: Matrix, scale: number): Shape[] {
  const map = shapesById(list);
  const turn = Math.atan2(m.b, m.a);
  return list.map((s) => {
    if (!selected.shapes.has(s.id)) return s;
    if (isBox(s)) {
      const c = apply(m, s.cx, s.cy);
      return {
        ...s,
        cx: c.x,
        cy: c.y,
        w: s.w * scale,
        h: s.h * scale,
        angle: s.angle + turn,
        width: s.width * scale,
      };
    }
    const { a, b } = shapeEnds(s, map);
    const p = apply(m, a.x, a.y);
    const q = apply(m, b.x, b.y);
    const { bindStart, bindEnd, ...rest } = s;
    return {
      ...rest,
      x1: p.x,
      y1: p.y,
      x2: q.x,
      y2: q.y,
      width: s.width * scale,
      ...(bindStart && selected.shapes.has(bindStart) ? { bindStart } : {}),
      ...(bindEnd && selected.shapes.has(bindEnd) ? { bindEnd } : {}),
    };
  });
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
  const b = worldBox(picked());
  const pad = 8;
  // The frame sits on the page: at the box's top-left corner, turned with the view.
  const corner = toScreen(b.x, b.y);
  frame.style.left = `${corner.x}px`;
  frame.style.top = `${corner.y}px`;
  frame.style.width = `${b.w * view.scale + pad * 2}px`;
  frame.style.height = `${b.h * view.scale + pad * 2}px`;
  frame.style.transform = `rotate(${view.angle}rad) translate(${-pad}px, ${-pad}px)`;
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
    btn('Copy as a picture', ImageIcon, () => void copyAsPicture()),
    btn('Save as stamp', StampIcon, () => void saveStamp()),
    ...([...selected.strokes].length
      ? [btn('Convert handwriting to text', Type, () => void toText())]
      : []),
    ...(clipboard ? [btn('Paste (Ctrl+V)', ClipboardPaste, paste)] : []),
    ...(selected.shapes.size
      ? [
          (() => {
            const b: HTMLElement = btn('Shape style', PaintBucket, () => openMenu(b, styleItems()));
            return b;
          })(),
        ]
      : []),
    ...(arrangeItems().length
      ? [
          (() => {
            const b: HTMLElement = btn('Arrange', Layers, () => openMenu(b, arrangeItems()));
            return b;
          })(),
        ]
      : []),
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

export function select(
  strokes: Iterable<string>,
  texts: Iterable<string>,
  images: Iterable<string> = [],
  shapes: Iterable<string> = [],
) {
  selected = {
    strokes: new Set(strokes),
    texts: new Set(texts),
    images: new Set(images),
    shapes: new Set(shapes),
  };
  renderBar();
  placeFrame();
  updatePasteChip();
}
const clear = () => select([], []);

// --- Actions ---

function copy() {
  if (!hasSelection()) return;
  clipboard = picked();
  pasteCount = 0;
  toast('Copied — tap Paste to place it.', 1800);
  updatePasteChip();
}

function remove() {
  if (!hasSelection()) return;
  const before = snapshot();
  const sMap = shapesById(before.shapes ?? []);
  commitSnapshot(before, {
    strokes: before.strokes.filter((s) => !selected.strokes.has(s.id)),
    texts: before.texts.filter((t) => !selected.texts.has(t.id)),
    images: page().images.filter((i) => !selected.images.has(i.id)),
    shapes: (before.shapes ?? [])
      .filter((s) => !selected.shapes.has(s.id))
      .map((s) => unbindGone(s, selected.shapes, sMap)),
  });
  clear();
}

function cut() {
  copy();
  remove();
}

/** Renders items on a plain page as a PNG blob, `scale` px per page px, with `pad` around them. */
async function renderItems(sel: Items, scale: number, pad: number) {
  const b = worldBox(sel);
  const w = Math.max(1, Math.ceil((b.w + pad * 2) * scale));
  const ph = Math.max(1, Math.ceil((b.h + pad * 2) * scale));
  // Just these items on a plain page (no sheet, no template around them).
  const sub = {
    ...page(),
    strokes: sel.strokes,
    texts: sel.texts,
    images: sel.images,
    shapes: sel.shapes ?? [],
    codes: undefined,
    paper: undefined,
    background: 'blank',
  } as ReturnType<typeof page>;
  await loadAll([sub]);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = ph;
  drawPage(
    c.getContext('2d')!,
    w,
    ph,
    sub,
    { x: (pad - b.x) * scale, y: (pad - b.y) * scale, scale },
    scale,
  );
  return { c, blob: await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png')), box: b };
}

/** Keeps the selection as a stamp: the items moved to the origin, with a preview. */
async function saveStamp() {
  if (!hasSelection()) return;
  const sel = picked();
  const { c, box } = await renderItems(sel, Math.min(1, 120 / Math.max(box0(sel), 1)), 4);
  const norm = (dx: number, dy: number): Stamp['items'] => ({
    strokes: sel.strokes.map((s) => ({
      ...s,
      points: s.points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)),
    })),
    texts: sel.texts.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy })),
    images: sel.images.map((im) => ({ ...im, cx: im.cx + dx, cy: im.cy + dy })),
    shapes: cloneShapes(sel.shapes ?? [], dx, dy),
  });
  await addStamp({
    id: uid(),
    name: `Stamp ${new Date().toLocaleDateString()}`,
    items: norm(-box.x, -box.y),
    w: box.w,
    h: box.h,
    thumb: c.toDataURL('image/png'),
  });
  toast('Saved as a stamp. Use it from Insert → Stamps.', 2800);
}
const box0 = (sel: Items) => {
  const b = worldBox(sel);
  return Math.max(b.w, b.h);
};
// A stamp goes in the middle of the screen, selected.
setInserter((s) => {
  const r = bg.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  insert(s.items, c.x - s.w / 2, c.y - s.h / 2);
});

/** The selection as a PNG on the system clipboard (or a download where the browser can't). */
async function copyAsPicture() {
  if (!hasSelection()) return;
  const sel = picked();
  const b = worldBox(sel);
  const pad = 16;
  const scale = Math.min(2, 3000 / Math.max(b.w + pad * 2, b.h + pad * 2, 1));
  const { blob } = await renderItems(sel, scale, pad);
  if (!blob) return toast('Couldn’t make the picture.', 2500);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied as a picture — paste it anywhere.', 2200);
  } catch {
    const a = h('a', { href: URL.createObjectURL(blob), download: 'inkwell-selection.png' });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Saved as a picture (this browser can’t copy images).', 2800);
  }
}

/** Reads the selected handwriting and replaces it with a text box (Undo brings the ink back). */
async function toText() {
  const ink = page().strokes.filter((s) => selected.strokes.has(s.id) && s.tool === 'pen');
  if (!ink.length) return;
  const pageId = page().id;
  toast('Reading your handwriting…', 8000);
  let text = '';
  try {
    text = await recognizeInk(ink);
  } catch {
    toast(
      'Handwriting reading needs a one-time download. Connect to the internet and try again.',
      5000,
    );
    return;
  }
  if (page().id !== pageId) return; // moved on to another page meanwhile
  if (!text) {
    toast("Couldn't read that. Clear, separate letters work best.", 3500);
    return;
  }
  const boxes = ink.map(bbox);
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[2]));
  const y1 = Math.max(...boxes.map((b) => b[3]));
  const lines = text.split('\n').length;
  const box: TextBox = {
    id: uid(),
    x: x0,
    y: y0,
    w: Math.max(80, x1 - x0 + 24),
    text,
    font: 'sans',
    size: Math.round(Math.min(72, Math.max(12, (y1 - y0) / lines / LINE_HEIGHT))),
    color: ink[0]!.color,
    bold: false,
    italic: false,
  };
  const before = snapshot();
  const gone = new Set(ink.map((s) => s.id));
  commitSnapshot(before, {
    strokes: before.strokes.filter((s) => !gone.has(s.id)),
    texts: [...before.texts, box],
  });
  clear();
  toast(
    `Converted: “${text.length > 40 ? `${text.slice(0, 40)}…` : text}” · Undo brings the ink back`,
    4000,
  );
}

export function insert(items: Items, dx: number, dy = dx) {
  const strokes = items.strokes.map((s) => {
    const points = s.points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v));
    return { ...s, id: uid(), points };
  });
  const texts = items.texts.map((t) => ({ ...t, id: uid(), x: t.x + dx, y: t.y + dy }));
  // Copies share the stored picture file; only the placement is new.
  const images = items.images.map((im) => ({ ...im, id: uid(), cx: im.cx + dx, cy: im.cy + dy }));
  const shapes = cloneShapes(items.shapes ?? [], dx, dy);
  const before = snapshot();
  commitSnapshot(before, {
    strokes: [...before.strokes, ...strokes],
    texts: [...before.texts, ...texts],
    images: [...page().images, ...images],
    shapes: [...(before.shapes ?? []), ...shapes],
  });
  if (state.tool !== 'lasso') {
    update((s) => {
      s.tool = 'lasso';
    });
  }
  select(
    strokes.map((s) => s.id),
    texts.map((t) => t.id),
    images.map((i) => i.id),
    shapes.map((s) => s.id),
  );
}

/** Copies of shapes, moved by (dx, dy): new ids, groups kept together, arrows bound to copies. */
function cloneShapes(list: Shape[], dx: number, dy: number): Shape[] {
  const ids = new Map(list.map((s) => [s.id, uid()]));
  const groups = new Map<string, string>();
  const map = shapesById([...(page().shapes ?? []), ...list]);
  return list.map((s) => {
    const { bindStart, bindEnd, group, locked: _locked, ...rest } = s;
    const copy: Shape = { ...rest, id: ids.get(s.id)! };
    if (group) {
      if (!groups.has(group)) groups.set(group, uid());
      copy.group = groups.get(group);
    }
    if (isBox(s)) {
      copy.cx = s.cx + dx;
      copy.cy = s.cy + dy;
      return copy;
    }
    const { a, b } = shapeEnds(s, map);
    copy.x1 = a.x + dx;
    copy.y1 = a.y + dy;
    copy.x2 = b.x + dx;
    copy.y2 = b.y + dy;
    if (bindStart && ids.has(bindStart)) copy.bindStart = ids.get(bindStart);
    if (bindEnd && ids.has(bindEnd)) copy.bindEnd = ids.get(bindEnd);
    return copy;
  });
}

let pendingPaste = false;
/** A system-clipboard picture is being pasted: skip the pending paste of copied ink. */
export const takeOverPaste = () => {
  pendingPaste = false;
};

/** Pastes into the middle of what's on screen (the original may be off-screen or on another page). */
function paste() {
  if (!clipboard) return;
  const b = worldBox(clipboard);
  const r = bg.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const step = PASTE_OFFSET * pasteCount++; // repeated pastes fan out instead of stacking
  insert(clipboard, c.x - (b.x + b.w / 2) + step, c.y - (b.y + b.h / 2) + step);
}

function duplicate() {
  if (hasSelection()) insert(picked(), PASTE_OFFSET);
}

function recolor(color: string) {
  const before = snapshot();
  commitSnapshot(before, {
    strokes: before.strokes.map((s) => (selected.strokes.has(s.id) ? { ...s, color } : s)),
    texts: before.texts.map((t) => (selected.texts.has(t.id) ? { ...t, color } : t)),
    shapes: (before.shapes ?? []).map((s) => (selected.shapes.has(s.id) ? { ...s, color } : s)),
  });
  placeFrame();
}

// --- Arrange (order, group, lock, align, distribute) and shape style ---

interface Entry {
  id: string;
  box: [number, number, number, number];
}
/** Every selected item with its box (strokes, text boxes, pictures, shapes). */
function entries(): Entry[] {
  const sel = picked();
  const sMap = shapesById(page().shapes ?? []);
  return [
    ...sel.strokes.map((s) => ({ id: s.id, box: bbox(s) })),
    ...sel.texts.map((t) => {
      const b = worldBox({ strokes: [], texts: [t], images: [] });
      return {
        id: t.id,
        box: [b.x, b.y, b.x + b.w, b.y + b.h] as [number, number, number, number],
      };
    }),
    ...sel.images.map((im) => ({ id: im.id, box: imageBox(im) })),
    // An arrow attached to a selected shape follows that shape: it isn't aligned on its own.
    ...(sel.shapes ?? [])
      .filter(
        (s) =>
          isBox(s) ||
          !(
            (s.bindStart && selected.shapes.has(s.bindStart)) ||
            (s.bindEnd && selected.shapes.has(s.bindEnd))
          ),
      )
      .map((s) => ({ id: s.id, box: shapeBox(s, sMap) })),
  ];
}

/** Moves each item by its own offset. */
function shifted(base: Snapshot, d: Map<string, { dx: number; dy: number }>): Snapshot {
  const sMap = shapesById(base.shapes ?? []);
  return {
    strokes: base.strokes.map((s) => {
      const o = d.get(s.id);
      if (!o) return s;
      return {
        ...s,
        points: s.points.map((v, i) => (i % 3 === 0 ? v + o.dx : i % 3 === 1 ? v + o.dy : v)),
      };
    }),
    texts: base.texts.map((t) => {
      const o = d.get(t.id);
      return o ? { ...t, x: t.x + o.dx, y: t.y + o.dy } : t;
    }),
    images: (base.images ?? []).map((im) => {
      const o = d.get(im.id);
      return o ? { ...im, cx: im.cx + o.dx, cy: im.cy + o.dy } : im;
    }),
    shapes: (base.shapes ?? []).map((s) => {
      const o = d.get(s.id);
      if (!o) return s;
      if (isBox(s)) return { ...s, cx: s.cx + o.dx, cy: s.cy + o.dy };
      const { a, b } = shapeEnds(s, sMap);
      const { bindStart: _a, bindEnd: _b, ...rest } = s;
      return { ...rest, x1: a.x + o.dx, y1: a.y + o.dy, x2: b.x + o.dx, y2: b.y + o.dy };
    }),
  };
}

type Align = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
function align(mode: Align) {
  const es = entries();
  if (es.length < 2) return;
  const x0 = Math.min(...es.map((e) => e.box[0]));
  const x1 = Math.max(...es.map((e) => e.box[2]));
  const y0 = Math.min(...es.map((e) => e.box[1]));
  const y1 = Math.max(...es.map((e) => e.box[3]));
  const d = new Map(
    es.map((e) => {
      const [a, b, c, f] = e.box;
      const dx =
        { left: x0 - a, hcenter: (x0 + x1) / 2 - (a + c) / 2, right: x1 - c }[mode as 'left'] ?? 0;
      const dy =
        { top: y0 - b, vcenter: (y0 + y1) / 2 - (b + f) / 2, bottom: y1 - f }[mode as 'top'] ?? 0;
      return [e.id, { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 }];
    }),
  );
  const before = snapshot();
  commitSnapshot(before, shifted(before, d));
  placeFrame();
}

/** Equal gaps between the middle items; the outer two stay where they are. */
function distribute(axis: 'h' | 'v') {
  const es = entries();
  if (es.length < 3) return;
  const lo = axis === 'h' ? 0 : 1;
  const mid = (e: Entry) => (e.box[lo]! + e.box[lo + 2]!) / 2;
  const sorted = [...es].sort((a, b) => mid(a) - mid(b));
  const first = mid(sorted[0]!);
  const step = (mid(sorted[sorted.length - 1]!) - first) / (sorted.length - 1);
  const d = new Map(
    sorted.map((e, i) => {
      const delta = first + step * i - mid(e);
      return [e.id, axis === 'h' ? { dx: delta, dy: 0 } : { dx: 0, dy: delta }];
    }),
  );
  const before = snapshot();
  commitSnapshot(before, shifted(before, d));
  placeFrame();
}

/** Applies `fn` to the selected shapes as one undo step. */
function editShapes(
  fn: (s: Shape, i: number, all: Shape[]) => Shape,
  reorder?: (all: Shape[]) => Shape[],
) {
  const before = snapshot();
  const all = before.shapes ?? [];
  const next = all.map((s, i) => (selected.shapes.has(s.id) ? fn(s, i, all) : s));
  commitSnapshot(before, {
    strokes: before.strokes,
    texts: before.texts,
    shapes: reorder ? reorder(next) : next,
  });
  placeFrame();
}
const order = (front: boolean) =>
  editShapes(
    (s) => s,
    (all) => {
      const mine = all.filter((s) => selected.shapes.has(s.id));
      const rest = all.filter((s) => !selected.shapes.has(s.id));
      return front ? [...rest, ...mine] : [...mine, ...rest];
    },
  );
function group(on: boolean) {
  const g = uid();
  editShapes((s) => {
    const { group: _g, ...rest } = s;
    return on ? { ...rest, group: g } : rest;
  });
}
function lock() {
  editShapes((s) => ({ ...s, locked: true }));
  clear(); // a locked shape can't be selected
  toast('Locked. Unlock from the Shapes panel.', 2500);
}

const MenuIcon = (node: typeof Copy) => node;
function arrangeItems() {
  const n = entries().length;
  const shapes = selected.shapes.size > 0;
  const item = (label: string, ic: typeof Copy, run: () => void) => ({
    label,
    icon: MenuIcon(ic),
    run,
  });
  return [
    ...(shapes
      ? [
          item('Bring to front', BringToFront, () => order(true)),
          item('Send to back', SendToBack, () => order(false)),
          item('Group', Group, () => group(true)),
          item('Ungroup', Ungroup, () => group(false)),
          item('Lock', Lock, lock),
        ]
      : []),
    ...(n >= 2
      ? [
          ...(shapes ? ['sep' as const] : []),
          item('Align left', AlignStartVertical, () => align('left')),
          item('Align centre', AlignCenterVertical, () => align('hcenter')),
          item('Align right', AlignEndVertical, () => align('right')),
          item('Align top', AlignStartHorizontal, () => align('top')),
          item('Align middle', AlignCenterHorizontal, () => align('vcenter')),
          item('Align bottom', AlignEndHorizontal, () => align('bottom')),
        ]
      : []),
    ...(n >= 3
      ? [
          'sep' as const,
          item('Distribute horizontally', AlignHorizontalDistributeCenter, () => distribute('h')),
          item('Distribute vertically', AlignVerticalDistributeCenter, () => distribute('v')),
        ]
      : []),
  ];
}

function styleItems() {
  const chosen = picked().shapes ?? [];
  const same = <K extends 'fill' | 'dash'>(k: K, v: Shape[K]) =>
    chosen.length > 0 && chosen.every((s) => s[k] === v);
  const item = (label: string, checked: boolean, run: () => void) => ({
    label,
    icon: PaintBucket,
    checked,
    run,
  });
  const lines = chosen.filter((s) => !isBox(s));
  return [
    ...(chosen.some(isBox)
      ? [
          item('No fill', same('fill', 'none'), () =>
            editShapes((s) => (isBox(s) ? { ...s, fill: 'none' } : s)),
          ),
          item('Light fill', same('fill', 'tint'), () =>
            editShapes((s) => (isBox(s) ? { ...s, fill: 'tint' } : s)),
          ),
          item('Solid fill', same('fill', 'solid'), () =>
            editShapes((s) => (isBox(s) ? { ...s, fill: 'solid' } : s)),
          ),
          item('Hatched', same('fill', 'hatch'), () =>
            editShapes((s) => (isBox(s) ? { ...s, fill: 'hatch' } : s)),
          ),
          'sep' as const,
        ]
      : []),
    item('Solid line', same('dash', 'solid'), () => editShapes((s) => ({ ...s, dash: 'solid' }))),
    item('Dashed line', same('dash', 'dashed'), () =>
      editShapes((s) => ({ ...s, dash: 'dashed' })),
    ),
    item('Dotted line', same('dash', 'dotted'), () =>
      editShapes((s) => ({ ...s, dash: 'dotted' })),
    ),
    ...(lines.some((s) => s.kind === 'arrow')
      ? [
          'sep' as const,
          ...(
            [
              ['Small arrow head', 0.6],
              ['Normal arrow head', 1],
              ['Large arrow head', 1.6],
              ['Huge arrow head', 2.4],
            ] as const
          ).map(([label, k]) =>
            item(
              label,
              lines.filter((s) => s.kind === 'arrow').every((s) => (s.head ?? 1) === k),
              () =>
                editShapes((s) =>
                  s.kind === 'arrow'
                    ? k === 1
                      ? (({ head: _h, ...rest }) => rest as Shape)(s)
                      : { ...s, head: k }
                    : s,
                ),
            ),
          ),
        ]
      : []),
    ...(lines.length
      ? [
          'sep' as const,
          item(
            'Arrow head',
            lines.every((s) => s.kind === 'arrow'),
            () =>
              editShapes((s) =>
                isBox(s)
                  ? s
                  : { ...s, kind: lines.every((l) => l.kind === 'arrow') ? 'line' : 'arrow' },
              ),
          ),
        ]
      : []),
  ];
}

// --- Gestures ---

const allowed = (e: PointerEvent) =>
  e.button === 0 && (e.pointerType !== 'touch' || (!penSeen && !isPalm(e) && touchCount() === 1));
// The frame and its handles are deliberate controls, so one finger works on them even after the
// pen has been used, and a selection made with the pen can be moved, resized and rotated by hand.
// (Fingers are only counted on the canvas, so the old canvas rule rejected every touch here.)
// Palm-sized contacts and second fingers are still ignored.
const grabbable = (e: PointerEvent) =>
  e.button === 0 && (e.pointerType !== 'touch' || (e.isPrimary && !tooBig(e)));

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
    if (last.images) page().images = last.images;
    if (last.shapes) page().shapes = last.shapes;
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
    if (base.images) page().images = base.images;
    if (base.shapes) page().shapes = base.shapes;
    commitSnapshot(base, last);
    placeFrame();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

frame.addEventListener('pointerdown', (e) => {
  if (!grabbable(e) || e.target !== frame) return;
  const start = toWorld(e.clientX, e.clientY);
  drag(e, frame, (m, base) => {
    const w = toWorld(m.clientX, m.clientY);
    return transformed(base, transform(start, 1, 0, w.x - start.x, w.y - start.y), 1);
  });
});

for (const handle of scaleHandles) {
  handle.addEventListener('pointerdown', (e) => {
    if (!grabbable(e)) return;
    const b = worldBox(picked());
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
  if (!grabbable(e)) return;
  const b = worldBox(picked());
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
    // A picture is selected when the loop goes around its centre.
    const images = page().images.filter((im) => inside({ x: im.cx, y: im.cy }, loop));
    // A shape when the loop goes around its centre; locked ones can't be picked, and a grouped
    // shape brings its whole group.
    const all = page().shapes ?? [];
    const sMap = shapesById(all);
    const hit = all.filter((s) => !s.locked && inside(shapeCentre(s, sMap), loop));
    const groups = new Set(hit.flatMap((s) => (s.group ? [s.group] : [])));
    const shapes = groups.size
      ? all.filter((s) => !s.locked && (hit.includes(s) || (s.group && groups.has(s.group))))
      : hit;
    select(
      strokes.map((s) => s.id),
      texts.map((t) => t.id),
      images.map((i) => i.id),
      shapes.map((s) => s.id),
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
    // Wait a moment for the browser's paste event: a picture on the system clipboard wins.
    pendingPaste = true;
    setTimeout(() => {
      if (pendingPaste) paste();
      pendingPaste = false;
    }, 60);
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
  const iids = new Set(page().images.map((i) => i.id));
  for (const id of selected.images) if (!iids.has(id)) selected.images.delete(id);
  const shids = new Set((page().shapes ?? []).map((s) => s.id));
  for (const id of selected.shapes) if (!shids.has(id)) selected.shapes.delete(id);
  placeFrame();
  updatePasteChip();
});
new MutationObserver(() => placeFrame()).observe(textLayer, {
  attributes: true,
  attributeFilter: ['style'],
});
