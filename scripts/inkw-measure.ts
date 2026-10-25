// Run: node scripts/inkw-measure.ts — builds a large notebook (500 pages, about a million points,
// 20 pictures of 200 KB) from the pen simulator, writes and reads it as .inkw, and prints size and
// speed. The plan's bar: write and read each at most 5 s, at most 8 bytes per point overall
// (pictures excluded from that figure).
import { randomBytes } from 'node:crypto';
import { readInkw, sha256, writeInkw, type InkwData } from '../src/inkw.ts';
import { PROFILES, scriptPath, simulate } from '../src/pen-sim.ts';
import type { Stroke } from '../src/store.ts';

const pen = PROFILES.find((p) => p.name === 'surface pen')!;
const PAGES = Number(process.env.PAGES ?? 500);
const blobs: InkwData['blobs'] = new Map();
const hashes: string[] = [];
for (let i = 0; i < 20; i++) {
  const bytes = new Uint8Array(randomBytes(200_000));
  const hash = await sha256(bytes);
  blobs.set(hash, { ext: 'jpg', bytes });
  hashes.push(hash);
}
let points = 0;
const pages = Array.from({ length: PAGES }, (_, pi) => {
  const strokes: Stroke[] = Array.from({ length: Number(process.env.STROKES ?? 25) }, (_, si) => {
    const sim = simulate(pen, scriptPath(50, 80 + si * 20, 500), 800, 0.9, pi * 31 + si + 1);
    points += sim.raw.length;
    return {
      id: `s${pi}-${si}`,
      tool: 'pen',
      color: '#1c1c1e',
      width: 2.5,
      opacity: 1,
      pressure: true,
      points: sim.raw.flatMap((q) => [q.x, q.y, q.p]),
    };
  });
  const json = {
    title: `Page ${pi + 1}`,
    background: 'lines',
    pageColor: 'auto',
    texts: [],
    shapes: [],
    images: pi % 25 === 0 ? [{ id: `i${pi}`, blob: hashes[(pi / 25) % hashes.length]!, cx: 100, cy: 100, w: 200, h: 150, angle: 0 }] : [],
  };
  return { id: `p${pi}`, strokes, json };
});
const doc: InkwData = {
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  generator: 'measure',
  notebooks: [{ id: 'n1', json: { id: 'n1', name: 'Big', sections: [{ id: 's1', name: 'All', color: '#3e63dd', pages: pages.map((p) => p.id) }] } }],
  pages,
  blobs,
  extra: {},
  manifestRest: {},
  unknownEntries: {},
  warnings: [],
};
const pictureBytes = [...blobs.values()].reduce((n, b) => n + b.bytes.length, 0);

let t = performance.now();
const { bytes } = await writeInkw(doc);
const write = performance.now() - t;
t = performance.now();
const back = await readInkw(bytes);
const read = performance.now() - t;
if (back.pages.length !== PAGES) throw new Error('page count differs after reading');

const inkBytes = bytes.length - pictureBytes;
const perPoint = inkBytes / points;
console.log(`pages ${PAGES}, points ${points}, pictures ${(pictureBytes / 1e6).toFixed(1)} MB`);
console.log(`file ${(bytes.length / 1e6).toFixed(2)} MB; without pictures ${(inkBytes / 1e6).toFixed(2)} MB = ${perPoint.toFixed(2)} bytes per point`);
console.log(`write ${(write / 1000).toFixed(2)} s, read ${(read / 1000).toFixed(2)} s`);
const ok = write <= 5000 && read <= 5000 && perPoint <= 8;
console.log(ok ? 'within the bar' : 'OUTSIDE the bar: see docs/plans/ink-format.md (SQLite fallback)');
process.exit(ok ? 0 : 1);
