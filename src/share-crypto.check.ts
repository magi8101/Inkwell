// Run: node src/share-crypto.check.ts — a share decrypts only with its own key, hides its content,
// and notices tampering.
import assert from 'node:assert/strict';
import { decryptShare, encryptShare } from './share-crypto.ts';

const page = {
  v: 1,
  title: 'Secret plan',
  page: { texts: [{ text: 'launch codes: SWORDFISH', x: 1 }], strokes: [] },
};
const { bytes, key } = await encryptShare(page);
assert.equal(bytes[0], 1);
assert.match(key, /^[A-Za-z0-9_-]{43}$/, 'a 256-bit key as base64url');
// The stored bytes reveal nothing readable, compressed or not.
const asText = new TextDecoder('latin1').decode(bytes);
assert.ok(!asText.includes('SWORDFISH') && !asText.includes('Secret plan'));
// The right key opens it.
assert.deepEqual(await decryptShare(bytes, key), page);
// Another share's key doesn't, and neither does a changed byte.
const other = await encryptShare(page);
await assert.rejects(decryptShare(bytes, other.key));
const tampered = bytes.slice();
tampered[40] = tampered[40]! ^ 1;
await assert.rejects(decryptShare(tampered, key));
await assert.rejects(decryptShare(bytes.slice(0, 20), key), /Not a share/);
await assert.rejects(decryptShare(bytes, 'not-a-key'));
// Two shares of the same page differ (fresh key and IV each time) and a big page still round-trips.
assert.notDeepEqual(bytes, other.bytes);
const big = {
  rows: Array.from({ length: 20000 }, (_, i) => ({ i, t: `row ${i} of handwriting` })),
};
const e = await encryptShare(big);
assert.ok(e.bytes.length < JSON.stringify(big).length / 3, 'compressed before encrypting');
assert.deepEqual(await decryptShare(e.bytes, e.key), big);
console.log('share-crypto checks passed');
