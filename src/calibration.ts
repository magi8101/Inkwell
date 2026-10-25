// Calibration maths: turns what the user's pen actually did during the calibration steps into
// settings. Pure functions (no DOM), so they're checked in calibration.check.ts.

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
    const settled = median(s.slice(6, 12).map((q) => q.p));
    if (!(settled > 0.05)) continue; // no pressure reported
    let k = 0;
    while (k < 6 && s[k]!.p > settled * 1.4 + 0.05) k++;
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
