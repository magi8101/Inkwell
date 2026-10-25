// The .inkw container (docs/inkw-spec.md): one ZIP holding JSON for the schema and a compact binary
// file per page for strokes. Reads and writes whole files in memory; pure, no DOM, so it runs in the
// browser, the desktop app and Node.

import { strToU8, type Zippable, zipSync } from 'fflate';
import { isLocked, lock, unlock } from './backup.ts';
import { decodeStrokes, encodeStrokes, InkwError } from './inkw-codec.ts';
import { badEntryName, DEFAULT_LIMITS, type InkwLimits, readZip } from './inkw-zip.ts';
import type { Stroke } from './store.ts';

export { InkwError } from './inkw-codec.ts';
export type { InkwLimits } from './inkw-zip.ts';

export const INKW_MIME = 'application/vnd.inkwell.notebook+zip';
const FORMAT = 'inkw';
const MAJOR = 1;
const MINOR = 0;
/** Fixed so the same document always produces the same bytes (the zip format starts at 1980). */
const MTIME = Date.UTC(1980, 0, 1);

export interface InkwPage {
  id: string;
  strokes: Stroke[];
  /** Everything in `page.json`: unknown keys included, so a newer file survives an older editor. */
  json: Record<string, unknown>;
}
export interface InkwNotebook {
  id: string;
  json: Record<string, unknown>;
}
export interface InkwData {
  created: string;
  modified: string;
  generator: string;
  notebooks: InkwNotebook[];
  pages: InkwPage[];
  /** Pictures by the SHA-256 (hex) of their bytes. */
  blobs: Map<string, { ext: string; bytes: Uint8Array }>;
  /** The manifest's `extra` object, and any other top-level manifest keys this version does not know. */
  extra: Record<string, unknown>;
  manifestRest: Record<string, unknown>;
  /** Entries this version does not know (thumbnails included), kept for write-back. */
  unknownEntries: Record<string, Uint8Array>;
  /** Things that were wrong but not fatal (a page naming a missing picture, say). */
  warnings: string[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (b: Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', b as BufferSource));
const json = (v: unknown) => strToU8(JSON.stringify(v));

/** The document as a .inkw file. Damaged strokes are left out and counted. */
export async function writeInkw(d: InkwData): Promise<{ bytes: Uint8Array; skipped: number }> {
  const files: Zippable = {
    mimetype: [strToU8(INKW_MIME), { level: 0, mtime: MTIME }],
  };
  const manifest = {
    ...d.manifestRest,
    format: FORMAT,
    version: { major: MAJOR, minor: MINOR },
    created: d.created,
    modified: d.modified,
    generator: d.generator,
    notebooks: d.notebooks.map((n) => n.id),
    locked: false,
    extra: d.extra,
  };
  files['inkw.json'] = [json(manifest), { level: 6, mtime: MTIME }];
  for (const n of d.notebooks) {
    if (!ID.test(n.id)) throw new InkwError('format', `Not a valid notebook id: ${n.id}`);
    files[`notebooks/${n.id}.json`] = [json({ ...n.json, id: n.id }), { level: 6, mtime: MTIME }];
  }
  let skipped = 0;
  for (const p of d.pages) {
    if (!ID.test(p.id)) throw new InkwError('format', `Not a valid page id: ${p.id}`);
    files[`pages/${p.id}/page.json`] = [json(p.json), { level: 6, mtime: MTIME }];
    const enc = encodeStrokes(p.strokes);
    skipped += enc.skipped;
    files[`pages/${p.id}/strokes.bin`] = [enc.bytes, { level: 6, mtime: MTIME }];
  }
  for (const [hash, blob] of d.blobs) {
    if (!HASH.test(hash) || !EXT.test(blob.ext))
      throw new InkwError('format', 'A picture has an invalid hash or extension');
    if ((await sha256(blob.bytes)) !== hash)
      throw new InkwError('format', 'A picture does not match its hash');
    files[`blobs/${hash}.${blob.ext}`] = [blob.bytes, { level: 0, mtime: MTIME }];
  }
  for (const [name, bytes] of Object.entries(d.unknownEntries)) {
    if (badEntryName(name) || name in files)
      throw new InkwError('format', `Not a valid entry name: ${name}`);
    files[name] = [bytes, { level: 6, mtime: MTIME }];
  }
  return { bytes: zipSync(files), skipped };
}

function parse(bytes: Uint8Array, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new InkwError('format', `Not an Inkwell file: ${what} is damaged`);
}

/** A .inkw file as a document. Throws InkwError for anything that is not a valid file. */
export async function readInkw(
  bytes: Uint8Array,
  limits: Partial<InkwLimits> = {},
): Promise<InkwData> {
  if (isInkwLocked(bytes))
    throw new InkwError('password', 'This file is locked: it needs its password');
  const entries = readZip(bytes, { ...DEFAULT_LIMITS, ...limits });
  const mime = entries.mimetype;
  if (!mime || new TextDecoder().decode(mime) !== INKW_MIME)
    throw new InkwError('format', 'Not an Inkwell file');
  const raw = entries['inkw.json'];
  if (!raw) throw new InkwError('format', 'Not an Inkwell file');
  const m = parse(raw, 'the file header');
  const v = m.version as { major?: unknown; minor?: unknown } | undefined;
  if (m.format !== FORMAT || typeof v?.major !== 'number')
    throw new InkwError('format', 'Not an Inkwell file');
  if (v.major > MAJOR) throw new InkwError('version', 'This file needs a newer version of Inkwell');

  const {
    format: _f,
    version: _v,
    created,
    modified,
    generator,
    notebooks: ids,
    locked: _l,
    extra,
    ...rest
  } = m;
  const data: InkwData = {
    created: typeof created === 'string' ? created : '',
    modified: typeof modified === 'string' ? modified : '',
    generator: typeof generator === 'string' ? generator : '',
    notebooks: [],
    pages: [],
    blobs: new Map(),
    extra:
      extra && typeof extra === 'object' && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : {},
    manifestRest: rest,
    unknownEntries: {},
    warnings: [],
  };
  const known = new Set(['mimetype', 'inkw.json']);
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || !ID.test(id))
      throw new InkwError('format', 'Not an Inkwell file: bad notebook id');
    const entry = entries[`notebooks/${id}.json`];
    if (!entry) {
      data.warnings.push(`Notebook ${id} is listed but missing`);
      continue;
    }
    known.add(`notebooks/${id}.json`);
    data.notebooks.push({ id, json: parse(entry, `notebook ${id}`) });
  }
  for (const name of Object.keys(entries)) {
    const page = /^pages\/([A-Za-z0-9_-]{1,64})\/page\.json$/.exec(name);
    if (page) {
      const id = page[1]!;
      known.add(name);
      known.add(`pages/${id}/strokes.bin`);
      const s = entries[`pages/${id}/strokes.bin`];
      data.pages.push({
        id,
        strokes: s ? decodeStrokes(s) : [],
        json: parse(entries[name]!, `page ${id}`),
      });
      continue;
    }
    const blob = /^blobs\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(name);
    if (blob) {
      known.add(name);
      if ((await sha256(entries[name]!)) !== blob[1])
        throw new InkwError('format', 'Not an Inkwell file: a picture is damaged');
      data.blobs.set(blob[1]!, { ext: blob[2]!, bytes: entries[name]! });
    }
  }
  for (const [name, b] of Object.entries(entries))
    if (!known.has(name)) data.unknownEntries[name] = b;
  return data;
}

// --- Locking: the same wrapper as backups (backup.ts) with its own magic ---

const LOCK_MAGIC = strToU8('INKWLK1\0');
export const isInkwLocked = (bytes: Uint8Array) => isLocked(bytes, LOCK_MAGIC);

export async function writeInkwLocked(
  d: InkwData,
  password: string,
): Promise<{ bytes: Uint8Array; skipped: number }> {
  const { bytes, skipped } = await writeInkw(d);
  return { bytes: await lock(bytes, password, LOCK_MAGIC), skipped };
}

export async function readInkwLocked(
  bytes: Uint8Array,
  password: string,
  limits: Partial<InkwLimits> = {},
): Promise<InkwData> {
  let zip: Uint8Array;
  try {
    zip = await unlock(bytes, password, LOCK_MAGIC);
  } catch (e) {
    if (!isInkwLocked(bytes)) throw new InkwError('format', 'Not an Inkwell file');
    throw new InkwError('password', (e as Error).message);
  }
  return readInkw(zip, limits);
}
