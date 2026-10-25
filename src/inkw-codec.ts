// The .inkw stroke codec (docs/inkw-spec.md, section 6): a page's strokes as compact bytes. Points
// are stored as second-order deltas of 1/64 px positions and first-order deltas of 0..255 pressure,
// as zigzag varints, so smooth ink costs a few bytes a point. Pure, no DOM.

import type { Stroke } from './store.ts';

export type InkwErrorCode = 'format' | 'version' | 'limit' | 'password' | 'unsupported';

/** Every way reading or writing a .inkw file can fail on purpose; anything else is a bug. */
export class InkwError extends Error {
  readonly code: InkwErrorCode;
  constructor(code: InkwErrorCode, message: string) {
    super(message);
    this.name = 'InkwError';
    this.code = code;
  }
}

const MAGIC = [0x49, 0x4e, 0x4b, 0x53]; // "INKS"
const VERSION = 1;
const TOOLS = ['pen', 'highlighter'] as const;
const HEX = /^#[0-9a-f]{6}$/i;
const SAFE_ID = /[^A-Za-z0-9_-]/g;
/** Coordinates beyond this (px) cannot be second-order-delta encoded in 32 bits; the stroke is damaged. */
const MAX_COORD = 4_000_000;
/** The most a reader will allocate for one stroke's points before it has seen them. */
const MAX_POINTS = 50_000_000;

const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;
const unzigzag = (n: number) => (n >>> 1) ^ -(n & 1);

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.len++] = v;
  }
  varint(v: number) {
    this.room(5);
    let n = v >>> 0;
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.len++] = n;
  }
  bytes(b: ArrayLike<number>) {
    this.room(b.length);
    for (let i = 0; i < b.length; i++) this.buf[this.len++] = b[i]!;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** A bounds-checked reader: every overrun is an InkwError, so truncation can never go unnoticed. */
class Reader {
  pos = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  get left() {
    return this.b.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.b.length)
      throw new InkwError('format', 'Not an Inkwell file: strokes end early');
    return this.b[this.pos++]!;
  }
  varint(): number {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const x = this.u8();
      v += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) {
        if (v > 0xffffffff)
          throw new InkwError('format', 'Not an Inkwell file: a number is too large');
        return v;
      }
    }
    throw new InkwError('format', 'Not an Inkwell file: a number is too long');
  }
  take(n: number): Uint8Array {
    if (n > this.left) throw new InkwError('format', 'Not an Inkwell file: strokes end early');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

const finite = (v: number) => Number.isFinite(v);

/** Bytes to text; invalid UTF-8 is a damaged file, not a crash. */
function utf8(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new InkwError('format', 'Not an Inkwell file: a name is damaged');
  }
}

/** One stroke as bytes, or null when its data is damaged (a writer leaves such a stroke out). */
function encodeOne(s: Stroke, id: string): Uint8Array | null {
  const n = s.points.length / 3;
  const tool = TOOLS.indexOf(s.tool as (typeof TOOLS)[number]);
  if (tool < 0 || !HEX.test(s.color) || !Number.isInteger(n)) return null;
  if (!finite(s.width) || !finite(s.opacity)) return null;
  for (let i = 0; i < s.points.length; i += 3) {
    const x = s.points[i]!;
    const y = s.points[i + 1]!;
    if (!finite(x) || !finite(y) || !finite(s.points[i + 2]!)) return null;
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  }
  const w = new Writer();
  const idBytes = new TextEncoder().encode(id);
  w.varint(idBytes.length);
  w.bytes(idBytes);
  w.u8(tool);
  w.u8(s.pressure ? 1 : 0);
  w.u8(Number.parseInt(s.color.slice(1, 3), 16));
  w.u8(Number.parseInt(s.color.slice(3, 5), 16));
  w.u8(Number.parseInt(s.color.slice(5, 7), 16));
  w.varint(Math.min(65535, Math.max(0, Math.round(s.width * 16))));
  w.u8(Math.min(255, Math.max(0, Math.round(s.opacity * 255))));
  w.u8(1); // channels: pressure
  w.varint(n);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let p1 = 0;
  for (let i = 0; i < s.points.length; i += 3) {
    const x = Math.round(s.points[i]! * 64);
    const y = Math.round(s.points[i + 1]! * 64);
    const p = Math.min(255, Math.max(0, Math.round(s.points[i + 2]! * 255)));
    w.varint(zigzag(x - 2 * x1 + x2));
    w.varint(zigzag(y - 2 * y1 + y2));
    w.varint(zigzag(p - p1));
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    p1 = p;
  }
  return w.finish();
}

