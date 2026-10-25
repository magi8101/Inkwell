// A fixed sample document for checks and golden files, and a plain-JSON view of a document so two
// documents can be compared (blob and unknown-entry bytes as base64). Pure, no DOM.

import type { InkwData } from './inkw.ts';
import { PROFILES, scriptPath, simulate } from './pen-sim.ts';
import type { Stroke } from './store.ts';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** Strokes from the pen simulator (seeded, so the same every run). */
export function sampleStrokes(prefix: string, count: number, seed: number): Stroke[] {
  const pen = PROFILES.find((p) => p.name === 'apple pencil')!;
  return Array.from({ length: count }, (_, i) => {
    const sim = simulate(pen, scriptPath(50, 80 + i * 30, 300), 450, 1.1, seed + i);
    return {
      id: `${prefix}-${i}`,
      tool: i % 4 === 3 ? 'highlighter' : 'pen',
      color: i % 4 === 3 ? '#ffd60a' : '#1c1c1e',
      width: i % 4 === 3 ? 14 : 2.5,
      opacity: i % 4 === 3 ? 90 / 255 : 1, // a value the codec stores exactly
      pressure: i % 4 !== 3,
      points: sim.raw.flatMap((q) => [
        Math.round(q.x * 64) / 64,
        Math.round(q.y * 64) / 64,
        Math.round(q.p * 255) / 255,
      ]),
    };
  });
}

/** Bytes of a tiny PNG, and its SHA-256 as the blob key. */
export const SAMPLE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
export const SAMPLE_PNG_HASH = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';

export function sampleDocument(blobHash: string): InkwData {
  return {
    created: '2026-10-25T12:00:00.000Z',
    modified: '2026-10-25T12:30:00.000Z',
    generator: 'Inkwell sample',
    notebooks: [
      {
        id: 'n1',
        json: {
          id: 'n1',
          name: 'Maths ✏️',
          sections: [{ id: 's1', name: 'Algebra', color: '#3e63dd', pages: ['p1', 'p2'] }],
        },
      },
      {
        id: 'n2',
        json: {
          id: 'n2',
          name: 'Notes',
          sections: [{ id: 's2', name: 'Inbox', color: '#e5484d', pages: ['p3'] }],
        },
      },
    ],
    pages: [
      {
        id: 'p1',
        strokes: sampleStrokes('p1', 6, 10),
        json: {
          title: 'Quadratics',
          background: 'grid',
          pageColor: 'auto',
          texts: [
            {
              id: 't1',
              x: 10,
              y: 10,
              w: 200,
              text: 'x² + 1',
              font: 'sans',
              size: 18,
              color: '#1c1c1e',
              bold: false,
              italic: false,
            },
          ],
          shapes: [],
          images: [{ id: 'i1', blob: blobHash, cx: 100, cy: 100, w: 50, h: 50, angle: 0 }],
        },
      },
      {
        id: 'p2',
        strokes: sampleStrokes('p2', 3, 40),
        json: {
          title: 'A4 sheet',
          background: 'lines',
          pageColor: '#ffffff',
          paper: 'a4',
          texts: [],
          shapes: [],
          images: [{ id: 'i2', blob: blobHash, cx: 5, cy: 5, w: 10, h: 10, angle: 0.5 }],
        },
      },
      {
        id: 'p3',
        strokes: [],
        json: {
          title: 'A note',
          background: 'blank',
          pageColor: 'auto',
          md: '# Hello\n\n- one\n- two\n',
          texts: [],
          shapes: [],
          images: [],
        },
      },
    ],
    blobs: new Map([[blobHash, { ext: 'png', bytes: SAMPLE_PNG }]]),
    extra: {},
    manifestRest: {},
    unknownEntries: {},
    warnings: [],
  };
}

/** A plain-JSON view for comparing and for golden `.expected.json` files. */
export function plain(d: InkwData) {
  return {
    created: d.created,
    modified: d.modified,
    generator: d.generator,
    notebooks: d.notebooks,
    pages: d.pages,
    blobs: Object.fromEntries(
      [...d.blobs].map(([k, v]) => [k, { ext: v.ext, bytes: b64(v.bytes) }]),
    ),
    extra: d.extra,
    manifestRest: d.manifestRest,
    unknownEntries: Object.fromEntries(
      Object.entries(d.unknownEntries).map(([k, v]) => [k, b64(v)]),
    ),
    warnings: d.warnings,
  };
}
