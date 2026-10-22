// Run: node src/calibration.check.ts — fails loudly if calibration picks unreasonable settings.
import assert from 'node:assert/strict';
import {
  bestPrediction,
  type PenSample,
  palmThreshold,
  pressureFit,
  sampleRate,
  smoothingFromStill,
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
