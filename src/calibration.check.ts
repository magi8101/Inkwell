// Run: node src/calibration.check.ts — fails loudly if calibration picks unreasonable settings.
import assert from 'node:assert/strict';
import {
  bestPrediction,
  fastLineFit,
  looksFlat,
  type PenSample,
  palmThreshold,
  pressureFit,
  pressureVerdict,
  rateFromTimes,
  sampleRate,
  smoothingFromStill,
  startWarmup,
} from './calibration.ts';

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

// Sample rate: a pen reporting every ~4.2 ms is ~240 Hz.
const at240 = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0, t: i * 4.17, p: 0.5 }));
assert.ok(Math.abs(sampleRate(at240) - 240) < 2, `sample rate ${sampleRate(at240)}`);

// Still pen: a steady sensor gets nearly raw ink, a noisy one more smoothing.
const still = (noise: number): PenSample[] =>
  Array.from({ length: 200 }, (_, i) => ({
    x: 100 + rnd() * noise,
    y: 100 + rnd() * noise,
    t: i * 4,
    p: 0.5,
  }));
const steady = smoothingFromStill(still(0.2))!;
const shaky = smoothingFromStill(still(6))!;
assert.ok(steady.smoothing >= 0.85, `steady sensor → ${steady.smoothing}`);
assert.ok(shaky.smoothing <= 0.55, `noisy sensor → ${shaky.smoothing}`);
assert.equal(smoothingFromStill(still(1).slice(0, 5)), null, 'too few samples → no change');

// Pressure: a light 0.2 / firm 0.7 writer gets a range where firm is clearly wider than light.
const around = (c: number) => Array.from({ length: 60 }, () => c + rnd() * 0.05);
const fit = pressureFit(around(0.2), around(0.7))!;
const width = (p: number) => (0.5 - fit.thinning * (0.5 - p)) ** fit.gamma;
assert.ok(
  width(0.7) / width(0.2) > 1.8,
  `firm/light width ratio ${(width(0.7) / width(0.2)).toFixed(2)}`,
);
assert.ok(Math.abs(width(0.45) - 0.5) < 0.08, 'typical pressure lands near the normal width');
assert.equal(pressureFit(around(0.5), around(0.5)), null, 'no pressure range → no change');

// Prediction: for smooth fast circles, some lead beats no lead and is within the tested range.
const circle: PenSample[] = Array.from({ length: 240 }, (_, i) => {
  const a = (i / 240) * Math.PI * 4;
  return { x: 300 + 120 * Math.cos(a), y: 300 + 120 * Math.sin(a), t: i * 4, p: 0.5 };
});
const pred = bestPrediction([circle], 16, 40)!;
assert.ok(pred.predictMs >= 8 && pred.predictMs <= 24, `chosen lead ${pred.predictMs} ms`);
assert.ok(pred.errorPx < pred.noPredictionErrorPx * 0.6, 'prediction clearly reduces the lag');
// A zig-zagging writer (sharp reversals) gets less lead than smooth circles.
const zigzag: PenSample[] = Array.from({ length: 240 }, (_, i) => ({
  x: i * 2,
  y: (i % 12 < 6 ? i % 6 : 6 - (i % 6)) * 12,
  t: i * 4,
  p: 0.5,
}));
assert.ok(
  bestPrediction([zigzag], 16, 40)!.predictMs <= pred.predictMs,
  'zig-zags get a shorter lead',
);

// Palm: threshold between finger (~50 px) and palm (~180 px); unreported sizes → no change.
assert.equal(palmThreshold([45, 50, 52, 48], [170, 190, 200]), 120);
assert.equal(palmThreshold([1, 1, 1], [1, 1]), null);
console.log('calibration checks passed');

// A pen that reports a pressure spike for its first 3 samples: found. A clean pen: none.
const stroke = (spike: number, n = 30): PenSample[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, t: i * 8, p: i < spike ? 0.95 : 0.35 }));
assert.equal(
  startWarmup(Array.from({ length: 5 }, () => stroke(3))),
  3,
  'spike of 3 samples found',
);
assert.equal(
  startWarmup(Array.from({ length: 5 }, () => stroke(0))),
  0,
  'clean pen has no warm-up',
);
assert.equal(startWarmup([stroke(3), stroke(3)]), null, 'too few strokes to decide');
assert.equal(
  startWarmup(Array.from({ length: 5 }, () => stroke(3).map((s) => ({ ...s, p: 0 })))),
  null,
  'no pressure at all: nothing to fix',
);

// Fast straight lines: clean lines earn more speed gain than wobbly ones.
const line = (wobble: number): PenSample[] =>
  Array.from({ length: 40 }, (_, i) => ({
    x: i * 12,
    y: wobble * Math.sin(i * 2.1),
    t: i * 8,
    p: 0.4,
  }));
const clean = fastLineFit(Array.from({ length: 4 }, () => line(0.2)))!;
const wobbly = fastLineFit(Array.from({ length: 4 }, () => line(3)))!;
assert.ok(clean.speedGain > wobbly.speedGain, 'clean fast lines → higher speed gain');
assert.ok(clean.speed > 1.4 && clean.speed < 1.6, 'speed in px/ms');
assert.equal(fastLineFit([line(0.2), line(0.2)]), null, 'needs three lines');

// Hover rate: from several events, not one. A 120 Hz pen, a 60 Hz frame-aligned pen, a pause in
// the middle, and too few events to say anything.
const ticks = (hz: number, n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => start + (i * 1000) / hz);
assert.ok(Math.abs(rateFromTimes(ticks(120, 60)) - 120) < 1, '120 Hz');
assert.ok(Math.abs(rateFromTimes(ticks(60, 60)) - 60) < 1, '60 Hz');
assert.ok(
  Math.abs(rateFromTimes([...ticks(100, 20), ...ticks(100, 20, 2000)]) - 100) < 1,
  'a pause is not the rate',
);
assert.equal(rateFromTimes([5]), 0, 'one event says nothing');
assert.equal(rateFromTimes([1, 2]), 0, 'two events are not enough');
assert.equal(rateFromTimes([10, 10, 10, 10]), 0, 'identical times say nothing');

// Pressure verdicts: what the wizard tells the person after light and firm writing.
const spread = (lo: number, hi: number, n = 150) =>
  Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
assert.equal(
  pressureVerdict(spread(0.1, 0.3, 10), spread(0.5, 0.8, 150)),
  'more',
  'too few light samples',
);
assert.equal(pressureVerdict(spread(0.1, 0.3), spread(0.5, 0.8)), 'ok', 'real pressure');
assert.equal(
  pressureVerdict(spread(0.2, 0.4), spread(0.22, 0.42)),
  'weak',
  'the firm writing was not firmer',
);
assert.equal(
  pressureVerdict(new Array(150).fill(0.5), new Array(150).fill(0.5)),
  'flat',
  'a fixed 0.5',
);
assert.equal(
  pressureVerdict(new Array(150).fill(0), new Array(150).fill(1)),
  'flat',
  'two levels only',
);
assert.ok(
  looksFlat(new Array(60).fill(0.5)) && !looksFlat(new Array(20).fill(0.5)),
  'flat needs enough samples',
);
assert.ok(!looksFlat(spread(0.1, 0.9, 60)), 'a spread of pressure is not flat');
console.log('hover and pressure verdict checks passed');
