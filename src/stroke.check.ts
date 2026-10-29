// Run: node src/stroke.check.ts — fails loudly if eraser hit-testing or cutting breaks.
import assert from 'node:assert/strict';
import type { Stroke } from './store.ts';
import { cleanPoints, cut, hits, minWidthExtra } from './stroke.ts';

const line: Stroke = {
  id: 'a',
  tool: 'pen',
  color: '#000000',
  width: 2,
  opacity: 1,
  pressure: false,
  points: [0, 0, 0.5, 50, 0, 0.5, 100, 0, 0.5],
};
assert.ok(hits(line, 25, 3, 5), 'circle near a segment hits');
assert.ok(!hits(line, 25, 20, 5), 'circle far away misses');
assert.ok(hits({ ...line, points: [10, 10, 0.5] }, 12, 10, 1), 'single-point dot can be hit');

let n = 0;
const id = () => `n${n++}`;
// Two far-apart points: the old point-based eraser could not cut this at all.
const sparse = { ...line, points: [0, 0, 0.5, 100, 0, 0.5] };
const parts = cut(sparse, 50, 0, 4, id);
assert.equal(parts.length, 2, 'cutting the middle of a sparse segment splits it');
assert.ok(
  Math.abs(parts[0]!.points[3]! - 45) < 1e-9,
  'left piece ends at the eraser edge (r + width/2)',
);
assert.ok(Math.abs(parts[1]!.points[0]! - 55) < 1e-9, 'right piece starts at the other edge');
assert.equal(parts[0]!.points[5], 0.5, 'pressure is interpolated at the cut');

const end = cut(sparse, 100, 0, 9, id);
assert.equal(end.length, 1, 'cutting an end trims it');
assert.ok(Math.abs(end[0]!.points.at(-3)! - 90) < 1e-9, 'trimmed end stops at the eraser edge');

assert.deepEqual(cut(sparse, 50, 50, 4, id), [sparse], 'untouched stroke is returned as-is');
assert.deepEqual(cut(sparse, 50, 0, 200, id), [], 'eraser covering everything removes the stroke');
assert.deepEqual(
  cut({ ...line, points: [5, 5, 0.5] }, 5, 5, 2, id),
  [],
  'dot under the eraser is removed',
);
// Dense, jittery Pencil-like input is thinned and smoothed; ends stay exact.
let jit = 3;
const wobble = () => {
  jit = (jit * 16807) % 2147483647;
  return (jit / 2147483647 - 0.5) * 0.7;
};
const dense: number[] = [];
for (let i = 0; i <= 500; i++) dense.push(i * 0.6 + wobble(), 100 + wobble(), 0.5);
const cleaned = cleanPoints(dense, 8);
assert.ok(cleaned.length < 200, `dense samples are thinned (${cleaned.length})`);
assert.deepEqual(cleaned[0]!.slice(0, 2), dense.slice(0, 2), 'first point stays put');
assert.deepEqual(cleaned.at(-1)!.slice(0, 2), dense.slice(-3, -1), 'last point stays put');
let backwards = 0;
for (let i = 2; i < cleaned.length; i++) if (cleaned[i]![0]! < cleaned[i - 1]![0]!) backwards++;
assert.equal(backwards, 0, 'no backwards jitter steps left to read as corners');
assert.equal(cleanPoints([0, 0, 0.5, 10, 0, 0.5], 4).length, 2, 'short strokes pass through');

// Fast iPad writing: pressure alternating 0.5 / 0.2 between samples must not pulse into beads.
const beads: number[] = [];
for (let i = 0; i <= 40; i++) beads.push(100, i * 12, i % 2 ? 0.2 : 0.5);
const smooth = cleanPoints(beads, 6).map((p) => p[2]!);
const maxJump = Math.max(...smooth.slice(1).map((v, i) => Math.abs(v - smooth[i]!)));
assert.ok(
  maxJump < 0.08,
  `width no longer alternates sample to sample (jump ${maxJump.toFixed(3)})`,
);
console.log('stroke checks passed');

// Thin strokes are widened to about one device pixel so they paint evenly; wide ones are untouched.
assert.equal(minWidthExtra(3, 1, false), 0, 'a 3 px stroke at 100% needs nothing');
assert.equal(minWidthExtra(1.1, 1, false), 0, 'exactly one device pixel is enough');
assert.ok(
  Math.abs(3 * 0.14 + minWidthExtra(3, 0.14, false) * 0.14 - 1.1) < 1e-9,
  'a 3 px stroke at 14% becomes 1.1 device px',
);
assert.ok(
  minWidthExtra(3, 0.14, true) > minWidthExtra(3, 0.14, false),
  'a pressure-thinned pen counts as narrower',
);
assert.equal(minWidthExtra(0, 1, false), 0, 'no width, nothing to widen');
assert.equal(minWidthExtra(3, 0, false), 0, 'no scale, nothing to widen');
assert.equal(minWidthExtra(Number.NaN, 1, false), 0, 'not a number');
