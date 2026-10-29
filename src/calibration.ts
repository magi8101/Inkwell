// Calibration maths: turns what the user's pen actually did during the calibration steps into
// settings. Pure functions (no DOM), so they're checked in calibration.check.ts.

import { type FilterParams, smoothRun } from './capture-filter.ts';
import { predict } from './predict.ts';

export interface PenSample {
  x: number;
  y: number;
  /** Event timestamp, ms. */
  t: number;
  p: number;
}

export const median = (v: readonly number[]) => percentile(v, 0.5);
export function percentile(values: readonly number[], q: number): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Samples per second while the pen was moving or touching. */
export function sampleRate(samples: readonly PenSample[]): number {
  if (samples.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.t - samples[i - 1]!.t;
    if (d > 0 && d < 100) gaps.push(d);
  }
  return gaps.length ? 1000 / median(gaps) : 0;
}

/**
 * Events per second from event times (ms), taking the median gap between neighbours that are less
 * than 100 ms apart (a longer gap is a pause, not the pen's rate). 0 when there is too little to say.
 * Hover has no coalesced events on many pens, so the rate has to come from several events.
 */
export function rateFromTimes(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 0 && d < 100) gaps.push(d);
  }
  return gaps.length >= 3 ? 1000 / median(gaps) : 0;
}

/**
 * What light and firm writing say about a pen's pressure, so the wizard can tell the person at once
 * instead of ending with "no usable pressure":
 *  - `more`: not enough samples yet;
 *  - `flat`: it only ever reports one or two values (no pressure sensor, or a driver that fixes it);
 *  - `weak`: the firm writing is hardly harder than the light (press harder and write again);
 *  - `ok`.
 */
export function pressureVerdict(
  light: readonly number[],
  firm: readonly number[],
): 'more' | 'flat' | 'weak' | 'ok' {
  if (light.length < 20 || firm.length < 20) return 'more';
  if (pressureLevels([...light, ...firm]) <= 2) return 'flat';
  return median(firm) - median(light) < 0.05 ? 'weak' : 'ok';
}

/** A pen that reports one or two pressure values over enough samples has no pressure to measure. */
export const looksFlat = (values: readonly number[]) =>
  values.length >= 40 && pressureLevels(values) <= 2;

/**
 * Holding the pen still: how much the reported position wanders (px RMS around its mean) and the
 * "Follow" smoothing that hides it. Steady sensors get almost raw ink (snappier), noisy ones more
 * smoothing.
 */
export function smoothingFromStill(
  samples: readonly PenSample[],
): { noisePx: number; smoothing: number } | null {
  if (samples.length < 15) return null;
  const mx = samples.reduce((a, s) => a + s.x, 0) / samples.length;
  const my = samples.reduce((a, s) => a + s.y, 0) / samples.length;
  const noisePx = Math.sqrt(
    samples.reduce((a, s) => a + (s.x - mx) ** 2 + (s.y - my) ** 2, 0) / samples.length,
  );
  // 0.15 px noise → 0.95 (nearly raw); 1.5 px or more → 0.45 (strong smoothing).
  const smoothing = clamp(0.95 - ((noisePx - 0.15) / (1.5 - 0.15)) * 0.5, 0.45, 0.95);
  return { noisePx, smoothing: Math.round(smoothing * 20) / 20 };
}

/**
 * Light vs firm writing: choose how strongly pressure changes the width (thinning) so firm strokes
 * come out about TARGET_RATIO times as wide as light ones, and a curve (gamma) that puts the user's
 * typical pressure at the pen's normal width.
 */
