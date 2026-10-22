// Turns a hand-drawn stroke into a clean shape: find corners with Ramer–Douglas–Peucker, then
// classify by whether the stroke is closed and how many corners it has, and check the fit.
// Output is plain point lists, so snapped shapes are ordinary strokes (erasable, selectable).

type P = { x: number; y: number };

// ponytail: thresholds are relative to the shape's size and tuned by hand; adjust with real strokes.
const LINE_DEVIATION = 0.06; // furthest point from the start-end chord / chord length
const CLOSED_GAP = 0.2; // start-end gap / bounding-box diagonal
const CORNER_EPS = 0.07; // RDP tolerance / diagonal
const MAX_FIT_ERROR = 0.07; // mean distance from ideal shape / diagonal
const STEP = 4; // spacing of generated points, world px

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= eps) return [pts[0]!, pts[pts.length - 1]!];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/** Points every STEP px along a polyline, as flat [x, y, pressure] with even pressure. */
export function densify(poly: P[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const n = Math.max(1, Math.ceil(dist(a, b) / STEP));
    for (let k = 0; k < n; k++)
      out.push(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, 0.5);
  }
  const last = poly[poly.length - 1]!;
  out.push(last.x, last.y, 0.5);
  return out;
}

const meanError = (pts: P[], poly: P[]) =>
  pts.reduce((sum, p) => {
    let best = Infinity;
    for (let i = 0; i < poly.length - 1; i++)
      best = Math.min(best, segDist(p, poly[i]!, poly[i + 1]!));
    return sum + best;
  }, 0) / pts.length;

function ellipse(cx: number, cy: number, rx: number, ry: number): P[] {
  const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / STEP));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

/** Rectangle through four rough corners: keep its orientation, average opposite sides. */
function rectangle(c: P[]): P[] {
  const [a, b, , d] = c as [P, P, P, P];
  const cx = c.reduce((s, p) => s + p.x, 0) / 4;
  const cy = c.reduce((s, p) => s + p.y, 0) / 4;
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  // Snap near-axis rectangles to the axis; that's almost always what was meant.
  const snap = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angle - snap) < (10 * Math.PI) / 180) angle = snap;
  const w = (dist(a, b) + dist(c[2]!, d)) / 2;
  const h = (dist(b, c[2]!) + dist(d, a)) / 2;
  const ux = { x: Math.cos(angle), y: Math.sin(angle) };
  const uy = { x: -ux.y, y: ux.x };
  const corner = (sx: number, sy: number) => ({
    x: cx + (ux.x * w * sx + uy.x * h * sy) / 2,
    y: cy + (ux.y * w * sx + uy.y * h * sy) / 2,
  });
  // Keep the drawing direction so uy points from a toward d.
  const flip = (d.x - a.x) * uy.x + (d.y - a.y) * uy.y < 0 ? -1 : 1;
  return [
    corner(-1, -flip),
    corner(1, -flip),
    corner(1, flip),
    corner(-1, flip),
    corner(-1, -flip),
  ];
}

export type ShapeName =
  | 'line'
  | 'arrow'
  | 'triangle'
  | 'rectangle'
  | 'circle'
  | 'ellipse'
  | 'pentagon'
  | 'hexagon'
  | 'star'
  | 'polygon';

/** How sharply the path turns at each corner (radians, 0 = straight on). */
function turns(loop: P[], closed: boolean): number[] {
  const out: number[] = [];
  const n = loop.length;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const prev = loop[(i + n - 1) % n]!;
    const p = loop[i]!;
    const next = loop[(i + 1) % n]!;
    const a = Math.atan2(p.y - prev.y, p.x - prev.x);
    const b = Math.atan2(next.y - p.y, next.x - p.x);
    out.push(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))));
  }
  return out;
}

/**
 * Evens out a polygon or star drawn roughly regular: same centre, corners at equal angles and
 * equal distance (two distances, alternating, for a star outline). Null if it isn't regular.
 */
