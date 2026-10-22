// Pen-tip prediction for browsers that don't provide getPredictedEvents() (typical on macOS and
// Linux, and in Safari/WebKit). Fits a straight-line velocity to the last few samples by least
// squares — which averages out sensor jitter — and extrapolates a few milliseconds ahead.

export interface Sample {
  x: number;
  y: number;
  /** Event timestamp, ms. */
  t: number;
}

const WINDOW_MS = 50; // only recent motion counts; older samples describe a different direction
const MIN_SAMPLES = 3;
const MIN_LEAD_PX = 0.5; // below this the pen is effectively still: predict nothing

/** Where the pen will be `aheadMs` from the last sample, at most `maxPx` away; null if unsure. */
export function predict(samples: readonly Sample[], aheadMs: number, maxPx: number): Sample | null {
  const last = samples[samples.length - 1];
  if (!last || aheadMs <= 0 || maxPx <= 0) return null;
  let n = 0;
  let mt = 0;
  let mx = 0;
  let my = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > WINDOW_MS) break;
    n++;
    mt += s.t;
    mx += s.x;
    my += s.y;
  }
  if (n < MIN_SAMPLES) return null;
  mt /= n;
  mx /= n;
  my /= n;
  let stt = 0;
  let stx = 0;
  let sty = 0;
  for (let i = samples.length - n; i < samples.length; i++) {
    const s = samples[i]!;
    const dt = s.t - mt;
    stt += dt * dt;
    stx += dt * (s.x - mx);
    sty += dt * (s.y - my);
  }
  if (stt === 0) return null; // all samples share a timestamp: no velocity information
  let dx = (stx / stt) * aheadMs;
  let dy = (sty / stt) * aheadMs;
  const lead = Math.hypot(dx, dy);
  if (lead < MIN_LEAD_PX) return null;
  if (lead > maxPx) {
    dx *= maxPx / lead;
    dy *= maxPx / lead;
  }
  return { x: last.x + dx, y: last.y + dy, t: last.t + aheadMs };
}
