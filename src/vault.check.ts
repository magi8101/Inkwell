// Run: node src/vault.check.ts — the notebook ↔ folder sync against an in-memory folder.
import assert from 'node:assert/strict';
import type { Notebook, Page, Section } from './store.ts';
import { applyDisk, type Backend, readDisk, safe, syncOut, type Written } from './vault-core.ts';

const files = new Map<string, Blob | string>();
const disk: Backend = {
  list: async () => [...files.keys()].sort(),
  read: async (p) => {
    const f = files.get(p);
    if (f === undefined || p.endsWith('/')) throw new Error(`no ${p}`);
    return typeof f === 'string' ? new Blob([f]) : f;
  },
  write: async (p, d) => {
    // Like a real folder: writing a file makes its directories.
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) files.set(`${parts.slice(0, i).join('/')}/`, '');
    files.set(p, d);
  },
  mkdir: async (p) => void files.set(p, ''),
  remove: async (p) => {
    if (p.endsWith('/') && [...files.keys()].some((k) => k !== p && k.startsWith(p))) return;
    files.delete(p);
  },
};

const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
  id,
  title,
  strokes: [],
  texts: [],
  images: [],
  background: 'blank',
  pageColor: 'auto',
  ...extra,
});
const folder = (id: string, name: string, pages: Page[], parent?: string): Section => ({
  id,
  name,
  color: '#3e63dd',
  pages,
  ...(parent ? { parent } : {}),
});
const blobs = new Map<string, Blob>([['img1', new Blob(['png'], { type: 'image/png' })]]);
const readBlob = async (id: string) => blobs.get(id);
const types = new Map<string, string>();

const nb: Notebook = {
  id: 'n',
  name: 'Vault',
  sections: [
    folder('a', 'School', [
      page('p1', 'Maths'),
      page('p2', 'Maths'), // same title → "Maths (2)"
    ]),
    folder(
      'b',
      'Unit 4: Waves',
      [
        page('p3', 'Notes', {
          images: [{ id: 'i', blob: 'img1', cx: 0, cy: 0, w: 1, h: 1, angle: 0 }],
        }),
      ],
      'a',
    ),
    folder('c', 'attachments', [page('p4', 'x')]), // must not collide with the pictures directory
  ],
};
const written: Written = {};
await syncOut(nb, disk, written, readBlob, types);
const keys = () => [...files.keys()].sort();
assert.deepEqual(keys(), [
  'School/',
  'School/Maths (2).inkwell',
  'School/Maths.inkwell',
  'School/Unit 4- Waves/',
  'School/Unit 4- Waves/Notes.inkwell',
  'attachments (2)/',
  'attachments (2)/x.inkwell',
  'attachments/',
  'attachments/img1.png',
]);
assert.equal(safe(' .. '), 'Untitled');

// Unchanged notebook → nothing rewritten.
const before = files.get('School/Maths.inkwell');
await syncOut(nb, disk, written, readBlob, types);
assert.equal(files.get('School/Maths.inkwell'), before);

// Renaming a page in the app moves its file; deleting a folder removes its files and directory.
nb.sections[0]!.pages[0]!.title = 'Algebra';
nb.sections.splice(2, 1);
await syncOut(nb, disk, written, readBlob, types);
assert.ok(files.has('School/Algebra.inkwell') && !files.has('School/Maths (2).inkwell'));
// The other "Maths" page no longer clashes, so it takes the plain name.
assert.equal(JSON.parse(files.get('School/Maths.inkwell') as string).id, 'p2');
assert.ok(!files.has('attachments (2)/x.inkwell') && !files.has('attachments (2)/'));
// …but a directory holding someone else's file is left alone.
files.set('School/Unit 4- Waves/readme.txt', 'mine');
nb.sections.splice(1, 1);
await syncOut(nb, disk, written, readBlob, types);
assert.ok(
  files.has('School/Unit 4- Waves/readme.txt') && !files.has('School/Unit 4- Waves/Notes.inkwell'),
);
files.delete('School/Unit 4- Waves/readme.txt');
files.delete('School/Unit 4- Waves/');