const TARGET_RATIO = 2.5;
export function pressureFit(
  light: readonly number[],
  firm: readonly number[],
): { light: number; firm: number; thinning: number; gamma: number } | null {
  if (light.length < 20 || firm.length < 20) return null;
  const pl = median(light);
  const pf = median(firm);
  if (!(pf > pl + 0.03)) return null; // no usable pressure range (or no pressure at all)
  // Width ∝ t = 0.5 − thinning·(0.5 − p); solve t(pf) = R · t(pl) for thinning.
  const r = TARGET_RATIO;
  const denom = 0.5 * r - 0.5 + pf - r * pl;
  const thinning = clamp(denom > 0 ? (0.5 * (r - 1)) / denom : 0.9, 0.15, 0.9);
  const typical = (pl + pf) / 2;
  const t = 0.5 - thinning * (0.5 - typical);
  const gamma = t > 0 && t < 1 ? clamp(Math.log(0.5) / Math.log(t), 0.4, 2.5) : 1;
  return {
    light: pl,
    firm: pf,
    thinning: Math.round(thinning * 20) / 20,
    gamma: Math.round(gamma * 10) / 10,
  };
}

/** Linear interpolation of the true pen position at time t, or null past the stroke's end. */
function positionAt(s: readonly PenSample[], from: number, t: number) {
  for (let i = from; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (b.t >= t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return null;
}

/**
 * Replays the user's fast strokes through the predictor at every lead time and picks the one whose
 * guess lands closest to where the pen really was `latencyMs` later — i.e. what best hides this
 * device's delay without overshooting this user's handwriting.
 */
export function bestPrediction(
  strokes: readonly (readonly PenSample[])[],
  latencyMs: number,
  maxPx: number,
): { predictMs: number; errorPx: number; noPredictionErrorPx: number } | null {
  const leads = Array.from({ length: 17 }, (_, i) => i * 2); // 0..32 ms
  const sums = leads.map(() => 0);
  let n = 0;
  for (const s of strokes) {
    for (let i = 4; i < s.length; i++) {
      const truth = positionAt(s, i, s[i]!.t + latencyMs);
      if (!truth) break;
      const history = s.slice(0, i + 1);
      const last = s[i]!;
      leads.forEach((h, k) => {
        const guess = (h > 0 && predict(history, h, maxPx)) || last;
        sums[k]! += Math.hypot(guess.x - truth.x, guess.y - truth.y);
      });
      n++;
    }
  }
  if (n < 30) return null;
  const errors = sums.map((v) => v / n);
  let best = 0;
  for (let k = 1; k < errors.length; k++) if (errors[k]! < errors[best]!) best = k;
  return { predictMs: leads[best]!, errorPx: errors[best]!, noPredictionErrorPx: errors[0]! };
}

/**
 * Some pens (and Safari's first touch event) report a pressure spike for the first few samples of a
 * stroke, which draws a fat blob at the start. Over the strokes drawn with this pen: how many
 * leading samples are well above the pressure the stroke settles at. 0 means no spike (or no
 * pressure at all). Needs several strokes, so one odd stroke doesn't decide.
 */
export function startWarmup(strokes: readonly (readonly PenSample[])[]): number | null {
  const counts: number[] = [];
  for (const s of strokes) {
    if (s.length < 14) continue;
    // Pressure usually climbs as a stroke starts, so a spike is a start that is above everything the
    // next few samples reach, not above their median.
    const settled = Math.max(...s.slice(6, 12).map((q) => q.p));
    if (!(settled > 0.05)) continue; // no pressure reported
    let k = 0;
    while (k < 6 && s[k]!.p > settled + 0.08) k++;
    counts.push(k);
  }
  return counts.length >= 4 ? Math.round(median(counts)) : null;
}

/**
 * Quick straight lines: how far the pen wanders off the straight line (px RMS) and how fast it
 * moves. Smoothing that hides jitter also makes fast strokes lag and round off, so the gain says
 * how much the smoothing should back off per px/ms of speed: clean fast lines get more, wobbly
 * ones less.
 */
export function fastLineFit(
  lines: readonly (readonly PenSample[])[],
): { wobblePx: number; speed: number; speedGain: number } | null {
  const wobble: number[] = [];
  const speed: number[] = [];
  for (const s of lines) {
    if (s.length < 8) continue;
    const a = s[0]!;
    const b = s[s.length - 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 150 || b.t <= a.t) continue;
    let sum = 0;
    for (let i = 1; i < s.length - 1; i++) {
      const p = s[i]!;
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
      sum += d * d;
    }
    wobble.push(Math.sqrt(sum / (s.length - 2)));
    speed.push(len / (b.t - a.t));
  }
  if (wobble.length < 3) return null;
  const wobblePx = median(wobble);
  const gain = clamp(0.4 - wobblePx / 8, 0, 0.4);
  return { wobblePx, speed: median(speed), speedGain: Math.round(gain * 20) / 20 };
}

/**
 * Palm threshold between the biggest fingertip and the smallest palm contact. Returns null when
 * the screen doesn't report contact sizes (then only pen proximity rejects palms).
 */
export function palmThreshold(fingers: readonly number[], palms: readonly number[]): number | null {
  if (!fingers.length || !palms.length) return null;
  const finger = percentile(fingers, 0.9);
  const palm = percentile(palms, 0.5);
  if (finger <= 2 && palm <= 2) return null; // sizes not reported (all 1×1)
  const cut = palm > finger * 1.3 ? (finger + palm) / 2 : finger * 1.6;
  return Math.round(clamp(cut, 40, 300) / 5) * 5;
}

// --- Fitting the capture filter from the user's own fast lines and circles ---

/** Least-squares circle through points (Kåsa fit), or null when they are not round enough. */
function fitCircle(pts: readonly { x: number; y: number }[]) {
  const n = pts.length;
  if (n < 12) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-6) return null;
  const uc = ((suuu + suvv) * svv - (svvv + svuu) * suv) / (2 * det);
  const vc = ((svvv + svuu) * suu - (suuu + suvv) * suv) / (2 * det);
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return r > 30 ? { cx: mx + uc, cy: my + vc, r } : null;
}

/** The stroke's intended shape: a chord for a line, the fitted circle for a ring. */
function ideal(s: readonly PenSample[], kind: 'line' | 'ring' | 'free') {
  if (kind === 'free') return () => 0; // no known shape: only the lag counts
  if (kind === 'ring') {
    const c = fitCircle(s);
    return c ? (x: number, y: number) => Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r) : null;
  }
  const a = s[0]!;
  const b = s[s.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 150) return null;
  return (x: number, y: number) =>
    Math.abs((b.x - a.x) * (a.y - y) - (a.x - x) * (b.y - a.y)) / len;
}