function regular(c: P[]): { pts: P[]; skip: number; outline: boolean } | null {
  const n = c.length;
  const cx = c.reduce((s, p) => s + p.x, 0) / n;
  const cy = c.reduce((s, p) => s + p.y, 0) / n;
  const r = c.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const a = c.map((p) => Math.atan2(p.y - cy, p.x - cx));
  const steps = a.map((v, i) =>
    Math.atan2(Math.sin(a[(i + 1) % n]! - v), Math.cos(a[(i + 1) % n]! - v)),
  );
  const step = steps.reduce((s, v) => s + v, 0) / n;
  // A one-stroke star visits every second corner: the angle between corners is ~2 × 360°/n.
  const skip = Math.round((Math.abs(step) * n) / (2 * Math.PI)) || 1;
  const even = (v: number[], k: number) => {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return v.every((x) => Math.abs(x - m) < k * Math.abs(m));
  };
  const outer = r.filter((_, i) => i % 2 === 0);
  const inner = r.filter((_, i) => i % 2 === 1);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  // A star outline: an even number of corners, alternating far and near.
  const outline =
    n >= 8 &&
    n % 2 === 0 &&
    even(outer, 0.2) &&
    even(inner, 0.25) &&
    mean(inner) < 0.75 * mean(outer);
  if (!even(steps, 0.25) || (!outline && !even(r, 0.18))) return null;
  const turnBy = Math.sign(step) * ((2 * Math.PI * skip) / n);
  const pts = c.map((_, i) => {
    const radius = outline ? (i % 2 ? mean(inner) : mean(outer)) : mean(r);
    const angle = a[0]! + i * turnBy;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  return { pts, skip, outline };
}

/** Returns one or more clean strokes (flat [x, y, p] lists) or null if nothing fits well. */
export function recognize(flat: number[]): { name: ShapeName; strokes: number[][] } | null {
  const pts: P[] = [];
  for (let i = 0; i < flat.length; i += 3) pts.push({ x: flat[i]!, y: flat[i + 1]! });
  if (pts.length < 4) return null;
  // Measure length on a lightly simplified path so hand tremor doesn't inflate it.
  const calm = rdp(pts, 1.5);
  let length = 0;
  for (let i = 1; i < calm.length; i++) length += dist(calm[i - 1]!, calm[i]!);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 12) return null;
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;

  const chord = dist(start, end);
  if (
    chord > 0.5 * diag &&
    Math.max(...pts.map((p) => segDist(p, start, end))) < LINE_DEVIATION * chord
  ) {
    return { name: 'line', strokes: [densify([start, end])] };
  }

  if (dist(start, end) / diag < CLOSED_GAP) {
    // Close the loop, then find corners; drop corners that are nearly straight.
    const loop = rdp([...pts, start], CORNER_EPS * diag).slice(0, -1);
    const corners = loop
      .filter((p, i) => {
        const prev = loop[(i + loop.length - 1) % loop.length]!;
        const next = loop[(i + 1) % loop.length]!;
        const a1 = Math.atan2(p.y - prev.y, p.x - prev.x);
        const a2 = Math.atan2(next.y - p.y, next.x - p.x);
        const turn = Math.abs(((a2 - a1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        return turn < (155 * Math.PI) / 180; // i.e. the path turns by more than 25°
      })
      .filter((p, i, all) => i === 0 || dist(p, all[i - 1]!) > 0.1 * diag); // one corner, not two
    // (Where the loop closes, the simplification can leave a second point right next to a corner.)
    if (corners.length === 3) {
      const tri = [...corners, corners[0]!];
      if (meanError(pts, tri) / diag < MAX_FIT_ERROR)
        return { name: 'triangle', strokes: [densify(tri)] };
    }
    if (corners.length === 4) {
      const rect = rectangle(corners);
      const rectErr = meanError(pts, rect) / diag;
      // A trapezoid or kite fits its own four corners far better than any rectangle: leave it
      // to the polygon rule below.
      const quadErr = meanError(pts, [...corners, corners[0]!]) / diag;
      if (rectErr < MAX_FIT_ERROR && rectErr <= Math.max(quadErr * 2, 0.025))
        return { name: 'rectangle', strokes: [densify(rect)] };
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let rx = (maxX - minX) / 2;
    let ry = (maxY - minY) / 2;
    const err =
      pts.reduce((s, p) => s + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) /
      pts.length;
    // More corners: polygons and stars. Only clearly sharp corners count, and the polygon must
    // fit better than an ellipse, so a wobbly circle never turns into an octagon.
    // After merging, a corner can sit on an almost straight side: drop those (repeat until none).
    let poly = corners;
    for (let again = true; again && poly.length > 3; ) {
      const t = turns(poly, true);
      const keep = poly.filter((_, i) => t[i]! > (20 * Math.PI) / 180);
      again = keep.length < poly.length;
      poly = keep;
    }
    if (poly.length >= 4 && poly.length <= 12) {
      const sharp = turns(poly, true).every((t) => t > (40 * Math.PI) / 180);
      const outline = [...poly, poly[0]!];
      const fit = meanError(pts, outline) / diag;
      const ellipseFit = meanError(pts, ellipse(cx, cy, rx, ry)) / diag;
      if (sharp && fit < MAX_FIT_ERROR && fit < ellipseFit * 0.8) {
        const reg = regular(poly);
        const shape = reg ? [...reg.pts, reg.pts[0]!] : outline;
        const n = poly.length;
        const name: ShapeName =
          reg && (reg.skip > 1 || reg.outline)
            ? 'star'
            : reg && n === 5
              ? 'pentagon'
              : reg && n === 6
                ? 'hexagon'
                : 'polygon';
        return { name, strokes: [densify(shape)] };
      }
    }
    if (err > 0.15) return null;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) {
      rx = (rx + ry) / 2;
      ry = rx;
      return { name: 'circle', strokes: [densify(ellipse(cx, cy, rx, ry))] };
    }
    return { name: 'ellipse', strokes: [densify(ellipse(cx, cy, rx, ry))] };
  }

  // Open stroke: an arrow is a long shaft followed by a small head scribbled around the tip.
  const v = rdp(pts, CORNER_EPS * diag);
  if (v.length >= 3) {
    const shaft = dist(v[0]!, v[1]!);
    const tip = v[1]!;
    const headNearTip = v.slice(2).every((p) => dist(p, tip) < 0.5 * shaft);
    if (shaft > 0.5 * length * 0.8 && headNearTip) {
      const angle = Math.atan2(tip.y - v[0]!.y, tip.x - v[0]!.x);
      const head = Math.min(0.3 * shaft, Math.max(...v.slice(2).map((p) => dist(p, tip))) * 1.1);
      const wing = (side: number) => ({
        x: tip.x - head * Math.cos(angle + side * (Math.PI / 6)),
        y: tip.y - head * Math.sin(angle + side * (Math.PI / 6)),
      });
      return {
        name: 'arrow',
        strokes: [densify([v[0]!, tip]), densify([wing(1), tip, wing(-1)])],
      };
    }
    // Open zigzags stay ink on purpose: handwriting pauses after N, M, W, Z and L all the time.
  }
  return null;
}
