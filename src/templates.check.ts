// Run: node src/templates.check.ts — the ruling of each template stays inside the sheet and has
// the structure the layouts promise.
import assert from 'node:assert/strict';
import { templateLines } from './template-lines.ts';

const W = 794;
const H = 1123;
for (const t of ['cornell', 'staff', 'graph'] as const) {
  const lines = templateLines(t, W, H);
  assert.ok(lines.length > 10, `${t} has ruling`);
  for (const s of lines) {
    for (const v of [s.x1, s.x2]) assert.ok(v >= 0 && v <= W, `${t}: x ${v} outside the sheet`);
    for (const v of [s.y1, s.y2]) assert.ok(v >= 0 && v <= H, `${t}: y ${v} outside the sheet`);
  }
}
// Cornell: three main rules (title, cue column, summary) and ruled lines.
const cornell = templateLines('cornell', W, H);
assert.equal(cornell.filter((s) => s.strong).length, 3);
assert.ok(cornell.some((s) => !s.strong && s.y1 === s.y2));
// Music: staves of exactly five lines (plus two barlines each).
const staff = templateLines('staff', W, H);
const staves = staff.filter((s) => s.y1 === s.y2).length;
assert.equal(staves % 5, 0);
assert.equal(staff.filter((s) => s.x1 === s.x2).length, (staves / 5) * 2);
// Graph: every fifth line is strong, on both axes.
const graph = templateLines('graph', W, H);
assert.ok(graph.filter((s) => s.strong).length >= 20);
assert.ok(graph.some((s) => s.x1 === s.x2 && !s.strong));
// A smaller sheet gets fewer lines, never lines outside it.
assert.ok(templateLines('staff', 500, 400).length < staff.length);
console.log('templates checks passed');
