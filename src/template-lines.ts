import type { Background } from './store.ts';

// The ruling of the page templates, described once as line segments in sheet coordinates. The
// screen, thumbnails, PNGs and PDFs all draw from this, so they show exactly the same lines.
// (No imports of browser code here, so templates.check.ts can run in Node.)

export const TEMPLATES = ['cornell', 'staff', 'graph', 'picture'] as const;
export type Template = (typeof TEMPLATES)[number];
export const isTemplate = (b: Background): b is Template =>
  (TEMPLATES as readonly string[]).includes(b);

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** A main rule (header, margin, barline…) rather than a ruled line. */
  strong?: boolean;
}

/** The ruling of a sheet `w` × `h` world px. */
export function templateLines(t: Exclude<Template, 'picture'>, w: number, h: number): Seg[] {
  const out: Seg[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, strong = false) =>
    out.push({ x1, y1, x2, y2, strong });
  if (t === 'cornell') {
    // Cornell notes: a title band, a cue column on the left, the notes, and a summary at the foot.
    const top = 72;
    const cue = Math.round(w * 0.28);
    const foot = Math.round(h * 0.82);
    line(0, top, w, top, true);
    line(cue, top, cue, foot, true);
    line(0, foot, w, foot, true);
    for (let y = top + 32; y < foot - 8; y += 32) line(cue, y, w, y);
    for (let y = foot + 32; y < h - 16; y += 32) line(0, y, w, y);
  } else if (t === 'staff') {
    // Music paper: five-line staves 9 px apart, with barlines at both ends.
    const gap = 9;
    const left = 48;
    for (let y = 96; y + gap * 4 < h - 48; y += 112) {
      for (let i = 0; i < 5; i++) line(left, y + i * gap, w - left, y + i * gap, true);
      line(left, y, left, y + gap * 4, true);
      line(w - left, y, w - left, y + gap * 4, true);
    }
  } else {
    // Graph paper: a 16 px grid with every fifth line stronger.
    for (let i = 0, x = 0; x <= w; i++, x += 16) line(x, 0, x, h, i % 5 === 0);
    for (let i = 0, y = 0; y <= h; i++, y += 16) line(0, y, w, y, i % 5 === 0);
  }
  return out;
}
