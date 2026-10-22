// Run: node src/predict.check.ts — fails loudly if pen-tip prediction misbehaves.
import assert from 'node:assert/strict';
import { predict, type Sample } from './predict.ts';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// Steady motion at 0.5 px/ms to the right, a sample every 4 ms (250 Hz).
const steady: Sample[] = Array.from({ length: 10 }, (_, i) => ({ x: i * 2, y: 10, t: i * 4 }));
const p = predict(steady, 16, 100)!;
assert.ok(close(p.x, 18 + 8) && close(p.y, 10), 'extrapolates constant velocity');

// Jitter averages out: same motion with ±0.5 px noise still predicts roughly forward.
const noisy = steady.map((s, i) => ({ ...s, y: s.y + (i % 2 ? 0.5 : -0.5) }));
const q = predict(noisy, 16, 100)!;
assert.ok(Math.abs(q.y - 10) < 1 && q.x > 20, 'least squares smooths sensor jitter');

// Never overshoots wildly: a fast flick is capped.
const fast = steady.map((s) => ({ ...s, x: s.x * 20 }));
const r = predict(fast, 16, 30)!;
assert.ok(close(Math.hypot(r.x - fast.at(-1)!.x, r.y - 10), 30), 'lead is capped');

// No guess when there's nothing to go on.
assert.equal(predict([], 16, 30), null, 'no samples');
assert.equal(predict(steady.slice(0, 2), 16, 30), null, 'too few samples');
assert.equal(
  predict(
    steady.map((s) => ({ ...s, x: 5 })),
    16,
    30,
  ),
  null,
  'pen held still',
);
assert.equal(
  predict(
    steady.map((s) => ({ ...s, t: 0 })),
    16,
    30,
  ),
  null,
  'identical timestamps',
);
assert.equal(predict(steady, 0, 30), null, 'prediction disabled');

// Only recent motion counts: an old leftward drag doesn't drag a new rightward one backwards.
const turn: Sample[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ x: 100 - i * 4, y: 0, t: i * 4 })),
  ...Array.from({ length: 6 }, (_, i) => ({ x: 64 + i * 2, y: 0, t: 140 + i * 4 })),
];
assert.ok(predict(turn, 16, 100)!.x > 74, 'follows the new direction after a turn');
console.log('predict checks passed');
