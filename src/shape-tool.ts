import { capture } from './dom';
import { commitSnapshot, snapshot } from './ink';
import { select } from './lasso';
import { drawShapes } from './shape-draw';
import { byId, inPolygon, type Pt, polygon, shapeBox, snapTo } from './shape-geom';
import { isBox, page, type Shape, state, uid, update } from './store';
import { isPalm, penSeen, touchCount, toWorld, view, viewMatrix } from './viewport';

// The Shapes tool (O): drag to draw a rectangle, ellipse, diamond, line or arrow in the pen's colour
// and width. Shift makes squares, circles and 15° lines. Points snap to the edges and centres of
// other shapes (guide lines show it), and an arrow that starts or ends on a shape binds to it, so it
// follows that shape when it moves. A tap draws a default-sized one. Afterwards the lasso takes over
// with the new shape selected, ready to move, resize or rotate.

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const live = document.querySelector<HTMLCanvasElement>('#live')!;

const MIN_DRAG_PX = 6;
const SNAP_PX = 7;
const TAP_SIZE = { w: 140, h: 90 };

const allowed = (e: PointerEvent) =>
  e.button === 0 && (e.pointerType !== 'touch' || (!penSeen && !isPalm(e) && touchCount() === 1));

const shapesOnPage = (): Shape[] => page().shapes ?? [];

/** Edges and centres other shapes offer for snapping. */
function targets(): [number, number, number, number][] {
  const all = shapesOnPage();
  const map = byId(all);
  return all.map((s) => shapeBox(s, map));
}

/** The box shape (topmost) the point is on or just outside of: what an arrow end binds to. */
function boxAt(p: Pt, slack: number): Shape | undefined {
  for (const s of [...shapesOnPage()].reverse()) {
    if (!isBox(s) || s.locked) continue;
    if (inPolygon(p, polygon(s))) return s;
    const [x0, y0, x1, y1] = shapeBox(s, byId([s]));
    if (p.x >= x0 - slack && p.x <= x1 + slack && p.y >= y0 - slack && p.y <= y1 + slack) return s;
  }
  return undefined;
}

/** The shape being dragged out, from its two corners/ends. */
function draft(a: Pt, b: Pt, shift: boolean): Shape {
  const pen = state.styles.pen;
  const base = {
    id: uid(),
    color: pen.color,
    width: pen.width,
    opacity: pen.opacity,
    fill: state.shapeFill,
    dash: state.shapeDash,
    cx: 0,
    cy: 0,
    w: 0,
    h: 0,
    angle: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
  };
  const kind = state.shapeKind;
  if (kind === 'line' || kind === 'arrow') {
    let end = b;
    if (shift) {
      // 15° steps.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
      end = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    const head = kind === 'arrow' && state.shapeHead !== 1 ? { head: state.shapeHead } : {};
    return { ...base, ...head, kind, x1: a.x, y1: a.y, x2: end.x, y2: end.y };
  }
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (shift) w = h = Math.max(w, h);
  const sx = b.x < a.x ? -1 : 1;
  const sy = b.y < a.y ? -1 : 1;
  const cx = a.x + (sx * w) / 2;
  const cy = a.y + (sy * h) / 2;
  return { ...base, kind, cx, cy, w: Math.max(1, w), h: Math.max(1, h) };
}

/** An arrow's ends bind to the shapes they start or end on. */
function bind(s: Shape): Shape {
  if (s.kind !== 'arrow') return s;
  const slack = 10 / view.scale;
  const from = boxAt({ x: s.x1, y: s.y1 }, slack);
  const to = boxAt({ x: s.x2, y: s.y2 }, slack);
  return {
    ...s,
    ...(from ? { bindStart: from.id } : {}),
    ...(to && to !== from ? { bindEnd: to.id } : {}),
  };
}

// --- Preview on the wet-ink canvas (it isn't used by this tool) ---

function show(s: Shape | null, guides: { axis: 'x' | 'y'; at: number }[] = []) {
  const ctx = live.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, live.width, live.height);
  if (!s) return;
  const dpr = devicePixelRatio;
  ctx.setTransform(...viewMatrix(dpr));
  const dark = document.documentElement.dataset.theme === 'dark';
  // The shapes it will bind to are drawn with it, so a bound arrow previews where it will end.
  drawShapes(
    ctx,
    [...shapesOnPage().filter((x) => x.id === s.bindStart || x.id === s.bindEnd), s],
    dark,
  );
  ctx.lineWidth = 1 / view.scale;
  ctx.strokeStyle = 'rgba(0, 144, 255, 0.8)';
  ctx.setLineDash([4 / view.scale, 4 / view.scale]);
  const r = bg.getBoundingClientRect();
  const lo = toWorld(r.left, r.top);
  const hi = toWorld(r.right, r.bottom);
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === 'x') {
      ctx.moveTo(g.at, lo.y);
      ctx.lineTo(g.at, hi.y);
    } else {
      ctx.moveTo(lo.x, g.at);
      ctx.lineTo(hi.x, g.at);
    }
    ctx.stroke();
  }
}

bg.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'shape' || !allowed(e)) return;
  e.preventDefault();
  capture(bg, e.pointerId);
  const tol = SNAP_PX / view.scale;
  const snapped = (p: Pt) => snapTo(p, targets(), tol);
  const first = snapped(toWorld(e.clientX, e.clientY));
  const origin = first.p;
  const screen0 = { x: e.clientX, y: e.clientY };
  let moved = false;
  let current: Shape | null = null;
  const move = (m: PointerEvent) => {
    if (Math.hypot(m.clientX - screen0.x, m.clientY - screen0.y) >= MIN_DRAG_PX) moved = true;
    if (!moved) return;
    const s = snapped(toWorld(m.clientX, m.clientY));
    current = bind(draft(origin, s.p, m.shiftKey));
    show(current, [...first.guides, ...s.guides]);
  };
  const up = (u: PointerEvent) => {
    bg.removeEventListener('pointermove', move);
    bg.removeEventListener('pointerup', up);
    bg.removeEventListener('pointercancel', up);
    show(null);
    if (u.type === 'pointercancel') return;
    let shape = current;
    if (!moved || !shape) {
      // A tap: a default-sized shape centred on the tap.
      const k = state.shapeKind;
      const line = k === 'line' || k === 'arrow';
      shape = bind(
        draft(
          {
            x: origin.x - (line ? TAP_SIZE.w / 2 : TAP_SIZE.w / 2),
            y: origin.y - (line ? 0 : TAP_SIZE.h / 2),
          },
          { x: origin.x + TAP_SIZE.w / 2, y: origin.y + (line ? 0 : TAP_SIZE.h / 2) },
          false,
        ),
      );
    }
    const before = snapshot();
    commitSnapshot(before, {
      strokes: before.strokes,
      texts: before.texts,
      shapes: [...(before.shapes ?? []), shape],
    });
    // The lasso takes over, with the new shape selected.
    update((s) => {
      s.tool = 'lasso';
    });
    select([], [], [], [shape.id]);
  };
  bg.addEventListener('pointermove', move);
  bg.addEventListener('pointerup', up);
  bg.addEventListener('pointercancel', up);
});

// Leaving the tool mid-drag (or switching pages) must not leave a preview behind.
addEventListener('blur', () => show(null));
