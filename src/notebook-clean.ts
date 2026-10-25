// Rebuilds notebooks from data that came from outside (a backup, a .inkw file): known fields only,
// each one checked, ids made fresh so nothing already in the app is overwritten. Pure, so
// inkw-model.check.ts can run it in Node.

import {
  BACKGROUNDS,
  cleanCodes,
  cleanMd,
  cleanShapes,
  cleanStroke,
  cleanText,
  hex,
  num,
  PAPERS,
} from './sanitize.ts';
import type { ImageItem, Notebook, Page, Section } from './store.ts';

const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const str = (v: unknown, max: number, fallback: string) =>
  typeof v === 'string' ? v.slice(0, max) : fallback;

/** One page from untrusted data. `pic` maps the picture ids the data uses to ids in this app. */
export function cleanPage(
  raw: unknown,
  pic: Map<string, string>,
  newId: () => string,
): Page | null {
  const x = raw as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return null;
  const images = arr(x.images).flatMap((im: ImageItem) =>
    im && [im.cx, im.cy, im.w, im.h, im.angle].every(num) && pic.has(im.blob)
      ? [
          {
            id: newId(),
            blob: pic.get(im.blob)!,
            cx: im.cx,
            cy: im.cy,
            w: im.w,
            h: im.h,
            angle: im.angle,
          },
        ]
      : [],
  );
  const backdrop = typeof x.backdrop === 'string' ? pic.get(x.backdrop) : undefined;
  const page: Page = {
    id: newId(),
    title: str(x.title, 200, 'Untitled page'),
    strokes: arr(x.strokes)
      .map(cleanStroke)
      .filter((s): s is NonNullable<typeof s> => !!s),
    texts: arr(x.texts)
      .map(cleanText)
      .filter((t): t is NonNullable<typeof t> => !!t),
    images,
    // A picture background needs its picture; without it the page is plain.
    background:
      x.background === 'picture' && backdrop
        ? 'picture'
        : BACKGROUNDS.includes(x.background as never)
          ? (x.background as Page['background'])
          : 'blank',
    pageColor: x.pageColor === 'auto' || hex(x.pageColor) ? (x.pageColor as string) : 'auto',
  };
  const md = cleanMd(x.md);
  if (md !== undefined) page.md = md;
  const codes = cleanCodes(x.codes);
  if (codes.length) page.codes = codes;
  const shapes = cleanShapes(x.shapes);
  if (shapes.length) page.shapes = shapes;
  if (typeof x.paper === 'string' && PAPERS.includes(x.paper))
    page.paper = x.paper as Page['paper'];
  if (x.landscape === true) page.landscape = true;
  if (backdrop) page.backdrop = backdrop;
  if (typeof x.inkText === 'string') page.inkText = x.inkText.slice(0, 50_000);
  return page;
}

/** Notebooks from untrusted data, with fresh ids throughout. */
export function cleanNotebooks(
  raw: unknown[],
  pic: Map<string, string>,
  newId: () => string,
): Notebook[] {
  const out: Notebook[] = [];
  for (const n of raw.slice(0, 200) as Record<string, unknown>[]) {
    if (!n || !Array.isArray(n.sections)) continue;
    const ids = new Map<string, string>();
    for (const s of n.sections as Record<string, unknown>[]) ids.set(String(s?.id), newId());
    const sections: Section[] = (n.sections as Record<string, unknown>[]).map((s) => ({
      id: ids.get(String(s.id))!,
      name: str(s.name, 200, 'Folder'),
      color: hex(s.color) ? (s.color as string) : '#3e63dd',
      pages: arr(s.pages)
        .map((p) => cleanPage(p, pic, newId))
        .filter((p): p is Page => !!p),
      ...(typeof s.parent === 'string' && ids.has(s.parent) ? { parent: ids.get(s.parent)! } : {}),
      ...(s.collapsed === true ? { collapsed: true } : {}),
    }));
    for (const s of sections) if (!s.pages.length) s.pages.push(cleanPage({}, pic, newId)!);
    if (!sections.length) continue;
    out.push({ id: newId(), name: str(n.name, 200, 'Notebook'), sections });
  }
  return out;
}
