// Run: node src/shape.check.ts — fails loudly if shape recognition stops recognising rough shapes.
import assert from 'node:assert/strict';
import { recognize } from './shape.ts';

// Deterministic wobble so rough strokes look hand-drawn but tests are repeatable.
let seed = 1;
const jitter = (n: number) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * n;
};
const along = (pts: [number, number][], step = 3, wobble = 2) => {
  const out: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let k = 0; k < n; k++) {
      out.push(
        ax + ((bx - ax) * k) / n + jitter(wobble),
        ay + ((by - ay) * k) / n + jitter(wobble),
        0.5,
      );
    }
  }
  const [lx, ly] = pts[pts.length - 1]!;
  out.push(lx, ly, 0.5);
  return out;
};
const circle = (cx: number, cy: number, rx: number, ry: number, gap = 0.05) =>
  along(
    Array.from({ length: 60 }, (_, i): [number, number] => {
      const a = (i / 59) * Math.PI * 2 * (1 - gap);
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    }),
  );
const name = (pts: number[]) => recognize(pts)?.name ?? null;

assert.equal(
  name(
    along([
      [0, 0],
      [200, 30],
    ]),
  ),
  'line',
);
assert.equal(
  name(
    along([
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
      [2, 4],
    ]),
  ),
  'rectangle',
);
assert.equal(
  name(
    along([
      [0, 100],
      [60, 0],
      [120, 100],
      [3, 98],
    ]),
  ),
  'triangle',
);
assert.equal(name(circle(100, 100, 60, 60)), 'circle');
assert.equal(name(circle(100, 100, 100, 50)), 'ellipse');
assert.equal(
  name(
    along([
      [0, 50],
      [200, 50],
      [175, 35],
      [200, 50],
      [175, 65],
    ]),
  ),
  'arrow',
);
assert.equal(
  name(circle(100, 100, 60, 60, -0.08)),
  'circle',
  'overshooting the start still closes',
);
const r = (x: number, y: number): [number, number] => [x * 0.94 - y * 0.34, x * 0.34 + y * 0.94]; // 20°
assert.equal(
  name(along([r(0, 0), r(120, 0), r(120, 70), r(0, 70), r(2, 3)])),
  'rectangle',
  'rotated',
);
assert.equal(
  name(
    along([
      [0, 0],
      [40, 60],
      [80, 0],
      [120, 60],
      [160, 0],
    ]),
  ),
  null,
  'zigzag stays ink',
);
assert.equal(
  name(
    along([
      [0, 0],
      [3, 3],
    ]),
  ),
  null,
  'tiny strokes stay ink',
);

const rect = recognize(
  along([
    [0, 0],
    [100, 2],
    [99, 80],
    [1, 79],
    [2, 3],
  ]),
)!;
const xs = rect.strokes[0]!.filter((_, i) => i % 3 === 0);
assert.ok(
  Math.abs(Math.min(...xs) - 0) < 4 && Math.abs(Math.max(...xs) - 100) < 4,
  'rectangle keeps its size',
);
const ys = rect.strokes[0]!.filter((_, i) => i % 3 === 1);
assert.ok(
  new Set(ys.map((y) => Math.round(y))).size < ys.length,
  'near-axis rectangle is snapped level',
);
console.log('shape checks passed');
