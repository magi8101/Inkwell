// Run: node src/inkw.check.ts — the .inkw container (docs/inkw-spec.md), without the app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, zipSync } from 'fflate';
import { packBackup } from './backup.ts';
import {
  INKW_MIME,
  InkwError,
  isInkwLocked,
  readInkw,
  readInkwLocked,
  writeInkw,
  writeInkwLocked,
} from './inkw.ts';
import { plain, SAMPLE_PNG_HASH, sampleDocument } from './inkw-sample.ts';
import { crc32 } from './inkw-zip.ts';

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

// --- Hostile and odd files (docs/inkw-spec.md, section 8) ---

interface RawEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Sizes written in the headers, when they should lie about the real ones. */
  declared?: { csize?: number; usize?: number };
  badCrc?: boolean;
}
/** A zip built by hand, so it can repeat names, use unsafe names and forge declared sizes. */
function rawZip(entries: RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateSync(e.data) : e.data;
    const crc = (crc32(e.data) ^ (e.badCrc ? 1 : 0)) >>> 0;
    const cs = e.declared?.csize ?? body.length;
    const us = e.declared?.usize ?? e.data.length;
    const local = Uint8Array.from([
      0x50,
      0x4b,
      3,
      4,
      20,
      0,
      0,
      0,
      ...u16(method),
      0,
      0,
      0x21,
      0,
      ...u32(crc),
      ...u32(cs),
      ...u32(us),
      ...u16(name.length),
      0,
      0,
      ...name,
    ]);
    central.push(
      Uint8Array.from([
        0x50,
        0x4b,
        1,
        2,
        20,
        0,
        20,
        0,
        0,
        0,
        ...u16(method),
        0,
        0,
        0x21,
        0,
        ...u32(crc),
        ...u32(cs),
        ...u32(us),
        ...u16(name.length),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...u32(offset),
        ...name,
      ]),
    );
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Uint8Array.from([
    0x50,
    0x4b,
    5,
    6,
    0,
    0,
    0,
    0,
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(offset),
    0,
    0,
  ]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of all) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
const T = (s: string) => new TextEncoder().encode(s);
const head = (version: object, extra: object = {}) => [
  { name: 'mimetype', data: T(INKW_MIME) },
  {
    name: 'inkw.json',
    data: T(
      JSON.stringify({
        format: 'inkw',
        version,
        created: '',
        modified: '',
        generator: '',
        notebooks: [],
        locked: false,
        extra: {},
        ...extra,
      }),
    ),
  },
];
const code = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    assert.ok(e instanceof InkwError, `expected InkwError, got ${e}`);
    return e.code;
  }
  return 'none';
};

// rawZip itself builds a readable file (so the failures below are about the hostility, not the helper).
assert.equal(
  await code(() => readInkw(rawZip(head({ major: 1, minor: 0 })))),
  'none',
  'the helper builds valid files',
);

// Unsafe names are refused, even on unknown entries.
for (const name of ['../x', '/etc/x', 'a\\..\\b', 'C:\\x', 'a/../b', './a'])
  assert.equal(
    await code(() => readInkw(rawZip([...head({ major: 1, minor: 0 }), { name, data: T('x') }]))),
    'format',
    `name ${name}`,
  );
// A repeated name is refused.
assert.equal(
  await code(() =>
    readInkw(
      rawZip([
        ...head({ major: 1, minor: 0 }),
        { name: 'a.bin', data: T('1') },
        { name: 'a.bin', data: T('2') },
      ]),
    ),
  ),
  'format',
  'duplicate entries',
);

