// Run: node src/inkw-model.check.ts — notebooks to a .inkw document and back (pictures and ids faked).
import assert from 'node:assert/strict';
import { readInkw, sha256, writeInkw } from './inkw.ts';
import { fromInkw, toInkw } from './inkw-model.ts';
import { SAMPLE_PNG, sampleStrokes } from './inkw-sample.ts';
import { cleanNotebooks } from './notebook-clean.ts';
import type { Notebook, Page } from './store.ts';

// --- fakes: a picture store and an id source ---
const store = new Map<string, { type: string; bytes: Uint8Array }>([
  ['pic-a', { type: 'image/png', bytes: SAMPLE_PNG }],
  ['pic-b', { type: 'image/jpeg', bytes: Uint8Array.from([255, 216, 255, 224, 1, 2, 3, 4]) }],
]);
const getBlob = async (id: string) => store.get(id) ?? null;
let counter = 0;
const newId = () => `new-${++counter}`;
const storePicture = async (b: { type: string; bytes: Uint8Array }) => {
  const id = `stored-${++counter}`;
  store.set(id, b);
  return id;
};
const hexOf = async (id: string | undefined) =>
  id && store.has(id) ? sha256(store.get(id)!.bytes) : id;

const page = (over: Partial<Page> = {}): Page => ({
  id: 'p-1',
  title: 'Page',
  strokes: [],
  texts: [],
  images: [],
  background: 'blank',
  pageColor: 'auto',
  ...over,
});
const shape = {
  id: 'sh1',
  kind: 'arrow' as const,
  cx: 0,
  cy: 0,
  w: 0,
  h: 0,
  angle: 0,
  x1: 10,
  y1: 10,
  x2: 200,
  y2: 90,
  color: '#e5484d',
  width: 3,
  opacity: 1,
  fill: 'none' as const,
  dash: 'dashed' as const,
  head: 1.6,
};
const text = {
  id: 't1',
  x: 5,
  y: 6,
  w: 200,
  text: 'x² ≥ 0 ✓',
  font: 'sans' as const,
  size: 18,
  color: '#1c1c1e',
  bold: true,
  italic: false,
  angle: 0.2,
};
const code = {
  id: 'c1',
  x: 1,
  y: 2,
  w: 300,
  lang: 'python',
  compiler: 'py312',
  code: 'print(1)',
  libs: [{ id: 'numpy', version: '1' }],
  output: '1',
  stdin: '',
};
const nbs = (): Notebook[] => [
  {
    id: 'nb-1',
    name: 'Maths',
    sections: [
      {
        id: 'sec-1',
        name: 'Algebra',
        color: '#3e63dd',
        pages: [
          page({
            id: 'p-ink',
            title: 'Ink',
            strokes: sampleStrokes('k', 5, 3),
            texts: [text],
            shapes: [shape],
            codes: [code],
          }),
          page({ id: 'p-md', title: 'Note', md: '# Hi\n\n- a\n', background: 'blank' }),
          page({
            id: 'p-paper',
            title: 'Sheet',
            paper: 'a4',
            landscape: true,
            background: 'cornell',
            pageColor: '#ffffff',
          }),
          page({
            id: 'p-pic',
            title: 'Pictures',
            background: 'picture',
            backdrop: 'pic-b',
            images: [
              { id: 'i1', blob: 'pic-a', cx: 10, cy: 10, w: 50, h: 50, angle: 0 },
              { id: 'i2', blob: 'pic-a', cx: 90, cy: 20, w: 20, h: 20, angle: 0.5 },
            ],
          }),
        ],
      },
      {
        id: 'sec-2',
        name: 'Sub',
        color: '#e5484d',
        parent: 'sec-1',
        collapsed: true,
        pages: [page({ id: 'p-sub', title: 'Sub page' })],
      },
    ],
  },
];

/** Everything about notebooks except ids; pictures compared by their bytes. */
async function canon(list: Notebook[]) {
  return JSON.parse(
    JSON.stringify(
      await Promise.all(
        list.map(async (n) => ({
          name: n.name,
          sections: await Promise.all(
            n.sections.map(async (s) => ({
              name: s.name,
              color: s.color,
              collapsed: s.collapsed ?? false,
              hasParent: !!s.parent,
              pages: await Promise.all(
                s.pages.map(async (p) => ({
                  ...p,
                  id: undefined,
                  texts: p.texts.map((t) => ({ ...t, id: undefined })),
                  shapes: p.shapes?.map((x) => ({ ...x, id: undefined })),
                  codes: p.codes?.map((c) => ({ ...c, id: undefined })),
                  images: await Promise.all(
                    p.images.map(async (i) => ({ ...i, id: undefined, blob: await hexOf(i.blob) })),
                  ),
                  backdrop: await hexOf(p.backdrop),
                })),
              ),
            })),
          ),
        })),
      ),
    ),
  );
}

