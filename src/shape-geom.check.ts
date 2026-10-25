// Run: node src/shape-geom.check.ts — the geometry of shapes: outlines, where an arrow meets a
// shape it is bound to, hit tests, hatching, boxes and alignment guides.
import assert from 'node:assert/strict';
import {
  arrowHead,
  boundary,
  byId,
  centre,
  dashArray,
  ends,
  hatch,
  headSize,
  inPolygon,
  polygon,
  shapeBox,
  snapTo,
  svgPath,
  touches,
} from './shape-geom.ts';
import type { Shape } from './store.ts';

const base = {
  x1: 0,
  y1: 0,
  x2: 0,
  y2: 0,
  color: '#000000',
  width: 2,
  opacity: 1,
  fill: 'none',
  dash: 'solid',
} as const;
const box = (
  id: string,
  kind: Shape['kind'],
  cx: number,
  cy: number,
  w: number,
  h: number,
  angle = 0,
): Shape => ({
  ...base,
  id,
  kind,
  cx,
  cy,
  w,
  h,
  angle,
});
const arrow = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extra: Partial<Shape> = {},
): Shape => ({
  ...base,
  id,
  kind: 'arrow',
  cx: 0,
  cy: 0,
  w: 0,
  h: 0,
  angle: 0,
  x1,
  y1,
  x2,
  y2,
  ...extra,
});
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Outlines
const r = box('r', 'rect', 100, 50, 80, 40);
assert.deepEqual(
  polygon(r).map((p) => [Math.round(p.x), Math.round(p.y)]),
  [
    [60, 30],
    [140, 30],
    [140, 70],
    [60, 70],
  ],
);
const turned = polygon(box('t', 'rect', 0, 0, 100, 20, Math.PI / 2)); // turned a quarter: tall
near(Math.max(...turned.map((p) => p.y)) - Math.min(...turned.map((p) => p.y)), 100);
assert.equal(polygon(box('e', 'ellipse', 0, 0, 10, 10)).length, 64);
assert.equal(polygon(box('d', 'diamond', 0, 0, 10, 10)).length, 4);

// Where a line towards a point leaves each kind of shape
const out = (s: Shape, x: number, y: number) => boundary(s, { x, y });
near(out(r, 500, 50).x, 140);
near(out(r, 500, 50).y, 50); // straight right: right edge
near(out(r, 100, -400).y, 30); // straight up: top edge
near(out(box('e', 'ellipse', 0, 0, 100, 60), 0, 900).y, 30); // ellipse bottom
near(out(box('e', 'ellipse', 0, 0, 100, 60), 900, 0).x, 50);
near(out(box('d', 'diamond', 0, 0, 100, 60), 900, 0).x, 50); // diamond right tip
const diag = out(box('d', 'diamond', 0, 0, 100, 100), 100, 100); // 45°: halfway along an edge
near(diag.x, 25);
near(diag.y, 25);
// A corner-to-corner direction of a square leaves at the corner
const cornerHit = out(box('s', 'rect', 0, 0, 40, 40), 100, 100);
near(cornerHit.x, 20);
near(cornerHit.y, 20);

// Bound arrows follow their shapes
const a = box('a', 'rect', 0, 0, 40, 40);
const b = box('b', 'ellipse', 200, 0, 60, 40);
const link = arrow('l', 0, 0, 0, 0, { bindStart: 'a', bindEnd: 'b' });
let e = ends(link, byId([a, b, link]));
near(e.a.x, 20);
near(e.a.y, 0);
near(e.b.x, 170);
near(e.b.y, 0);
const moved = { ...b, cx: 200, cy: 200 }; // the second shape moves: the arrow's end follows
e = ends(link, byId([a, moved, link]));
assert.ok(e.b.y > 150 && e.b.y < 200, `end follows the shape: ${e.b.y}`);
// A binding to a deleted shape falls back to the stored end
e = ends({ ...link, x2: 9, y2: 9 }, byId([a, link]));
near(e.b.x, 9);
near(e.b.y, 9);
// A free line is just its two ends
e = ends(arrow('f', 1, 2, 3, 4), byId([]));
assert.deepEqual(
  [e.a, e.b],
  [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ],
);

// Arrow head: two strokes of the given length back from the tip, either side
const [h1, h2] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
near(Math.hypot(h1.x - 100, h1.y), 20);
near(h1.y, -h2.y);
assert.ok(h1.x < 100);
assert.ok(headSize({ width: 2 }) >= 12 && headSize({ width: 10 }) > headSize({ width: 2 }));
assert.equal(
  headSize({ width: 2, head: 2 }),
  headSize({ width: 2 }) * 2,
  'head size setting scales it',
);
assert.equal(headSize({ width: 2, head: 1 }), headSize({ width: 2 }), 'normal is unchanged');

// Boxes include the stroke and the arrow head
const bb = shapeBox(r, byId([r]));
near(bb[0], 59);
near(bb[2], 141);
const ab = shapeBox(arrow('x', 0, 0, 100, 0), byId([]));
assert.ok(ab[0] < 0 && ab[2] > 100 && ab[1] < 0 && ab[3] > 0);

// Hit tests: the outline always, the inside only when filled
const m = byId([r]);
assert.ok(touches(r, { x: 100, y: 30 }, 3, m)); // on the top edge
assert.ok(!touches(r, { x: 100, y: 50 }, 3, m)); // inside an unfilled shape
assert.ok(touches({ ...r, fill: 'solid' }, { x: 100, y: 50 }, 3, m)); // inside a filled one
assert.ok(!touches(r, { x: 100, y: 200 }, 3, m));
const ln = arrow('ln', 0, 0, 100, 0);
assert.ok(touches(ln, { x: 50, y: 3 }, 3, byId([ln])));
assert.ok(!touches(ln, { x: 50, y: 30 }, 3, byId([ln])));
assert.deepEqual(centre(ln, byId([ln])), { x: 50, y: 0 });
assert.deepEqual(centre(r, m), { x: 100, y: 50 });

// Hatching stays inside the shape
for (const kind of ['rect', 'ellipse', 'diamond'] as const) {
  const s = box('h', kind, 50, 50, 80, 60, 0.3);
  const lines = hatch(s, 8);
  assert.ok(lines.length > 6, `${kind} hatch has lines`);
  const poly = polygon(s);
  for (const [p, q] of lines) {
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    assert.ok(inPolygon(mid, poly), `${kind}: hatch midpoint inside`);
  }
}

// SVG paths and dashes
assert.match(svgPath(r, m), /^M60 30 L140 30 L140 70 L60 70 Z$/);
assert.match(svgPath(arrow('p', 0, 0, 50, 0), byId([])), /^M0 0 L50 0 M[\d. -]+ L50 0 L[\d. -]+$/);
assert.deepEqual(dashArray('solid', 3), []);
assert.equal(dashArray('dashed', 3).length, 2);
assert.ok(dashArray('dotted', 3)[0]! < 0.1);

// Alignment guides
const others: [number, number, number, number][] = [[0, 0, 100, 100]];
let s = snapTo({ x: 52, y: 300 }, others, 6);
assert.deepEqual(s.p, { x: 50, y: 300 }); // snaps to the centre line only
assert.deepEqual(s.guides, [{ axis: 'x', at: 50 }]);
s = snapTo({ x: 103, y: 97 }, others, 6);
assert.deepEqual(s.p, { x: 100, y: 100 });
assert.equal(s.guides.length, 2);
s = snapTo({ x: 30, y: 30 }, others, 6);
assert.deepEqual(s.p, { x: 30, y: 30 });
assert.deepEqual(s.guides, []);
console.log('shape-geom checks passed');
