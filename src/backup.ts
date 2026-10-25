// A backup of everything in Inkwell as ONE file: a zip holding `inkwell-backup.json` (every
// notebook, section and page as the app stores them) and `pictures/<id>` (the picture files they
// use), optionally locked with a password. Pure functions on bytes, no DOM, so backup.check.ts can
// run them; backup-ui.ts reads and writes the app's own storage.
//
//   file      = zip                                   (plain)
//             | "INKWBK1" 0x00 · salt(16) · iv(12) · AES-256-GCM(zip)   (with a password;
//               key = PBKDF2-SHA256, 250 000 rounds, of the password and the salt)

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface BackupDoc {
  format: 'inkwell-backup';
  v: 1;
  created: string;
  notebooks: unknown[];
}
export interface BackupPicture {
  id: string;
  type: string;
  bytes: Uint8Array;
}

const MAGIC = strToU8('INKWBK1\0');
const ROUNDS = 250_000;

export function packBackup(notebooks: unknown[], pictures: readonly BackupPicture[]): Uint8Array {
  const doc: BackupDoc = {
    format: 'inkwell-backup',
    v: 1,
    created: new Date().toISOString(),
    notebooks,
  };
  const files: Record<string, Uint8Array> = {
    'inkwell-backup.json': strToU8(JSON.stringify(doc)),
    'pictures.json': strToU8(
      JSON.stringify(Object.fromEntries(pictures.map((p) => [p.id, p.type]))),
    ),
  };
  // Pictures are already compressed (JPEG, PNG, WebP); zipping them again only costs time.
  for (const p of pictures) files[`pictures/${p.id}`] = p.bytes;
  return zipSync(files, { level: 6 });
}

export function unpackBackup(bytes: Uint8Array): { doc: BackupDoc; pictures: BackupPicture[] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('Not an Inkwell backup');
  }
  const raw = files['inkwell-backup.json'];
  if (!raw) throw new Error('Not an Inkwell backup');
  const doc = JSON.parse(strFromU8(raw)) as BackupDoc;
  if (doc.format !== 'inkwell-backup' || doc.v !== 1 || !Array.isArray(doc.notebooks))
    throw new Error('Not an Inkwell backup, or from a newer version');
  const types = files['pictures.json']
    ? (JSON.parse(strFromU8(files['pictures.json'])) as Record<string, string>)
    : {};
  const pictures = Object.entries(files)
    .filter(([name]) => name.startsWith('pictures/'))
    .map(([name, b]) => {
      const id = name.slice('pictures/'.length);
      return { id, type: types[id] ?? 'image/png', bytes: b };
    });
  return { doc, pictures };
}

export const isLocked = (bytes: Uint8Array) =>
  bytes.length > MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);

async function keyFrom(password: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', strToU8(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ROUNDS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function lock(zip: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      zip as BufferSource,
    ),
  );
  const out = new Uint8Array(MAGIC.length + 16 + 12 + body.length);
  out.set(MAGIC);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + 16);
  out.set(body, MAGIC.length + 28);
  return out;
}

/** Throws "Wrong password" when the password is wrong or the file was changed. */
export async function unlock(file: Uint8Array, password: string): Promise<Uint8Array> {
  if (!isLocked(file)) throw new Error('Not a locked Inkwell backup');
  const salt = file.slice(MAGIC.length, MAGIC.length + 16);
  const iv = file.slice(MAGIC.length + 16, MAGIC.length + 28);
  const key = await keyFrom(password, salt);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        file.slice(MAGIC.length + 28) as BufferSource,
      ),
    );
  } catch {
    throw new Error('Wrong password');
  }
}
