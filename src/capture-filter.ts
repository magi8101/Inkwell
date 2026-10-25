// The smoothing applied to each pen sample as it is captured (ink.ts uses it live; calibration and
// the pen-simulator checks replay recorded strokes through the same functions, so what they score
// is what the app does). Pure, no DOM.

export interface Raw {
  x: number;
  y: number;
  /** Event timestamp, ms. */
  t: number;
}

export interface FilterParams {
  /** 0..1: how far each point moves toward the raw pen position (1 = raw). */
  smoothing: number;
  /** Smoothing backs off by this much per px/ms of pen speed (0 = same at every speed). */
  speedGain: number;
}

/** Pen speed in px/ms over the last few raw samples ending at index `end` (0 when unknown). */
export function speedAt(raw: readonly Raw[], end = raw.length - 1): number {
  const last = raw[end];
  const first = raw[Math.max(0, end - 3)];
  if (!last || !first || last.t <= first.t) return 0;
  return Math.hypot(last.x - first.x, last.y - first.y) / (last.t - first.t);
}

/** How far toward the raw position one captured point moves. */
export const follow = (p: FilterParams, speed: number) =>
  Math.min(1, p.smoothing + p.speedGain * speed);

/** Smaller moves than this are dropped (ink.ts: the point would not show). */
const MIN_MOVE = 0.2;

/** Replays raw samples through the capture filter; one output per kept sample, with its index. */
export function smoothRun(
  raw: readonly Raw[],
  p: FilterParams,
): { x: number; y: number; i: number }[] {
  const out: { x: number; y: number; i: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ x: r.x, y: r.y, i });
      continue;
    }
    const k = follow(p, speedAt(raw, i));
    const x = prev.x + (r.x - prev.x) * k;
    const y = prev.y + (r.y - prev.y) * k;
    if (Math.hypot(x - prev.x, y - prev.y) < MIN_MOVE) continue;
    out.push({ x, y, i });
  }
  return out;
}
