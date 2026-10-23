import type { Shape } from './store.ts';

// Geometry of shapes (see Shape in store.ts): outlines, hit tests, boxes, where an arrow meets a
// shape it is bound to, hatching, SVG paths and alignment guides. No browser code, so
// shape-geom.check.ts runs in Node; drawing is in shapes.ts.

export type Pt = { x: number; y: number };
const isBox = (s: Pick<Shape, 'kind'>) =>
  s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond';
export type ById = ReadonlyMap<string, Shape>;
export const byId = (shapes: readonly Shape[]): ById => new Map(shapes.map((s) => [s.id, s]));

const rot = (p: Pt, a: number): Pt => ({
  x: p.x * Math.cos(a) - p.y * Math.sin(a),
  y: p.x * Math.sin(a) + p.y * Math.cos(a),
});
/** A point in the box's own frame (origin at its centre, unturned). */
const toLocal = (s: Shape, p: Pt): Pt => rot({ x: p.x - s.cx, y: p.y - s.cy }, -s.angle);
const toWorldPt = (s: Shape, p: Pt): Pt => {
  const r = rot(p, s.angle);
  return { x: r.x + s.cx, y: r.y + s.cy };
};

/** The outline of a box as a polygon in world coordinates (an ellipse as a 64-gon). */
export function polygon(s: Shape): Pt[] {
  const hw = s.w / 2;
  const hh = s.h / 2;
  let local: Pt[];
  if (s.kind === 'ellipse') {
    local = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return { x: Math.cos(a) * hw, y: Math.sin(a) * hh };
    });
  } else if (s.kind === 'diamond') {
    local = [
      { x: 0, y: -hh },
      { x: hw, y: 0 },
      { x: 0, y: hh },
      { x: -hw, y: 0 },
    ];
  } else {
    local = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];
  }
  return local.map((p) => toWorldPt(s, p));
}

/** Where the line from the box's centre towards `toward` leaves the box. */
export function boundary(s: Shape, toward: Pt): Pt {
  const t = toLocal(s, toward);
  const len = Math.hypot(t.x, t.y);
  if (len < 1e-6) return { x: s.cx, y: s.cy };
  const dx = t.x / len;
  const dy = t.y / len;
  const hw = Math.max(s.w / 2, 1e-6);
  const hh = Math.max(s.h / 2, 1e-6);
  let k: number;
  if (s.kind === 'ellipse') k = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (s.kind === 'diamond') k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else k = Math.min(hw / Math.max(Math.abs(dx), 1e-9), hh / Math.max(Math.abs(dy), 1e-9));
  return toWorldPt(s, { x: dx * k, y: dy * k });
}

/** The two ends of a line or arrow, with bound ends worked out from the shapes they follow. */
export function ends(s: Shape, shapes: ById): { a: Pt; b: Pt } {
  let a: Pt = { x: s.x1, y: s.y1 };
  let b: Pt = { x: s.x2, y: s.y2 };
  const from = s.bindStart ? shapes.get(s.bindStart) : undefined;
  const to = s.bindEnd ? shapes.get(s.bindEnd) : undefined;
  const fromOk = from && isBox(from);
  const toOk = to && isBox(to);
  // Aim each bound end at the other end (or at the other shape's centre).
  const aimA = toOk ? { x: to!.cx, y: to!.cy } : b;
  const aimB = fromOk ? { x: from!.cx, y: from!.cy } : a;
  if (fromOk) a = boundary(from!, aimA);
  if (toOk) b = boundary(to!, aimB);
  return { a, b };
}

/** The two short strokes of an arrow head at `b`, pointing along a→b. */
export function arrowHead(a: Pt, b: Pt, size: number): [Pt, Pt] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  return [
    { x: b.x - size * Math.cos(ang - spread), y: b.y - size * Math.sin(ang - spread) },
    { x: b.x - size * Math.cos(ang + spread), y: b.y - size * Math.sin(ang + spread) },
  ];
}
export const headSize = (s: Pick<Shape, 'width'>) => Math.max(12, s.width * 4.5);

/** Bounding box [x0, y0, x1, y1] of a shape, with half its stroke width around it. */
export function shapeBox(s: Shape, shapes: ById): [number, number, number, number] {
  const pts = isBox(s)
    ? polygon(s)
    : (() => {
        const { a, b } = ends(s, shapes);
        const head = s.kind === 'arrow' ? arrowHead(a, b, headSize(s)) : [];
        return [a, b, ...head];
      })();
  const pad = s.width / 2;
  return [
    Math.min(...pts.map((p) => p.x)) - pad,
    Math.min(...pts.map((p) => p.y)) - pad,
    Math.max(...pts.map((p) => p.x)) + pad,
    Math.max(...pts.map((p) => p.y)) + pad,
  ];
}

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

export function inPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
}