/** An id that fits the spec (1-64 of A-Z a-z 0-9 _ -), unique among the ids already used. */
function safeId(id: string, used: Set<string>): string {
  const base = id.replace(SAFE_ID, '_').slice(0, 56) || 's';
  let out = base;
  for (let k = 1; used.has(out); k++) out = `${base}-${k}`;
  used.add(out);
  return out;
}

/** Strokes to `strokes.bin` bytes; damaged strokes are left out and counted. */
export function encodeStrokes(strokes: readonly Stroke[]): { bytes: Uint8Array; skipped: number } {
  const used = new Set<string>();
  const parts: Uint8Array[] = [];
  for (const s of strokes) {
    const part = encodeOne(s, safeId(s.id, used));
    if (part) parts.push(part);
  }
  const head = new Writer();
  head.bytes(MAGIC);
  head.u8(VERSION);
  head.varint(parts.length);
  const h = head.finish();
  const out = new Uint8Array(h.length + parts.reduce((n, p) => n + p.length, 0));
  out.set(h);
  let at = h.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, skipped: strokes.length - parts.length };
}

/** `strokes.bin` bytes to strokes. Throws InkwError on anything malformed or unknown. */
export function decodeStrokes(bytes: Uint8Array): Stroke[] {
  const r = new Reader(bytes);
  for (const m of MAGIC)
    if (r.left < 1 || r.u8() !== m)
      throw new InkwError('format', 'Not an Inkwell file: bad stroke data');
  const version = r.u8();
  if (version !== VERSION)
    throw new InkwError('version', 'This file needs a newer version of Inkwell');
  const count = r.varint();
  // A stroke takes at least 14 bytes, so a count that cannot fit is damage, not a reason to allocate.
  if (count > r.left / 14 + 1)
    throw new InkwError('format', 'Not an Inkwell file: stroke count too large');
  const out: Stroke[] = [];
  for (let i = 0; i < count; i++) {
    const id = utf8(r.take(r.varint()));
    const toolIndex = r.u8();
    const tool = TOOLS[toolIndex];
    if (!tool)
      throw new InkwError('unsupported', 'This file uses a pen this version of Inkwell lacks');
    const flags = r.u8();
    const rgb = [r.u8(), r.u8(), r.u8()];
    const width = r.varint() / 16;
    const opacity = r.u8() / 255;
    const channels = r.u8();
    if (channels !== 1)
      throw new InkwError(
        'unsupported',
        'This file has stroke data this version of Inkwell cannot read',
      );
    const n = r.varint();
    if (n > MAX_POINTS || n > r.left / 3)
      throw new InkwError('format', 'Not an Inkwell file: point count too large');
    const points = new Array<number>(n * 3);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let p1 = 0;
    for (let k = 0; k < n; k++) {
      const x = unzigzag(r.varint()) + 2 * x1 - x2;
      const y = unzigzag(r.varint()) + 2 * y1 - y2;
      const p = unzigzag(r.varint()) + p1;
      points[k * 3] = x / 64;
      points[k * 3 + 1] = y / 64;
      points[k * 3 + 2] = p / 255;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      p1 = p;
    }
    out.push({
      id,
      tool,
      color: `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
      width,
      opacity,
      pressure: (flags & 1) === 1,
      points,
    });
  }
  return out;
}
