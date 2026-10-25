// Run: node src/inkw.check.ts — the .inkw container (docs/inkw-spec.md), without the app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INKW_MIME, readInkw, writeInkw } from './inkw.ts';
import { plain, SAMPLE_PNG_HASH, sampleDocument } from './inkw-sample.ts';

const doc = () => sampleDocument(SAMPLE_PNG_HASH);
const text = (b: Uint8Array, from: number, to: number) =>
  new TextDecoder().decode(b.slice(from, to));

// The file is recognised by content: PK, then "mimetype" stored, then the media type at byte 38.
const { bytes, skipped } = await writeInkw(doc());
assert.equal(skipped, 0);
assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a zip');
assert.equal(text(bytes, 30, 38), 'mimetype', 'the first entry is mimetype');
assert.equal(text(bytes, 38, 38 + INKW_MIME.length), INKW_MIME, 'media type at byte 38');
assert.equal(bytes[8]! | (bytes[9]! << 8), 0, 'and it is stored, not compressed');

// A full document round-trips; a picture used on two pages is stored once.
const back = await readInkw(bytes);
assert.deepEqual(plain(back), plain(doc()), 'round trip');
const dir = mkdtempSync(join(tmpdir(), 'inkw-'));
writeFileSync(join(dir, 'a.inkw'), bytes);
const names = spawnSync('unzip', ['-Z1', join(dir, 'a.inkw')], { encoding: 'utf8' });
if (!names.error) {
  const list = names.stdout.split('\n').filter(Boolean);
  assert.equal(list[0], 'mimetype', 'mimetype is the first entry');
  assert.equal(list.filter((n) => n.startsWith('blobs/')).length, 1, 'one blob for two pages');
}

// Unknown keys and entries survive a read and a write.
const future = doc();
future.pages[0]!.json.future = { a: [1, 2, 3] };
future.extra = { audio: 'later' };
future.manifestRest = { signature: 'x' };
future.unknownEntries = {
  'future/x.bin': Uint8Array.from([1, 2, 3]),
  'thumbnails/p1.png': Uint8Array.from([9, 9]),
};
const again = await readInkw(
  (await writeInkw(await readInkw((await writeInkw(future)).bytes))).bytes,
);
assert.deepEqual(plain(again), plain(future), 'unknown keys and entries survive');

// Standard tools read it (skipped where `unzip` is missing).
const t = spawnSync('unzip', ['-t', join(dir, 'a.inkw')], { encoding: 'utf8' });
if (t.error) console.log('unzip not available: skipped');
else assert.equal(t.status, 0, `unzip -t: ${t.stdout}`);

// A blob stored under a hash that is not its hash is refused on write.
const lying = doc();
lying.blobs = new Map([[SAMPLE_PNG_HASH, { ext: 'png', bytes: Uint8Array.from([1, 2, 3]) }]]);
await assert.rejects(writeInkw(lying), /hash/);

// Golden files: files written by an earlier version still decode to the same data.
const golden = new URL('../docs/inkw-golden/', import.meta.url).pathname;
const files = existsSync(golden) ? readdirSync(golden).filter((f) => f.endsWith('.inkw')) : [];
assert.ok(files.length > 0, 'golden files exist: run node scripts/make-inkw-golden.ts');
for (const f of files) {
  const expected = JSON.parse(
    readFileSync(join(golden, f.replace(/\.inkw$/, '.expected.json')), 'utf8'),
  );
  const got = JSON.parse(
    JSON.stringify(plain(await readInkw(new Uint8Array(readFileSync(join(golden, f)))))),
  );
  assert.deepEqual(got, expected, `golden file ${f}`);
}
console.log('inkw checks passed');
