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

// High-rate pens (Apple Pencil reports 240 Hz) give samples a fraction of a pixel apart with
// sub-pixel jitter. perfect-freehand reads every tiny backwards step as a sharp corner and pinches
// the outline, so dense input came out lumpy and notched. Before outlining: drop samples closer
// than a fraction of the stroke width to the last kept one, then average out what jitter is left.
// Done at render time, so strokes saved before the fix are cleaned too.
const MIN_SPACING = 0.2; // × stroke width
const MIN_SPACING_PX = 0.75;

/** Thinned and lightly smoothed [x, y, pressure] points; first and last are kept exactly. */
export function cleanPoints(points: number[], width: number): number[][] {
  const n = points.length / 3;
  const raw: number[][] = [];
  for (let i = 0; i < points.length; i += 3) raw.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  if (n < 3) return raw;
  const gap = Math.max(MIN_SPACING_PX, width * MIN_SPACING);
  const kept: number[][] = [raw[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = kept[kept.length - 1]!;
    const p = raw[i]!;
    if (Math.hypot(p[0]! - a[0]!, p[1]! - a[1]!) >= gap) kept.push(p);
  }
  const lastRaw = raw[n - 1]!;
  const prev = kept[kept.length - 1]!;
  // The end point always stays; if it lands right next to the previous kept one, replace that.
  if (kept.length > 1 && Math.hypot(lastRaw[0]! - prev[0]!, lastRaw[1]! - prev[1]!) < gap)
    kept.pop();
  kept.push(lastRaw);
  if (kept.length < 4) return kept;
  // A [1, 2, 1] average on interior positions removes leftover zig-zag. Pressure gets a wider
  // [1, 2, 3, 2, 1] window: noisy or alternating pressure (Safari coalesced samples) otherwise
  // makes the width pulse sample to sample, which looks like a chain of beads.
  const pr = (i: number) => kept[Math.min(kept.length - 1, Math.max(0, i))]![2]!;
  return kept.map((p, i) => {
    const pressure = (pr(i - 2) + 2 * pr(i - 1) + 3 * p[2]! + 2 * pr(i + 1) + pr(i + 2)) / 9;
    if (i === 0 || i === kept.length - 1) return [p[0]!, p[1]!, pressure];
    const a = kept[i - 1]!;
    const b = kept[i + 1]!;
    return [(a[0]! + 2 * p[0]! + b[0]!) / 4, (a[1]! + 2 * p[1]! + b[1]!) / 4, pressure];
  });
}

function outlinePoints(points: number[], s: Shape, last: boolean) {
  return getStroke(cleanPoints(points, s.width), options(s, last));
}

/** Pressure-shaped outline of a stroke as a closed path of quadratic curves. */
export function outline(points: number[], s: Shape, last: boolean): Path2D {
  const o = outlinePoints(points, s, last);
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

/** The same outline as SVG path data (M/Q/Z only), offset by (dx, dy), for vector export. */
export function svgPath(st: Stroke, dx: number, dy: number): string {
  const o = outlinePoints(st.points, st, true);
  const f = (n: number) => n.toFixed(2);
  const first = o[0];
  if (!first) return '';
  let d = `M${f(first[0] + dx)} ${f(first[1] + dy)}`;
  for (let i = 0; i < o.length; i++) {
    const a = o[i]!;
    const b = o[(i + 1) % o.length]!;
    d += ` Q${f(a[0] + dx)} ${f(a[1] + dy)} ${f((a[0] + b[0]) / 2 + dx)} ${f((a[1] + b[1]) / 2 + dy)}`;
  }
  return `${d} Z`;
}

/** Stroke diameter perfect-freehand would draw at this pressure (for the fast wet-ink tip). */
export function tipDiameter(s: Shape, pressure: number): number {
  const thin = s.tool === 'pen' && s.pressure ? tuning.thinning : 0;
  const t = 0.5 - thin * (0.5 - pressure);
  return 2 * s.width * (tuning.gamma === 1 ? t : t ** tuning.gamma);
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

export const BLACK = '#1c1c1e';
/** Near-black ink flips to near-white on dark pages so it stays readable, like OneNote. */
export const inkColor = (c: string, dark: boolean) => (dark && c === BLACK ? '#f4f4f5' : c);

/** Thinner than this on screen (device pixels) and a filled stroke paints unevenly: patchy and grainy. */
const MIN_DEVICE_PX = 1.1;

/**
 * How much wider (in world units) a stroke must be drawn so it is at least about one device pixel
 * thick, or 0 when it already is. `scale` is device pixels per world unit. Pressure-thinned pens are
 * narrower than their nominal width, so they count as narrower.
 */
export function minWidthExtra(width: number, scale: number, thinned: boolean): number {
  if (!(scale > 0) || !(width > 0)) return 0;
  const px = width * scale * (thinned ? 1 - tuning.thinning * 0.5 : 1);
  return px >= MIN_DEVICE_PX ? 0 : (MIN_DEVICE_PX - px) / scale;
}

/**
 * Fills an outline made by `outline()`, and, for a stroke too thin to paint evenly at this zoom, also
 * strokes its edge so the line stays solid. Translucent strokes are left alone (the two passes would
 * overlap and darken); they are wide in practice.
 */
export function fillInk(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  s: Shape & { opacity: number },
) {
  ctx.fill(path);
  if (s.opacity < 0.95) return;
  const m = ctx.getTransform();
  const extra = minWidthExtra(s.width, Math.hypot(m.a, m.b), s.tool === 'pen' && s.pressure);
  if (extra > 0) {
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = extra;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, dark: boolean) {
  let p = paths.get(s);
  if (!p) {
    p = outline(s.points, s, true);
    paths.set(s, p);
  }
  ctx.globalAlpha = s.opacity;
  ctx.fillStyle = inkColor(s.color, dark);
  fillInk(ctx, p, s);
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

// --- Text boxes on canvas (thumbnails and exports; the live page uses editable DOM boxes). ---

export const FONTS = {
  // Each stack lists the Windows, macOS and Linux font before the generic fallback.
  sans: {
    label: 'Sans',
    css: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Cantarell, "Noto Sans", sans-serif',
  },
  serif: {
    label: 'Serif',
    css: 'Cambria, Georgia, "Iowan Old Style", "Noto Serif", "DejaVu Serif", serif',
  },
  mono: {
    label: 'Mono',
    css: '"Cascadia Mono", Consolas, ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
  },
  hand: {
    label: 'Hand',
    css: '"Ink Free", "Segoe Print", Noteworthy, "Bradley Hand", "Comic Neue", "Comic Sans MS", cursive',
  },
} as const;
export const LINE_HEIGHT = 1.3;

type TextLike = {
  x: number;
  y: number;
  w: number;
  text: string;
  font: keyof typeof FONTS;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  angle?: number;
};

export const fontCss = (t: TextLike) =>
  `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${t.size}px ${FONTS[t.font].css}`;

/** Word-wraps text to the box width the same way the editable box does (pre-wrap). */
export function wrapLines(t: TextLike, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of t.text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && measure(next.trimEnd()) > t.w) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

export function drawTextBox(ctx: CanvasRenderingContext2D, t: TextLike, dark: boolean) {
  ctx.globalAlpha = 1;
  ctx.font = fontCss(t);
  ctx.fillStyle = inkColor(t.color, dark);
  ctx.textBaseline = 'top';
  const lh = t.size * LINE_HEIGHT;
  // Centre each line in its line box like CSS does.
  const pad = (lh - t.size) / 2;
  ctx.save();
  if (t.angle) {
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.translate(-t.x, -t.y);
  }
  wrapLines(t, (s) => ctx.measureText(s).width).forEach((line, i) => {
    ctx.fillText(line, t.x, t.y + pad + i * lh);
  });
  ctx.restore();
}
