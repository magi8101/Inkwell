// Run: node src/backup.check.ts — a backup packs, locks, unlocks and unpacks to what went in.
import assert from 'node:assert/strict';
import { isLocked, lock, packBackup, unlock, unpackBackup } from './backup.ts';

const notebooks = [
  { id: 'n1', name: 'Maths', sections: [{ id: 's1', pages: [{ id: 'p1', strokes: [] }] }] },
];
const pic = { id: 'img-1', type: 'image/jpeg', bytes: new Uint8Array([255, 216, 255, 1, 2, 3]) };

const zip = packBackup(notebooks, [pic]);
assert.ok(!isLocked(zip), 'a plain backup is a zip');
const back = unpackBackup(zip);
assert.deepEqual(back.doc.notebooks, notebooks, 'notebooks round-trip');
assert.deepEqual(back.pictures, [pic], 'pictures round-trip with their type');

const locked = await lock(zip, 'correct horse');
assert.ok(isLocked(locked), 'a locked backup says so');
assert.ok(
  !Buffer.from(locked).includes('Maths'),
  'the notebook name is not readable in a locked file',
);
assert.deepEqual(unpackBackup(await unlock(locked, 'correct horse')).doc.notebooks, notebooks);
await assert.rejects(unlock(locked, 'wrong'), /Wrong password/);
const bent = locked.slice();
bent[bent.length - 1] = bent[bent.length - 1]! ^ 1;
await assert.rejects(unlock(bent, 'correct horse'), /Wrong password/, 'a changed byte is caught');

assert.throws(() => unpackBackup(new Uint8Array([1, 2, 3])), /Not an Inkwell backup/);
assert.throws(() => unpackBackup(packBackup([], []).slice(0, 10)), /Not an Inkwell backup/);
console.log('backup checks passed');