/** Whether a circle at p with radius r touches the shape (its outline, or inside it when filled). */
export function touches(s: Shape, p: Pt, r: number, shapes: ById): boolean {
  const reach = r + s.width / 2;
  if (!isBox(s)) {
    const { a, b } = ends(s, shapes);
    if (segDist(p, a, b) <= reach) return true;
    if (s.kind === 'arrow') {
      const [h1, h2] = arrowHead(a, b, headSize(s));
      return segDist(p, b, h1) <= reach || segDist(p, b, h2) <= reach;
    }
    return false;
  }
  const poly = polygon(s);
  if (s.fill !== 'none' && inPolygon(p, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segDist(p, poly[i]!, poly[(i + 1) % poly.length]!) <= reach) return true;
  }
  return false;
}

/** The centre of a shape (a line's midpoint): what a lasso loop has to go around. */
export function centre(s: Shape, shapes: ById): Pt {
  if (isBox(s)) return { x: s.cx, y: s.cy };
  const { a, b } = ends(s, shapes);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Hatching: 45° segments `gap` apart, clipped to the (convex) shape. */
export function hatch(s: Shape, gap: number): [Pt, Pt][] {
  const poly = polygon(s);
  const [x0, y0, x1, y1] = [
    Math.min(...poly.map((p) => p.x)),
    Math.min(...poly.map((p) => p.y)),
    Math.max(...poly.map((p) => p.x)),
    Math.max(...poly.map((p) => p.y)),
  ];
  const out: [Pt, Pt][] = [];
  // Lines x - y = c, for every c across the box.
  for (let c = x0 - y1; c <= x1 - y0; c += gap) {
    const hits: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const dp = p.x - p.y - c;
      const dq = q.x - q.y - c;
      if (dp === 0 && dq === 0) continue;
      if (dp * dq <= 0 && dp !== dq) {
        const t = dp / (dp - dq);
        hits.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    if (hits.length >= 2) {
      hits.sort((m, n) => m.x - n.x);
      out.push([hits[0]!, hits[hits.length - 1]!]);
    }
  }
  return out;
}

/** An arrow whose shape was deleted keeps the point where it was attached. */
export function unbindGone(s: Shape, gone: ReadonlySet<string>, map: ById): Shape {
  const lost = (s.bindStart && gone.has(s.bindStart)) || (s.bindEnd && gone.has(s.bindEnd));
  if (isBox(s) || !lost) return s;
  const { a, b } = ends(s, map);
  const { bindStart, bindEnd, ...rest } = s;
  return {
    ...rest,
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    ...(bindStart && !gone.has(bindStart) ? { bindStart } : {}),
    ...(bindEnd && !gone.has(bindEnd) ? { bindEnd } : {}),
  };
}

/** The outline as SVG path data (for export): a closed polygon/ellipse, or a line with its head. */
export function svgPath(s: Shape, shapes: ById): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  if (s.kind === 'ellipse') {
    const poly = polygon(s);
    return `${poly.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(' ')} Z`;
  }
  if (isBox(s))
    return `${polygon(s)
      .map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`)
      .join(' ')} Z`;
  const { a, b } = ends(s, shapes);
  let d = `M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)}`;
  if (s.kind === 'arrow') {
    const [h1, h2] = arrowHead(a, b, headSize(s));
    d += ` M${f(h1.x)} ${f(h1.y)} L${f(b.x)} ${f(b.y)} L${f(h2.x)} ${f(h2.y)}`;
  }
  return d;
}

/** Dash pattern (in stroke-width units) for a style, or none for a solid line. */
export function dashArray(dash: Shape['dash'], width: number): number[] {
  if (dash === 'dashed') return [width * 4, width * 2.5];
  if (dash === 'dotted') return [0.01, width * 2.2]; // round caps make the dots
  return [];
}

/**
 * Snaps `p` to nearby edges/centres of other boxes (x and y independently) within `tol`;
 * returns the snapped point and the guide lines that explain it.
 */
export function snapTo(
  p: Pt,
  others: readonly [number, number, number, number][],
  tol: number,
): { p: Pt; guides: { axis: 'x' | 'y'; at: number }[] } {
  let sx: number | null = null;
  let sy: number | null = null;
  let dx = tol + 1;
  let dy = tol + 1;
  for (const [x0, y0, x1, y1] of others) {
    for (const x of [x0, (x0 + x1) / 2, x1])
      if (Math.abs(p.x - x) < dx) [dx, sx] = [Math.abs(p.x - x), x];
    for (const y of [y0, (y0 + y1) / 2, y1])
      if (Math.abs(p.y - y) < dy) [dy, sy] = [Math.abs(p.y - y), y];
  }
  const guides: { axis: 'x' | 'y'; at: number }[] = [];
  if (sx !== null && dx <= tol) guides.push({ axis: 'x', at: sx });
  if (sy !== null && dy <= tol) guides.push({ axis: 'y', at: sy });
  return {
    p: { x: sx !== null && dx <= tol ? sx : p.x, y: sy !== null && dy <= tol ? sy : p.y },
    guides,
  };
}