// Saves and restores every kind of page; a picture used twice is one blob.
const original = nbs();
const doc = await toInkw(original, getBlob);
assert.equal(doc.blobs.size, 2, 'two distinct pictures, one used twice');
const file = await writeInkw(doc);
assert.equal(file.skipped, 0);
const restored = await fromInkw(await readInkw(file.bytes), newId, storePicture, new Set());
assert.deepEqual(restored.warnings, []);
assert.deepEqual(
  await canon(restored.notebooks),
  await canon(original),
  'round trip, apart from ids',
);
const flat = restored.notebooks[0]!.sections.flatMap((s) => s.pages);
assert.ok(
  new Set(flat.map((p) => p.id)).size === flat.length && flat.every((p) => !p.id.startsWith('p-')),
  'fresh page ids',
);
assert.equal(
  restored.notebooks[0]!.sections[1]!.parent,
  restored.notebooks[0]!.sections[0]!.id,
  'folder nesting kept',
);
assert.equal(flat[3]!.background, 'picture', 'a picture background keeps its picture');

// Damaged strokes are skipped and counted at write time; the rest of the notebook is safe.
const damaged = nbs();
damaged[0]!.sections[0]!.pages[0]!.strokes.push({
  ...sampleStrokes('x', 1, 1)[0]!,
  id: 'bad',
  points: [Number.NaN, 0, 0.5],
});
const w = await writeInkw(await toInkw(damaged, getBlob));
assert.equal(w.skipped, 1, 'one damaged stroke skipped');
const afterDamage = await fromInkw(await readInkw(w.bytes), newId, storePicture, new Set());
assert.equal(
  afterDamage.notebooks[0]!.sections[0]!.pages[0]!.strokes.length,
  5,
  'the other strokes survive',
);

// A picture the app cannot find is left out of the file with a warning; the page still saves.
const lost = nbs();
lost[0]!.sections[0]!.pages[3]!.images.push({
  id: 'i3',
  blob: 'gone',
  cx: 0,
  cy: 0,
  w: 1,
  h: 1,
  angle: 0,
});
const lostDoc = await toInkw(lost, getBlob);
assert.equal(lostDoc.warnings.length, 1);
assert.match(lostDoc.warnings[0]!, /Pictures/);
// A page that names a hash missing from the file opens without the picture and a warning.
const missing = await readInkw((await writeInkw(await toInkw(nbs(), getBlob))).bytes);
missing.blobs.clear();
const open = await fromInkw(missing, newId, storePicture, new Set());
assert.ok(
  open.warnings.some((x) => /missing from the file/.test(x)),
  'warns about the missing picture',
);
const picPage = open.notebooks[0]!.sections[0]!.pages[3]!;
assert.equal(picPage.images.length, 0, 'the picture is left out');
assert.equal(picPage.background, 'blank', 'a picture background without its picture is plain');

// Importing never collides: ids differ every time, names get " (restored)".
const again = await fromInkw(await readInkw(file.bytes), newId, storePicture, new Set(['Maths']));
assert.equal(again.notebooks[0]!.name, 'Maths (restored)');
const ids = (l: Notebook[]) =>
  l.flatMap((n) => [n.id, ...n.sections.flatMap((s) => [s.id, ...s.pages.map((p) => p.id)])]);
assert.equal(
  new Set([...ids(restored.notebooks), ...ids(again.notebooks)]).size,
  ids(restored.notebooks).length * 2,
  'no id is reused',
);

// Hostile page data is cleaned.
const hostile = cleanNotebooks(
  [
    {
      name: 'N'.repeat(10_000),
      sections: [
        {
          id: 's',
          name: 'S',
          color: 'javascript:1',
          pages: [
            {
              title: 'T'.repeat(10_000),
              background: '<script>',
              pageColor: 'red',
              paper: 'a0',
              strokes: [
                {
                  id: 'a',
                  tool: 'pen',
                  color: '#000000',
                  width: '2',
                  opacity: 1,
                  pressure: true,
                  points: ['1', '2', '3'],
                },
                7,
                null,
              ],
              texts: [
                {
                  id: 't',
                  x: 'a',
                  y: 0,
                  w: 1,
                  text: 'x',
                  font: 'sans',
                  size: 10,
                  color: '#000000',
                },
              ],
              images: [{ id: 'i', blob: 'nope', cx: 0, cy: 0, w: 1, h: 1, angle: 0 }],
            },
          ],
        },
      ],
    },
    'not a notebook',
    null,
  ],
  new Map(),
  newId,
);
assert.equal(hostile.length, 1);
assert.equal(hostile[0]!.name.length, 200, 'long names are cut');
const hp = hostile[0]!.sections[0]!.pages[0]!;
assert.equal(hp.title.length, 200);
assert.equal(hp.background, 'blank');
assert.equal(hp.pageColor, 'auto');
assert.equal(hp.paper, undefined);
assert.deepEqual(
  [hp.strokes.length, hp.texts.length, hp.images.length],
  [0, 0, 0],
  'bad strokes, texts and pictures dropped',
);
assert.equal(hostile[0]!.sections[0]!.color, '#3e63dd', 'a bad colour falls back');
console.log('inkw-model checks passed');