const newFolder = (name: string, parent?: string) => folder(`f-${name}`, name, [], parent);
const fromDisk = async () => {
  const plan = await readDisk(
    disk,
    written,
    async (id) => blobs.has(id),
    async (id, b) => void blobs.set(id, b),
  );
  applyDisk(nb, plan, written, newFolder);
};

// Nothing changed on disk → nothing changes in the app.
const snapshot = JSON.stringify(nb);
await fromDisk();
assert.equal(JSON.stringify(nb), snapshot);

// Edited elsewhere (say OneDrive from another device) → the page updates in the app.
const edited = JSON.parse(files.get('School/Algebra.inkwell') as string);
edited.strokes = [
  { id: 's', tool: 'pen', color: '#000', width: 2, opacity: 1, points: [[0, 0, 0.5]] },
];
files.set('School/Algebra.inkwell', JSON.stringify(edited));
await fromDisk();
assert.equal(nb.sections[0]!.pages.find((p) => p.id === 'p1')!.strokes.length, 1);

// Renamed and moved into a new directory on disk → same page, new title and folder (not deleted).
files.set('Home/Errands.inkwell', files.get('School/Algebra.inkwell')!);
files.set('Home/', '');
files.delete('School/Algebra.inkwell');
await fromDisk();
const moved = nb.sections.find((s) => s.name === 'Home')!;
assert.equal(moved.pages[0]!.id, 'p1');
assert.equal(moved.pages[0]!.title, 'Errands');
assert.ok(!nb.sections[0]!.pages.some((p) => p.id === 'p1'));

// Deleted on disk → gone from the app; a new file → a new page.
files.delete('School/Maths.inkwell');
files.set('School/Idea.inkwell', JSON.stringify({ inkwell: 1, id: 'p9', title: 'x', strokes: [] }));
await fromDisk();
const school = nb.sections.find((s) => s.name === 'School')!;
assert.deepEqual(
  school.pages.map((p) => p.title),
  ['Idea'],
);
assert.deepEqual(school.pages[0]!.texts, []); // missing fields are filled in

// Files that aren't pages or notes are ignored, never imported or deleted.
files.set('School/todo.txt', 'milk');
await fromDisk();
await syncOut(nb, disk, written, readBlob, types);
assert.equal(files.get('School/todo.txt'), 'milk');

// A .md file (an Obsidian note) opens as a Markdown note and is left exactly as it was.
files.set('School/notes.md', '# hi\n\n- [ ] a\n');
await fromDisk();
const note = nb.sections.find((s) => s.name === 'School')!.pages.find((p) => p.title === 'notes')!;
assert.equal(note.md, '# hi\n\n- [ ] a\n');
await syncOut(nb, disk, written, readBlob, types);
assert.equal(files.get('School/notes.md'), '# hi\n\n- [ ] a\n');
assert.ok(!files.has('School/notes.inkwell'));

// Edited in the app → the .md file gets the new Markdown; edited on disk → the note follows.
note.md = '# hi\n\n- [x] a\n';
await syncOut(nb, disk, written, readBlob, types);
assert.equal(files.get('School/notes.md'), '# hi\n\n- [x] a\n');
files.set('School/notes.md', '# hi again\n');
await fromDisk();
const again = nb.sections.find((s) => s.name === 'School')!.pages.find((p) => p.title === 'notes')!;
assert.equal(again.id, note.id); // same note, updated in place
assert.equal(again.md, '# hi again\n');

// A Markdown note made in the app is saved as plain Markdown, not as an .inkwell file.
nb.sections.find((s) => s.name === 'School')!.pages.push(page('m1', 'Plan', { md: '# Plan\n' }));
await syncOut(nb, disk, written, readBlob, types);
assert.equal(files.get('School/Plan.md'), '# Plan\n');
console.log('vault checks passed');
