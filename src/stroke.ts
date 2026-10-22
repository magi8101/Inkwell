import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { Stroke } from './store';

type Shape = Pick<Stroke, 'tool' | 'width' | 'pressure'>;

// Points are smoothed once at capture (see ink.ts), so rendering is a pure function of the stored
// points: no streamline or simulated pressure here, which would reshape the pieces left by an eraser.
let tuning = { thinning: 0.55, gamma: 1 };

const options = (s: Shape, last: boolean): StrokeOptions => ({
  size: s.width,
  thinning: s.tool === 'pen' && s.pressure ? tuning.thinning : 0,
  easing: tuning.gamma === 1 ? undefined : (p) => p ** tuning.gamma,
  smoothing: 0.5,
  streamline: 0,
  simulatePressure: false,
  last,
});

/** Pressure-shaped outline of a stroke as a closed path of quadratic curves. */
export function outline(points: number[], s: Shape, last: boolean): Path2D {
  const pts: number[][] = [];
  for (let i = 0; i < points.length; i += 3) pts.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  const o = getStroke(pts, options(s, last));
  const path = new Path2D();
  const first = o[0];
  if (!first) return path;
  path.moveTo(first[0], first[1]);
  for (let i = 0; i < o.length; i++) {
    const a = o[i]!;
    const b = o[(i + 1) % o.length]!;
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

let paths = new WeakMap<Stroke, Path2D>();

/** Changing how pressure maps to width re-shapes every stroke, so cached outlines are dropped. */
export function setRenderTuning(thinning: number, gamma: number) {
  if (thinning === tuning.thinning && gamma === tuning.gamma) return false;
  tuning = { thinning, gamma };
  paths = new WeakMap();
  return true;
}
const boxes = new WeakMap<Stroke, [number, number, number, number]>();

export function bbox(s: Stroke): [number, number, number, number] {
  let b = boxes.get(s);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.points.length; i += 3) {
      const x = s.points[i]!;
      const y = s.points[i + 1]!;
      b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    }
    const r = s.width / 2;
    b = [b[0] - r, b[1] - r, b[2] + r, b[3] + r];
    boxes.set(s, b);
  }
  return b;
}

/** Near-black ink flips to near-white on dark pages so it stays readable, like OneNote. */
export const inkColor = (c: string, dark: boolean) => (dark && c === '#1c1c1e' ? '#f4f4f5' : c);

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, dark: boolean) {
  let p = paths.get(s);
  if (!p) {
    p = outline(s.points, s, true);
    paths.set(s, p);
  }
  ctx.globalAlpha = s.opacity;
  ctx.fillStyle = inkColor(s.color, dark);
  ctx.fill(p);
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Does a circle at (x, y) with radius r touch the stroke? */
export function hits(s: Stroke, x: number, y: number, r: number): boolean {
  const b = bbox(s);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const reach = r + s.width / 2;
  const p = s.points;
  if (p.length === 3) return Math.hypot(x - p[0]!, y - p[1]!) <= reach;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist(x, y, p[i - 3]!, p[i - 2]!, p[i]!, p[i + 1]!) <= reach) return true;
  }
  return false;
}

/**
 * Pixel eraser: removes the part of the stroke's centreline inside the circle (grown by half the
 * stroke width so no ink is left under the eraser), splitting the stroke where it crosses the edge.
 * Works on segments, so it cuts between widely spaced points too.
 */
export function cut(s: Stroke, x: number, y: number, r: number, newId: () => string): Stroke[] {
  if (!hits(s, x, y, r)) return [s];
  const R = r + s.width / 2;
  const p = s.points;
  const inside = (i: number) => Math.hypot(p[i]! - x, p[i + 1]! - y) <= R;
  if (p.length === 3) return inside(0) ? [] : [s];

  const runs: number[][] = [];
  let run: number[] = [];
  const at = (i: number, t: number) => {
    const j = i + 3;
    run.push(
      p[i]! + (p[j]! - p[i]!) * t,
      p[i + 1]! + (p[j + 1]! - p[i + 1]!) * t,
      p[i + 2]! + (p[j + 2]! - p[i + 2]!) * t,
    );
  };
  const end = () => {
    if (run.length >= 6) runs.push(run);
    run = [];
  };
  if (!inside(0)) run.push(p[0]!, p[1]!, p[2]!);
  for (let i = 0; i + 3 < p.length; i += 3) {
    // Solve |A + t(B - A) - C| = R for the segment A -> B.
    const dx = p[i + 3]! - p[i]!;
    const dy = p[i + 4]! - p[i + 1]!;
    const fx = p[i]! - x;
    const fy = p[i + 1]! - y;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const disc = b * b - 4 * a * (fx * fx + fy * fy - R * R);
    const aIn = inside(i);
    const bIn = inside(i + 3);
    const t1 = a && disc > 0 ? (-b - Math.sqrt(disc)) / (2 * a) : 2;
    const t2 = a && disc > 0 ? (-b + Math.sqrt(disc)) / (2 * a) : 2;
    if (!aIn && !bIn) {
      if (t1 > 0 && t2 < 1) {
        at(i, t1); // passes straight through the eraser
        end();
        at(i, t2);
      }
      run.push(p[i + 3]!, p[i + 4]!, p[i + 5]!);
    } else if (!aIn && bIn) {
      at(i, t1);
      end();
    } else if (aIn && !bIn) {
      at(i, t2);
      run.push(p[i + 3]!, p[i + 4]!, p[i + 5]!);
    }
  }
  end();
  return runs.map((points) => ({ ...s, id: newId(), points }));
}
