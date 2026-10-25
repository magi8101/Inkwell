// A bounded ZIP reader for untrusted files (docs/inkw-spec.md, section 8). It reads the central
// directory itself, never trusts sizes declared in headers (inflates in small steps and stops at the
// limit), checks every entry's CRC-32, rejects unsafe or repeated names, and returns the entries as
// bytes. No ZIP64, no encryption: those are refused. Pure, no DOM.

import { Inflate } from 'fflate';
import { InkwError } from './inkw-codec.ts';

export interface InkwLimits {
  /** Most entries in the file. */
  entries: number;
  /** Most bytes one entry may decompress to. */
  entryBytes: number;
  /** Most bytes all entries together may decompress to. */
  totalBytes: number;
}
export const DEFAULT_LIMITS: InkwLimits = {
  entries: 100_000,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024 * 1024,
};

const bad = (why: string) => new InkwError('format', `Not an Inkwell file: ${why}`);

let table: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An entry name that could escape its folder or mean something else on some OS. */
export function badEntryName(name: string): boolean {
  return (
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('\0') ||
    name.split('/').some((p) => p === '..' || p === '.')
  );
}

/** Inflates `data` in small steps so one step can never expand far past the limit. */
function inflate(data: Uint8Array, cap: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inf = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) over = true;
    else chunks.push(chunk);
  });
  const STEP = 4096; // at most ~1000x expansion per step: about 4 MB
  try {
    for (let i = 0; i < data.length && !over; i += STEP)
      inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  } catch {
    throw bad('an entry is damaged');
  }
  if (over) throw new InkwError('limit', 'This file is too large to open');
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Every entry of a ZIP as bytes, within the limits. Throws InkwError for anything unsafe or damaged. */
export function readZip(
  bytes: Uint8Array,
  limits: InkwLimits = DEFAULT_LIMITS,
): Record<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is the last 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('not a zip');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new InkwError('unsupported', 'This file is too large for this version of Inkwell');
  if (count > limits.entries) throw new InkwError('limit', 'This file has too many parts to open');
  if (cdOffset + cdSize > eocd) throw bad('the directory is damaged');

  const out: Record<string, Uint8Array> = {};
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || v.getUint32(p, true) !== 0x02014b50)
      throw bad('the directory is damaged');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    if (p + 46 + nameLen > cdOffset + cdSize) throw bad('the directory is damaged');
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1)
      throw new InkwError('unsupported', 'This file is encrypted in a way Inkwell does not read');
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
      throw new InkwError('unsupported', 'This file is too large for this version of Inkwell');
    if (name.endsWith('/')) continue; // a folder entry: nothing to read
    if (badEntryName(name)) throw bad(`an unsafe name (${name.slice(0, 40)})`);
    if (seen.has(name)) throw bad(`a repeated name (${name.slice(0, 40)})`);
    seen.add(name);
    if (usize > limits.entryBytes || total + usize > limits.totalBytes)
      throw new InkwError('limit', 'This file is too large to open');
    // The local header must agree with the directory about the name, and the data must lie before it.
    if (local + 30 > cdOffset || v.getUint32(local, true) !== 0x04034b50)
      throw bad('a part is damaged');
    const lName = v.getUint16(local + 26, true);
    const lExtra = v.getUint16(local + 28, true);
    if (new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + lName)) !== name)
      throw bad('a part is damaged');
    const start = local + 30 + lName + lExtra;
    if (start + csize > cdOffset) throw bad('a part is damaged');
    const data = bytes.subarray(start, start + csize);
    let body: Uint8Array;
    if (method === 0) body = data;
    else if (method === 8)
      body = inflate(data, Math.min(limits.entryBytes, limits.totalBytes - total));
    else throw new InkwError('unsupported', 'This file uses a compression Inkwell does not read');
    if (body.length !== usize) throw bad('a part has the wrong size');
    if (crc32(body) !== crc) throw bad('a part is damaged');
    total += body.length;
    out[name] = body.slice();
  }
  return out;
}
