// Run: node src/inkw-codec.check.ts — the .inkw stroke codec (docs/inkw-spec.md, section 6).
import assert from 'node:assert/strict';
import { decodeStrokes, encodeStrokes, InkwError } from './inkw-codec.ts';
import { PROFILES, scriptPath, simulate } from './pen-sim.ts';
import type { Stroke } from './store.ts';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  id: 's1',
  tool: 'pen',
  color: '#1c1c1e',
  width: 2,
  opacity: 1,
  pressure: true,
  points: [10, 20, 1, 11, 20, 1],
  ...over,
});
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof InkwError, `expected InkwError, got ${e}`);
    return e.code;
  }
  return 'none';
};

// The spec's worked example: exactly these 29 bytes.
const worked = encodeStrokes([stroke()]);
assert.equal(
  hex(worked.bytes),
  '49 4e 4b 53 01 01 02 73 31 00 01 1c 1c 1e 20 ff 01 02 80 0a 80 14 fe 03 ff 08 ff 13 00',
  'matches the worked example',
);
assert.equal(worked.skipped, 0);

// Every kind of pen round-trips within the stated precision.
for (const pen of PROFILES) {
  const input: Stroke[] = Array.from({ length: 20 }, (_, i) => {
    const sim = simulate(pen, scriptPath(50, 100 + i * 5, 400), 600, 1.2, i + 1);
    return stroke({
      id: `${pen.name.replace(/\W/g, '-')}-${i}`,
      width: 2.5,
      opacity: 0.4,
      pressure: pen.pressure === 'real',
      points: sim.raw.flatMap((q) => [q.x, q.y, q.p]),
    });
  });
  const back = decodeStrokes(encodeStrokes(input).bytes);
  assert.equal(back.length, input.length, `${pen.name}: stroke count`);
  input.forEach((a, i) => {
    const b = back[i]!;
    assert.equal(b.id, a.id);
    assert.equal(b.tool, a.tool);
    assert.equal(b.color, a.color);
    assert.equal(b.pressure, a.pressure);
    assert.ok(Math.abs(b.width - a.width) <= 1 / 16, 'width');
    assert.ok(Math.abs(b.opacity - a.opacity) <= 1 / 255, 'opacity');
    assert.equal(b.points.length, a.points.length, `${pen.name}: point count`);
    for (let k = 0; k < a.points.length; k += 3) {
      assert.ok(Math.abs(b.points[k]! - a.points[k]!) <= 1 / 128 + 1e-9, 'x');
      assert.ok(Math.abs(b.points[k + 1]! - a.points[k + 1]!) <= 1 / 128 + 1e-9, 'y');
      assert.ok(Math.abs(b.points[k + 2]! - a.points[k + 2]!) <= 1 / 255 + 1e-9, 'pressure');
    }
  });
}

// Empty and one-point strokes, highlighter, no strokes at all.
const odd = decodeStrokes(
  encodeStrokes([
    stroke({ id: 'e', points: [] }),
    stroke({ id: 'p', points: [5, 6, 0.5] }),
    stroke({ id: 'h', tool: 'highlighter', color: '#ffd60a', opacity: 0.35, pressure: false }),
  ]).bytes,
);
assert.deepEqual(
  odd.map((s) => [s.id, s.points.length, s.tool]),
  [
    ['e', 0, 'pen'],
    ['p', 3, 'pen'],
    ['h', 6, 'highlighter'],
  ],
);
assert.deepEqual(decodeStrokes(encodeStrokes([]).bytes), []);

// Damaged strokes are skipped and counted, never fatal.
const bad = encodeStrokes([
  stroke({ id: 'a' }),
  stroke({ id: 'b', points: [Number.NaN, 0, 0.5] }),
  stroke({ id: 'c', points: [0, Number.POSITIVE_INFINITY, 0.5] }),
  stroke({ id: 'd', points: [1e9, 0, 0.5] }),
  stroke({ id: 'e', points: [1, 2] }),
  stroke({ id: 'f', color: 'red' }),
]);
assert.equal(bad.skipped, 5, 'five damaged strokes skipped');
assert.deepEqual(
  decodeStrokes(bad.bytes).map((s) => s.id),
  ['a'],
);

// Ids outside [A-Za-z0-9_-] or too long are made safe, and stay unique.
const ids = decodeStrokes(
  encodeStrokes([stroke({ id: 'a b/é' }), stroke({ id: 'a b/é' }), stroke({ id: 'x'.repeat(100) })])
    .bytes,
).map((s) => s.id);
assert.ok(
  ids.every((i) => /^[A-Za-z0-9_-]{1,64}$/.test(i)),
  'ids are safe',
);
assert.equal(new Set(ids).size, 3, 'ids stay unique');

// Malformed input throws InkwError, never hangs, never reads past the end.
assert.equal(
  code(() => decodeStrokes(new Uint8Array([88, 88, 88, 88, 1, 0]))),
  'format',
  'bad magic',
);
assert.equal(
  code(() => decodeStrokes(new Uint8Array([73, 78, 75, 83, 2, 0]))),
  'version',
  'version 2',
);
assert.equal(
  code(() => decodeStrokes(new Uint8Array([]))),
  'format',
  'empty',
);
const sample = encodeStrokes([
  stroke(),
  stroke({ id: 's2', points: [1, 2, 0.5, 3, 4, 0.6, 5, 6, 0.7] }),
]).bytes;
for (let n = 0; n < sample.length; n++)
  assert.equal(
    code(() => decodeStrokes(sample.slice(0, n))),
    'format',
    `truncated at ${n}`,
  );
assert.equal(
  code(() =>
    decodeStrokes(new Uint8Array([73, 78, 75, 83, 1, 0xff, 0xff, 0xff, 0xff, 0x0f, 0, 0])),
  ),
  'format',
  'a stroke count that cannot fit',
);
assert.equal(
  code(() =>
    decodeStrokes(new Uint8Array([73, 78, 75, 83, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 1])),
  ),
  'format',
  'a varint longer than 5 bytes',
);
const reserved = sample.slice();
reserved[16] = 0x03; // the channels byte of the first stroke, with an unknown bit set
assert.equal(
  code(() => decodeStrokes(reserved)),
  'unsupported',
  'unknown channel bit',
);

// Size: well under the JSON the app stores today.
const big = Array.from({ length: 400 }, (_, i) => {
  const pen = PROFILES.find((p) => p.name === 'surface pen')!;
  const sim = simulate(pen, scriptPath(50 + (i % 10) * 20, 100 + i * 3, 500), 700, 1.2, i + 1);
  return stroke({ id: `b${i}`, points: sim.raw.flatMap((q) => [q.x, q.y, q.p]) });
});
const pts = big.reduce((n, s) => n + s.points.length / 3, 0);
assert.ok(encodeStrokes(big).bytes.length / pts <= 6, 'at most 6 bytes per point before deflate');
console.log('inkw-codec checks passed');
