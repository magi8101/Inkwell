// Run: node src/pen-fit.check.ts — every simulated pen is calibrated the way the wizard does it,
// then both the default settings and the calibrated ones are scored on handwriting the pen "wrote"
// afterwards, against where the pen really was. Calibrated must never be meaningfully worse, and
// must clearly help noisy pens. Prints the table so a change that hurts one pen kind is visible.
import assert from 'node:assert/strict';
import { fitSettings, type PenSample } from './calibration.ts';
import { type FilterParams, smoothRun } from './capture-filter.ts';
import {
  circlePath,
  linePath,
  type PenProfile,
  PROFILES,
  rng,
  scriptPath,
  simulate,
} from './pen-sim.ts';

const DEFAULTS: FilterParams = { smoothing: 0.75, speedGain: 0 };

/** Wander off the true path plus lag behind it, px (lower is better). */
function score(raw: PenSample[], truth: { x: number; y: number }[], p: FilterParams) {
  const out = smoothRun(raw, p);
  let across = 0;
  let lag = 0;
  let n = 0;
  for (let j = 1; j < out.length - 1; j++) {
    const o = out[j]!;
    const a = truth[Math.max(0, o.i - 1)]!;
    const b = truth[Math.min(truth.length - 1, o.i + 1)]!;
    const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ex = o.x - truth[o.i]!.x;
    const ey = o.y - truth[o.i]!.y;
    across += ((ex * (b.y - a.y) - ey * (b.x - a.x)) / dl) ** 2;
    lag += -(ex * (b.x - a.x) + ey * (b.y - a.y)) / dl;
    n++;
  }
  return Math.sqrt(across / n) + Math.max(0, lag / n);
}

const withRange = (pen: PenProfile, from: number, to: number): PenProfile => {
  if (pen.pressure === 'binary') return pen; // a two-level pen reports the same levels at any force
  const [lo, hi] = pen.range;
  return { ...pen, range: [lo + (hi - lo) * from, lo + (hi - lo) * to] };
};

function calibrate(pen: PenProfile) {
  const g = rng(11);
  const still: PenSample[] = Array.from({ length: 120 }, (_, i) => ({
    x: 500 + g.gauss() * pen.jitterPx,
    y: 500 + g.gauss() * pen.jitterPx,
    t: i * (1000 / pen.rateHz),
    p: pen.pressure === 'flat' ? 0.5 : pen.range[0] + (pen.range[1] - pen.range[0]) * 0.5,
  }));
  const light = simulate(withRange(pen, 0, 0.3), scriptPath(100, 300, 500), 900, 0.8, 21).raw;
  const firm = simulate(withRange(pen, 0.65, 1), scriptPath(100, 300, 500), 900, 0.8, 22).raw;
  const fast = [31, 32, 33].map((s) => simulate(pen, circlePath(500, 500, 150), 1885, 2.5, s).raw);
  const lines = [41, 42, 43, 44, 45, 46].map(
    (s) => simulate(pen, linePath(100, 500 + s, 700, 500 + s), 600, 2.5, s).raw,
  );
  return fitSettings({ still, light, firm, fast, lines, fingers: [], palms: [], frame: 16.7 });
}

const rows: string[] = [];
const fails: string[] = [];
const ok = (c: boolean, m: string) => {
  if (!c) fails.push(m);
};
for (const pen of PROFILES) {
  const { patch, notes } = calibrate(pen);
  const fitted: FilterParams = {
    smoothing: patch.smoothing ?? DEFAULTS.smoothing,
    speedGain: patch.speedGain ?? 0,
  };
  let before = 0;
  let after = 0;
  let n = 0;
  for (const speed of [0.5, 1.5, 2.5]) {
    for (let seed = 100; seed < 106; seed++) {
      const sim = simulate(pen, scriptPath(100, 300, 600), 900, speed, seed * 7 + speed * 10);
      before += score(sim.raw, sim.truth, DEFAULTS);
      after += score(sim.raw, sim.truth, fitted);
      n++;
    }
  }
  before /= n;
  after /= n;
  rows.push(
    `${pen.name.padEnd(28)} default ${before.toFixed(2)} → calibrated ${after.toFixed(2)} px  (${fitted.smoothing}, +${fitted.speedGain}; warm-up ${patch.startWarmup ?? '-'}; pressure ${patch.pressureLo ?? '-'}–${patch.pressureHi ?? '-'}; width ${patch.thinning ?? '-'})`,
  );
  ok(after <= before * 1.08, `${pen.name}: calibrated settings are worse (${after} vs ${before})`);
  if (pen.jitterPx >= 1.4)
    ok(after <= before * 0.85, `${pen.name}: noisy pen is not clearly better`);
  // Stroke starts: found where the pen spikes, not invented where it does not.
  if (pen.spikeSamples)
    ok((patch.startWarmup ?? 0) >= pen.spikeSamples - 1, `${pen.name}: spike missed`);
  else ok((patch.startWarmup ?? 0) <= 1, `${pen.name}: invented a start spike`);
  // Pressure range: found for real pressure; two-level pens get an even width; flat pens are left.
  if (pen.pressure === 'real') {
    ok(
      patch.pressureHi !== undefined && patch.pressureLo !== undefined,
      `${pen.name}: no pressure range`,
    );
    ok(Math.abs(patch.pressureLo! - pen.range[0]) < 0.2, `${pen.name}: pressure floor off`);
    ok(Math.abs(patch.pressureHi! - pen.range[1]) < 0.25, `${pen.name}: pressure ceiling off`);
  }
  if (pen.pressure === 'binary')
    ok(patch.thinning === 0, `${pen.name}: two-level pressure must not vary the width`);
  void notes;
}
console.log(rows.join('\n'));
assert.deepEqual(fails, [], fails.join('\n'));
console.log('pen-fit checks passed');