// A zip bomb is stopped by the limit, quickly: 5 MB of zeros deflates to a few KB.
const bomb = new Uint8Array(5_000_000);
const t0 = Date.now();
assert.equal(
  await code(() =>
    readInkw(
      rawZip([
        ...head({ major: 1, minor: 0 }),
        { name: 'x.bin', data: bomb, method: 8, declared: { usize: 100 } },
      ]),
      { entryBytes: 1_000_000 },
    ),
  ),
  'limit',
  'forged small sizes cannot bypass the entry limit',
);
assert.ok(Date.now() - t0 < 2000, 'and it is quick');
assert.equal(
  await code(() =>
    readInkw(rawZip([...head({ major: 1, minor: 0 }), { name: 'x.bin', data: bomb, method: 8 }]), {
      entryBytes: 1_000_000,
    }),
  ),
  'limit',
  'an honest oversized entry is refused by its declared size',
);
assert.equal(
  await code(() =>
    readInkw(
      rawZip([
        ...head({ major: 1, minor: 0 }),
        { name: 'x.bin', data: new Uint8Array(500).fill(7), method: 8, declared: { usize: 100 } },
      ]),
    ),
  ),
  'format',
  'a declared size that is not the real size is refused',
);
assert.equal(
  await code(() =>
    readInkw(
      rawZip([
        ...head({ major: 1, minor: 0 }),
        { name: 'a', data: bomb.slice(0, 600_000), method: 8 },
        { name: 'b', data: bomb.slice(0, 600_000), method: 8 },
      ]),
      { totalBytes: 1_000_000 },
    ),
  ),
  'limit',
  'the total across entries is limited too',
);
assert.equal(
  await code(() =>
    readInkw(
      rawZip([
        ...head({ major: 1, minor: 0 }),
        { name: 'a', data: T('1') },
        { name: 'b', data: T('2') },
        { name: 'c', data: T('3') },
      ]),
      { entries: 3 },
    ),
  ),
  'limit',
  'too many entries',
);
// A damaged entry fails its CRC.
assert.equal(
  await code(() =>
    readInkw(
      rawZip([...head({ major: 1, minor: 0 }), { name: 'a.bin', data: T('hello'), badCrc: true }]),
    ),
  ),
  'format',
  'CRC mismatch',
);
// Truncated and not-a-zip inputs.
assert.equal(
  await code(() => readInkw(bytes.slice(0, bytes.length - 30))),
  'format',
  'truncated directory',
);
assert.equal(await code(() => readInkw(bytes.slice(0, 100))), 'format', 'cut short');

// Versions: a newer major is refused; a newer minor opens and keeps what it does not know.
const v2 = await code(() => readInkw(rawZip(head({ major: 2, minor: 0 }))));
assert.equal(v2, 'version', 'major 2 refused');
try {
  await readInkw(rawZip(head({ major: 2, minor: 0 })));
} catch (e) {
  assert.match((e as Error).message, /newer version of Inkwell/);
}
const v19 = await readInkw(rawZip(head({ major: 1, minor: 9 }, { audio: { track: 'a.ogg' } })));
assert.deepEqual(
  v19.manifestRest,
  { audio: { track: 'a.ogg' } },
  'a newer minor opens, unknown keys kept',
);

// Things that are not .inkw files give one clear message.
const plainZip = zipSync({ 'a.txt': T('hello') });
const oldBackup = packBackup([{ id: 'n' }], []);
for (const [what, b] of [
  ['plain zip', plainZip],
  ['inkbackup', oldBackup],
  ['random', Uint8Array.from({ length: 12 }, (_, i) => i * 37 + 5)],
  ['empty', new Uint8Array(0)],
] as const) {
  assert.equal(await code(() => readInkw(b)), 'format', what);
  try {
    await readInkw(b);
  } catch (e) {
    assert.match((e as Error).message, /Not an Inkwell file/, what);
  }
}

// Locking.
const locked = (await writeInkwLocked(doc(), 'sesame')).bytes;
assert.ok(isInkwLocked(locked) && !isInkwLocked(bytes), 'locked files say so');
assert.deepEqual([...locked.slice(0, 8)], [...T('INKWLK1\0')], 'its own magic');
assert.ok(!Buffer.from(locked).includes('Maths'), 'no readable notebook name in a locked file');
assert.deepEqual(
  plain(await readInkwLocked(locked, 'sesame')),
  plain(doc()),
  'opens with the password',
);
assert.equal(await code(() => readInkwLocked(locked, 'wrong')), 'password', 'wrong password');
const bent = locked.slice();
bent[bent.length - 1] = bent[bent.length - 1]! ^ 1;
assert.equal(await code(() => readInkwLocked(bent, 'sesame')), 'password', 'a changed byte');
assert.equal(
  await code(() => readInkw(locked)),
  'password',
  'reading a locked file without a password says so',
);
assert.equal(
  await code(() => readInkwLocked(bytes, 'x')),
  'format',
  'unlocking an unlocked file is not a password problem',
);
console.log('inkw checks passed');