/** One stroke's cost for these filter settings: wander off the intended shape plus lag, in px. */
function strokeCost(s: readonly PenSample[], kind: 'line' | 'ring' | 'free', p: FilterParams) {
  const off = ideal(s, kind);
  if (!off) return null;
  const out = smoothRun(s, p);
  if (out.length < 8) return null;
  let wander = 0;
  let lag = 0;
  for (let j = 1; j < out.length - 1; j++) {
    const o = out[j]!;
    wander += off(o.x, o.y) ** 2;
    // Lag: how far the raw pen is ahead of the smoothed point, along the direction of travel.
    const a = out[j - 1]!;
    const b = out[j + 1]!;
    const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const r = s[o.i]!;
    lag += ((r.x - o.x) * (b.x - a.x) + (r.y - o.y) * (b.y - a.y)) / dl;
  }
  const m = out.length - 2;
  return Math.sqrt(wander / m) + Math.max(0, lag / m);
}

/** A flat run of samples split into strokes wherever the pen was off the screen for a moment. */
export function splitStrokes(samples: readonly PenSample[], gapMs = 150): PenSample[][] {
  const out: PenSample[][] = [];
  let cur: PenSample[] = [];
  for (const q of samples) {
    const last = cur[cur.length - 1];
    if (last && (q.t < last.t || q.t - last.t > gapMs)) {
      out.push(cur);
      cur = [];
    }
    cur.push(q);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Noise left in a held-still pen after smoothing, px RMS around where it really was. */
function stillCost(s: readonly PenSample[], p: FilterParams) {
  if (s.length < 15) return null;
  const mx = s.reduce((a, q) => a + q.x, 0) / s.length;
  const my = s.reduce((a, q) => a + q.y, 0) / s.length;
  const out = smoothRun(s, p);
  let sum = 0;
  for (const o of out) sum += (o.x - mx) ** 2 + (o.y - my) ** 2;
  return Math.sqrt(sum / out.length);
}

/**
 * Searches smoothing and speed gain for the least wander + lag. Three kinds of evidence, since
 * smoothing is cheap at a standstill and costly when fast: fast lines and rings (wander off the
 * intended shape plus lag; the shape is a chord or a fitted circle, so no outside truth is needed),
 * ordinary writing (lag only, at natural speed) and the held-still pen (noise left over).
 * Returns null without enough fast strokes.
 */
export function fitFilter(
  lines: readonly (readonly PenSample[])[],
  rings: readonly (readonly PenSample[])[],
  writing: readonly (readonly PenSample[])[] = [],
  still: readonly PenSample[] = [],
): (FilterParams & { cost: number; baseCost: number }) | null {
  const fast = [
    ...lines.map((s) => ({ s, kind: 'line' as const })),
    ...rings.map((s) => ({ s, kind: 'ring' as const })),
  ].filter((x) => x.s.length >= 12);
  if (fast.length < 3) return null;
  const slow = writing.filter((s) => s.length >= 12).map((s) => ({ s, kind: 'free' as const }));
  const mean = (
    set: { s: readonly PenSample[]; kind: 'line' | 'ring' | 'free' }[],
    p: FilterParams,
  ) => {
    let sum = 0;
    let n = 0;
    for (const x of set) {
      const c = strokeCost(x.s, x.kind, p);
      if (c !== null) {
        sum += c;
        n++;
      }
    }
    return n ? sum / n : null;
  };
  const cost = (p: FilterParams) => {
    const a = mean(fast, p);
    if (a === null) return Number.NaN;
    return a + (mean(slow, p) ?? 0) + (stillCost(still, p) ?? 0);
  };
  let best: (FilterParams & { cost: number }) | null = null;
  for (let sm = 0.3; sm <= 1.0001; sm += 0.05) {
    for (let g = 0; g <= 1.0001; g += 0.05) {
      const p = { smoothing: Math.round(sm * 20) / 20, speedGain: Math.round(g * 20) / 20 };
      const c = cost(p);
      if (Number.isFinite(c) && (!best || c < best.cost - 1e-9)) best = { ...p, cost: c };
    }
  }
  const baseCost = cost({ smoothing: 0.75, speedGain: 0 });
  return best && Number.isFinite(baseCost) ? { ...best, baseCost } : null;
}

// --- Pressure range ---

/**
 * The pressure range this pen really reaches (3rd to 95th percentile of everything it reported; the top is lower so a few spikes can't stretch it),
 * so the full width range is usable even if the pen tops out at 0.6 or starts at 0.3. Null when the
 * pen reports (almost) no pressure variation.
 */
export function pressureRange(values: readonly number[]): { lo: number; hi: number } | null {
  if (values.length < 60) return null;
  const lo = percentile(values, 0.03);
  const hi = percentile(values, 0.95);
  return hi - lo >= 0.08
    ? { lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100 }
    : null;
}

/** A pen that only ever reports a few distinct pressure levels (a clone's two levels) has none. */
export function pressureLevels(values: readonly number[]): number {
  return new Set(values.map((v) => Math.round(v * 25))).size;
}

// --- Everything together ---

export interface FitData {
  still: PenSample[];
  light: PenSample[];
  firm: PenSample[];
  /** Fast circles, one entry per stroke. */
  fast: PenSample[][];
  /** Fast straight lines, one entry per stroke. */
  lines: PenSample[][];
  fingers: number[];
  palms: number[];
  /** Display frame time, ms. */
  frame: number;
}

export interface FitPatch {
  smoothing?: number;
  speedGain?: number;
  startWarmup?: number;
  thinning?: number;
  pressureGamma?: number;
  pressureLo?: number;
  pressureHi?: number;
  prediction?: boolean;
  predictAuto?: boolean;
  predictMs?: number;
  palmPx?: number;
}

/** Turns what the pen did in every calibration step into settings, with a line saying why. */
export function fitSettings(d: FitData): { patch: FitPatch; notes: string[] } {
  const patch: FitPatch = {};
  const notes: string[] = [];
  const strokes = [...d.fast, ...d.lines];

  // Stroke starts: a pressure spike on the first samples draws a blob.
  const warm = startWarmup(strokes);
  if (warm !== null) {
    patch.startWarmup = warm;
    notes.push(
      warm
        ? `Pressure spike at the start of strokes (${warm} samples) → Start fix ${warm}`
        : 'No pressure spike at the start of strokes → Start fix off',
    );
  }

  // Pressure: this pen's real range, then width from how light and firm writing compare in it.
  const settled = [
    ...d.light.map((q) => q.p),
    ...d.firm.map((q) => q.p),
    ...strokes.flatMap((st) => st.slice(6).map((q) => q.p)),
  ];
  if (pressureLevels(settled) <= 3 && settled.length >= 60) {
    patch.thinning = 0;
    notes.push('Pressure takes only a couple of levels (not real pressure) → even line width');
  } else {
    const range = pressureRange(settled);
    if (range) {
      patch.pressureLo = range.lo;
      patch.pressureHi = range.hi;
      notes.push(`Pressure range ${range.lo}–${range.hi} → stretched to the full width range`);
      const norm = (q: PenSample) => clamp((q.p - range.lo) / (range.hi - range.lo), 0, 1);
      const pf = pressureFit(d.light.map(norm), d.firm.map(norm));
      if (pf) {
        patch.thinning = pf.thinning;
        patch.pressureGamma = pf.gamma;
        notes.push(`Pressure → Pressure ${pf.thinning}, Curve ${pf.gamma}`);
      }
    } else if (d.light.length) {
      notes.push('No usable pressure range detected — pressure settings left as they were');
    }
  }

  // Smoothing and speed: searched on the user's own fast strokes; the held-still jitter is the
  // fallback when there are not enough of them.
  const fit = fitFilter(
    d.lines,
    d.fast,
    [...splitStrokes(d.light), ...splitStrokes(d.firm)],
    d.still.slice(Math.floor(d.still.length * 0.15)),
  );
  if (fit) {
    patch.smoothing = fit.smoothing;
    patch.speedGain = fit.speedGain;
    notes.push(
      `Fast strokes: wander + lag ${fit.baseCost.toFixed(2)} → ${fit.cost.toFixed(2)} px → Follow ${fit.smoothing}, Speed boost ${fit.speedGain}`,
    );
  } else {
    const still = smoothingFromStill(d.still.slice(Math.floor(d.still.length * 0.15)));
    if (still) {
      patch.smoothing = still.smoothing;
      notes.push(`Sensor jitter ${still.noisePx.toFixed(2)} px → Follow ${still.smoothing}`);
    }
  }

  const pred = bestPrediction(d.fast, d.frame, 28);
  if (pred) {
    patch.prediction = pred.predictMs > 0;
    patch.predictAuto = false;
    patch.predictMs = pred.predictMs;
    notes.push(
      `Prediction ${pred.predictMs} ms: tip error ${pred.errorPx.toFixed(1)} px (vs ${pred.noPredictionErrorPx.toFixed(1)} px without)`,
    );
  }

  const palm = palmThreshold(d.fingers, d.palms);
  if (palm) {
    patch.palmPx = palm;
    notes.push(
      `Finger ≈ ${Math.round(percentile(d.fingers, 0.9))} px, palm ≈ ${Math.round(median(d.palms))} px → Palm size ${palm} px`,
    );
  } else if (d.palms.length || d.fingers.length) {
    notes.push('This screen does not report touch size — palms are rejected by pen proximity only');
  }
  return { patch, notes };
}
