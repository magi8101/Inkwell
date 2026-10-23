// Run: node src/excalidraw-format.check.ts — Excalidraw files import into the right Inkwell items,
// and what Inkwell exports comes back unchanged.
import assert from 'node:assert/strict';
import { fromExcalidraw, hexOf, toExcalidraw } from './excalidraw-format.ts';
import { byId, ends } from './shape-geom.ts';

let k = 0;
const uid = () => `i${++k}`;
const el = (o: Record<string, unknown>) => ({
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  isDeleted: false,
  locked: false,
  ...o,
});

const doc = {
  type: 'excalidraw',
  version: 2,
  elements: [
    el({
      id: 'r',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      backgroundColor: '#ffec99',
      fillStyle: 'solid',
      strokeColor: '#e03131',
      groupIds: ['g1'],
    }),
    el({
      id: 'e',
      type: 'ellipse',
      x: 500,
      y: 100,
      width: 120,
      height: 80,
      backgroundColor: '#a5d8ff',
      fillStyle: 'hachure',
      strokeStyle: 'dashed',
      groupIds: ['g1'],
      opacity: 60,
    }),
    el({
      id: 'd',
      type: 'diamond',
      x: 300,
      y: 300,
      width: 100,
      height: 100,
      angle: 0.5,
      locked: true,
    }),
    el({
      id: 'a',
      type: 'arrow',
      x: 300,
      y: 150,
      width: 200,
      height: 0,
      points: [
        [0, 0],
        [200, 0],
      ],
      startBinding: { elementId: 'r', focus: 0, gap: 4 },
      endBinding: { elementId: 'e', focus: 0, gap: 4 },
      endArrowhead: 'arrow',
      startArrowhead: null,
    }),
    el({
      id: 'l',
      type: 'line',
      x: 0,
      y: 500,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
      endArrowhead: null,
    }),
    el({
      id: 'poly',
      type: 'line',
      x: 0,
      y: 600,
      width: 100,
      height: 50,
      points: [
        [0, 0],
        [50, 50],
        [100, 0],
      ],
    }),
    el({
      id: 'f',
      type: 'freedraw',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      points: [
        [0, 0],
        [10, 10],
        [20, 20],
      ],
      pressures: [0.2, 0.6, 0.9],
      simulatePressure: false,
    }),
    el({
      id: 't',
      type: 'text',
      x: 120,
      y: 130,
      width: 150,
      height: 25,
      text: 'Hello\nworld',
      fontSize: 20,
      fontFamily: 3,
    }),
    el({ id: 'img', type: 'image', x: 700, y: 400, width: 64, height: 48, fileId: 'F1' }),
    el({ id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true }),
    el({ id: 'frame', type: 'frame', x: 0, y: 0, width: 999, height: 999 }),
  ],
  appState: { viewBackgroundColor: '#f8f9fa' },
  files: { F1: { dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', id: 'F1' } },
};

const got = fromExcalidraw(doc, uid);
const shape = (kind: string) => got.shapes.find((s) => s.kind === kind)!;
assert.equal(got.shapes.length, 5, 'rect, ellipse, diamond, arrow, line'); // polyline is ink, frame/deleted left out
assert.equal(
  got.skipped,
  1,
  'only the frame is reported as left out (a deleted element is just gone)',
);
assert.equal(got.background, '#f8f9fa');
// A box: centre, size, fill colour and group
const rect = shape('rect');
assert.deepEqual([rect.cx, rect.cy, rect.w, rect.h], [200, 150, 200, 100]);
assert.equal(rect.fill, 'solid');
assert.equal(rect.fillColor, '#ffec99');
assert.equal(rect.color, '#e03131');
const ell = shape('ellipse');
assert.equal(ell.fill, 'hatch');
assert.equal(ell.dash, 'dashed');
assert.equal(ell.opacity, 0.6);
assert.equal(rect.group, ell.group);
assert.ok(rect.group); // same group id
assert.equal(shape('diamond').locked, true);
assert.equal(shape('diamond').angle, 0.5);
// The arrow keeps its bindings to the converted shapes
const arrow = shape('arrow');
assert.equal(arrow.bindStart, rect.id);
assert.equal(arrow.bindEnd, ell.id);
assert.deepEqual([arrow.x1, arrow.y1, arrow.x2, arrow.y2], [300, 150, 500, 150]);
const e = ends(arrow, byId(got.shapes)); // worked out from the shapes: leaves the rect, meets the ellipse
assert.ok(Math.abs(e.a.x - 300) < 1 && Math.abs(e.b.x - 500) < 1);
// A plain line (no head) and a polyline (ink)
assert.equal(shape('line').kind, 'line');
assert.equal(got.strokes.length, 2);
const free = got.strokes.find((s) => s.points[0] === 10)!; // the freedraw one
assert.equal(free.pressure, true);
assert.deepEqual(free.points, [10, 10, 0.2, 20, 20, 0.6, 30, 30, 0.9]);
// Text and picture
assert.equal(got.texts[0]!.text, 'Hello\nworld');
assert.equal(got.texts[0]!.font, 'mono');
assert.equal(got.texts[0]!.size, 20);
assert.equal(got.images.length, 1);
assert.deepEqual([got.images[0]!.item.cx, got.images[0]!.item.cy], [732, 424]);
assert.equal(got.images[0]!.dataUrl, 'data:image/png;base64,AAAA');

// Not Excalidraw → a clear error
assert.throws(() => fromExcalidraw({ hello: 1 }, uid), /Not an Excalidraw file/);
assert.equal(hexOf('#abc', '#000000'), '#aabbcc');
assert.equal(hexOf('transparent', '#123456'), '#123456');

// Round trip: what we export, we import again with the same meaning.
const pictures = new Map([['blob1', { dataUrl: 'data:image/png;base64,BBBB', mime: 'image/png' }]]);
const out = toExcalidraw(
  {
    strokes: got.strokes,
    texts: got.texts,
    shapes: got.shapes,
    images: [{ ...got.images[0]!.item, blob: 'blob1' }],
    pictures,
    background: '#ffffff',
  },
  1700000000000,
  () => 0.5,
) as {
  type: string;
  elements: Record<string, unknown>[];
  files: Record<string, { dataURL: string }>;
  appState: { viewBackgroundColor: string };
};
assert.equal(out.type, 'excalidraw');
const types = out.elements.map((x) => x.type).sort();
assert.deepEqual(types, [
  'arrow',
  'diamond',
  'ellipse',
  'freedraw',
  'freedraw',
  'image',
  'line',
  'rectangle',
  'text',
]);
assert.equal(Object.values(out.files)[0]!.dataURL, 'data:image/png;base64,BBBB');
const exArrow = out.elements.find((x) => x.type === 'arrow')!;
assert.deepEqual((exArrow.startBinding as { elementId: string }).elementId, rect.id);
// The shapes the arrow is bound to list it back, as Excalidraw expects
assert.deepEqual(
  (out.elements.find((x) => x.id === rect.id)!.boundElements as { id: string }[]).map((b) => b.id),
  [arrow.id],
);
for (const x of out.elements)
  for (const key of [
    'id',
    'type',
    'x',
    'y',
    'width',
    'height',
    'angle',
    'strokeColor',
    'seed',
    'version',
    'versionNonce',
    'isDeleted',
    'updated',
  ])
    assert.ok(key in x, `${x.type} has ${key}`);

k = 100;
const back = fromExcalidraw(out, uid);
assert.equal(back.shapes.length, 5);
assert.equal(back.strokes.length, 2);
assert.equal(back.texts.length, 1);
assert.equal(back.images.length, 1);
const rect2 = back.shapes.find((s) => s.kind === 'rect')!;
assert.deepEqual(
  [rect2.cx, rect2.cy, rect2.w, rect2.h, rect2.fill, rect2.fillColor],
  [200, 150, 200, 100, 'solid', '#ffec99'],
);
const arrow2 = back.shapes.find((s) => s.kind === 'arrow')!;
assert.equal(arrow2.bindStart, rect2.id);
assert.equal(back.shapes.find((s) => s.kind === 'ellipse')!.fill, 'hatch');
assert.equal(back.shapes.find((s) => s.kind === 'diamond')!.locked, true);
const free2 = back.strokes.find((s) => s.points[2] === 0.2)!;
assert.equal(free2.pressure, true);
console.log('excalidraw-format checks passed');
