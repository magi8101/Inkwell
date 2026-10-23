import type { Stroke } from './store.ts';
import { bbox } from './stroke.ts';

// Helpers for reading a whole page of handwriting (ink-index.ts). Pure, so they can run in Node.

/** A short fingerprint of the page's ink: changes whenever strokes are added, removed or cut. */
export function inkSignature(strokes: Stroke[]): string {
  let h = 5381;
  let n = 0;
  for (const s of strokes) {
    if (s.tool !== 'pen') continue;
    n++;
    for (let i = 0; i < s.id.length; i++) h = (Math.imul(h, 33) ^ s.id.charCodeAt(i)) >>> 0;
  }
  return `${n}:${h.toString(36)}`;
}

/**
 * Splits pen strokes into horizontal bands about `maxHeight` tall (a few lines of writing each),
 * top to bottom, so each band can be read as one block of text.
 */
export function bandStrokes(strokes: Stroke[], maxHeight = 240): Stroke[][] {
  const items = strokes
    .filter((s) => s.tool === 'pen')
    .map((s) => ({ s, b: bbox(s) }))
    .sort((a, b) => (a.b[1]! + a.b[3]!) / 2 - (b.b[1]! + b.b[3]!) / 2);
  const bands: Stroke[][] = [];
  let band: Stroke[] = [];
  let top = 0;
  for (const { s, b } of items) {
    const mid = (b[1]! + b[3]!) / 2;
    if (!band.length) top = mid;
    else if (mid - top > maxHeight) {
      bands.push(band);
      band = [];
      top = mid;
    }
    band.push(s);
  }
  if (band.length) bands.push(band);
  return bands;
}

// --- Forgiving search in handwriting that was read as text ---

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Edit distance between a and b, giving up (returning limit + 1) once it must exceed `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]!);
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Whether the handwriting `text` (as read by OCR, so it has mistakes and odd spaces) contains
 * `query`: spaces and punctuation are ignored, and a longer word may have a letter or two wrong
 * (one for 4–6 letters, two from 7). Words of 1–3 letters must match exactly.
 */
export function fuzzyIncludes(text: string, query: string): boolean {
  const q = squash(query);
  if (!q) return false;
  const t = squash(text);
  if (t.includes(q)) return true;
  const budget = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
  if (!budget) return false;
  for (let i = 0; i < t.length; i++) {
    for (let len = q.length - budget; len <= q.length + budget && i + len <= t.length; len++) {
      if (distance(t.slice(i, i + len), q, budget) <= budget) return true;
    }
  }
  return false;
}
