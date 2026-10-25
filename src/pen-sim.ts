// A pen simulator for checks (pen-fit.check.ts): synthetic pens with known sensor noise, report
// rate, pressure behaviour and dropped events, drawing paths whose true position is known. What the
// calibration measures can then be scored against the truth, for every kind of pen, without a
// device. Pure, no DOM.

import type { PenSample } from './calibration.ts';

export interface PenProfile {
  name: string;
  /** Reports per second while writing. */
  rateHz: number;
  /** Sensor noise: standard deviation of the reported position around the truth, px. */
  jitterPx: number;
  /** What the pen reports for pressure. */
  pressure: 'real' | 'flat' | 'binary';
  /** Real pressure range this pen actually reaches. */
  range: [number, number];
  /** First samples of each stroke that report a spike. */
  spikeSamples: number;
  /** Share of reports lost (a busy page, Safari between frames). */
  dropRate: number;
}

export const PROFILES: PenProfile[] = [
  {
    name: 'apple pencil',
    rateHz: 120,
    jitterPx: 0.1,
    pressure: 'real',
    range: [0.05, 0.95],
    spikeSamples: 0,
    dropRate: 0.02,
  },
  {
    name: 'apple pencil, start spike',
    rateHz: 120,
    jitterPx: 0.15,
    pressure: 'real',
    range: [0.05, 0.95],
    spikeSamples: 3,
    dropRate: 0.05,
  },
  {
    name: 'surface pen',
    rateHz: 90,
    jitterPx: 0.4,
    pressure: 'real',
    range: [0.1, 0.7],
    spikeSamples: 0,
    dropRate: 0,
  },
  {
    name: 'noisy emr pen',
    rateHz: 120,
    jitterPx: 1.5,
    pressure: 'real',
    range: [0.2, 0.6],
    spikeSamples: 2,
    dropRate: 0,
  },
  {
    name: 'sparse 30 Hz',
    rateHz: 30,
    jitterPx: 0.3,
    pressure: 'real',
    range: [0.1, 0.9],
    spikeSamples: 0,
    dropRate: 0.15,
  },
  {
    name: 'cheap stylus (no pressure)',
    rateHz: 60,
    jitterPx: 0.9,
    pressure: 'flat',
    range: [0.5, 0.5],
    spikeSamples: 0,
    dropRate: 0.1,
  },
  {
    name: 'clone pencil (two levels)',
    rateHz: 60,
    jitterPx: 0.6,
    pressure: 'binary',
    range: [0.2, 1],
    spikeSamples: 0,
    dropRate: 0.05,
  },
];

/** A seeded random source, so a check always sees the same pens. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const uniform = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(uniform(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, gauss };
}

export type Path = (u: number) => { x: number; y: number };
export const linePath =
  (x0: number, y0: number, x1: number, y1: number): Path =>
  (u) => ({
    x: x0 + (x1 - x0) * u,
    y: y0 + (y1 - y0) * u,
  });
export const circlePath =
  (cx: number, cy: number, r: number): Path =>
  (u) => ({
    x: cx + r * Math.cos(u * Math.PI * 2 * 2),
    y: cy + r * Math.sin(u * Math.PI * 2 * 2),
  });
/** Handwriting-like: a slanted line with loops and wiggles. */
export const scriptPath =
  (x0: number, y0: number, w: number): Path =>
  (u) => ({
    x: x0 + w * u + 18 * Math.cos(u * 40),
    y: y0 + 24 * Math.sin(u * 40) + 8 * Math.sin(u * 13),
  });

export interface Simulated {
  /** What the pen reported. */
  raw: PenSample[];
  /** Where the pen really was at each reported sample. */
  truth: { x: number; y: number }[];
}

/** One stroke along `path`, `lengthPx` long at `speed` px/ms (the pen moves at a steady speed). */
export function simulate(
  pen: PenProfile,
  path: Path,
  lengthPx: number,
  speed: number,
  seed: number,
): Simulated {
  const { uniform, gauss } = rng(seed);
  const dt = 1000 / pen.rateHz;
  const duration = lengthPx / speed;
  const n = Math.max(2, Math.floor(duration / dt));
  const raw: PenSample[] = [];
  const truth: { x: number; y: number }[] = [];
  const [lo, hi] = pen.range;
  for (let i = 0; i <= n; i++) {
    if (i > 1 && i < n && uniform() < pen.dropRate) continue; // a lost report
    const u = i / n;
    const at = path(u);
    // A smooth press-and-release across the stroke, within the range this pen reaches.
    const base = lo + (hi - lo) * (0.35 + 0.55 * Math.sin(u * Math.PI));
    let p = base;
    if (pen.pressure === 'flat') p = 0.5;
    else if (pen.pressure === 'binary') p = base > (lo + hi) / 2 ? hi : lo;
    if (i < pen.spikeSamples) p = Math.min(1, p + 0.55);
    truth.push(at);
    raw.push({
      x: at.x + gauss() * pen.jitterPx,
      y: at.y + gauss() * pen.jitterPx,
      t: i * dt,
      p,
    });
  }
  return { raw, truth };
}
