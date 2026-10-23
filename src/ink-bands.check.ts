// Run: node src/ink-bands.check.ts — pages of handwriting split into bands, and the ink
// fingerprint changes exactly when the ink does.
import assert from 'node:assert/strict';
import { bandStrokes, fuzzyIncludes, inkSignature } from './ink-bands.ts';
import type { Stroke } from './store.ts';

const stroke = (id: string, y: number, tool: Stroke['tool'] = 'pen'): Stroke => ({
  id,
  tool,
  color: '#000000',
  width: 3,
  opacity: 1,
  pressure: false,
  points: [10, y, 0.5, 60, y + 20, 0.5],
});
const strokes = [
  stroke('a', 10),
  stroke('b', 60),
  stroke('c', 400),
  stroke('d', 430),
  stroke('e', 900),
];
const bands = bandStrokes(strokes);
assert.deepEqual(
  bands.map((b) => b.map((s) => s.id)),
  [['a', 'b'], ['c', 'd'], ['e']],
);
// Order of the input doesn't matter; highlighter marks are left out.
assert.deepEqual(
  bandStrokes([stroke('z', 900), stroke('y', 10), stroke('h', 12, 'highlighter')]).map((b) =>
    b.map((s) => s.id),
  ),
  [['y'], ['z']],
);
assert.deepEqual(bandStrokes([]), []);
// The fingerprint: stable, and different after an add, a removal or a cut (a new id).
const sig = inkSignature(strokes);
assert.equal(sig, inkSignature([...strokes]));
assert.notEqual(sig, inkSignature([...strokes, stroke('f', 5)]));
assert.notEqual(sig, inkSignature(strokes.slice(1)));
assert.notEqual(sig, inkSignature([stroke('a2', 10), ...strokes.slice(1)]));
assert.equal(inkSignature([stroke('h', 1, 'highlighter')]), inkSignature([]));
// Forgiving search: OCR errors, odd spaces and punctuation are tolerated for longer words only.
assert.ok(fuzzyIncludes('He LL LO', 'hello')); // the real reading of drawn "HELLO"
assert.ok(fuzzyIncludes('Meeting notes: Chemistry lab, tuesday', 'chemistry'));
assert.ok(fuzzyIncludes('Chemlstry lab', 'chemistry')); // one wrong letter
assert.ok(fuzzyIncludes('Chemlstny lab', 'chemistry')); // two wrong letters in a 9-letter word
assert.ok(!fuzzyIncludes('Chemlstny lab', 'chem1stry!!!x')); // too far
assert.ok(!fuzzyIncludes('dog house', 'cat')); // short words must match exactly
assert.ok(!fuzzyIncludes('dig', 'dog'));
assert.ok(fuzzyIncludes('the dog', 'dog'));
assert.ok(!fuzzyIncludes('', 'hello'));
assert.ok(!fuzzyIncludes('hello', '   '));
assert.ok(!fuzzyIncludes('Physics homework', 'chemistry'));
console.log('ink-bands checks passed');
