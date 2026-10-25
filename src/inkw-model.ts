// Maps the app's notebooks to and from a .inkw document. The app's data stays as it is; this module
// only translates, and everything read from a file goes through notebook-clean.ts. Pure: pictures
// and ids come in through arguments, so it runs in Node.

import { type InkwData, type InkwNotebook, type InkwPage, sha256 } from './inkw.ts';
import { cleanNotebooks } from './notebook-clean.ts';
import type { Notebook, Page } from './store.ts';

export interface BlobBytes {
  type: string;
  bytes: Uint8Array;
}

const TYPE_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};
const EXT_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_EXT).map(([t, e]) => [e, t]));
const UNSAFE = /[^A-Za-z0-9_-]/g;

/** An id that fits the spec, unique among the ids already used (the app's own ids already do). */
function safeId(id: string, used: Set<string>): string {
  const base = id.replace(UNSAFE, '_').slice(0, 56) || 'x';
  let out = base;
  for (let k = 1; used.has(out); k++) out = `${base}-${k}`;
  used.add(out);
  return out;
}

/** The notebooks as a document. A picture that cannot be found is left out, with a warning. */
export async function toInkw(
  notebooks: readonly Notebook[],
  getBlob: (id: string) => Promise<BlobBytes | null>,
  generator = 'Inkwell',
): Promise<InkwData> {
  const now = new Date().toISOString();
  const data: InkwData = {
    created: now,
    modified: now,
    generator,
    notebooks: [],
    pages: [],
    blobs: new Map(),
    extra: {},
    manifestRest: {},
    unknownEntries: {},
    warnings: [],
  };
  const hashOf = new Map<string, string | null>(); // app picture id -> blob hash (null: not found)
  const picture = async (id: string): Promise<string | null> => {
    if (!hashOf.has(id)) {
      const b = await getBlob(id);
      if (!b) hashOf.set(id, null);
      else {
        const hash = await sha256(b.bytes);
        data.blobs.set(hash, { ext: TYPE_TO_EXT[b.type] ?? 'bin', bytes: b.bytes });
        hashOf.set(id, hash);
      }
    }
    return hashOf.get(id)!;
  };
  const nIds = new Set<string>();
  const pIds = new Set<string>();
  for (const nb of notebooks) {
    const sIds = new Map<string, string>();
    for (const s of nb.sections) sIds.set(s.id, safeId(s.id, new Set(sIds.values())));
    const sections: Record<string, unknown>[] = [];
    for (const s of nb.sections) {
      const pids: string[] = [];
      for (const p of s.pages) {
        const pid = safeId(p.id, pIds);
        pids.push(pid);
        const { id: _id, strokes, images, backdrop, inkSig: _sig, ...rest } = p as Page;
        const placed = [];
        for (const im of images) {
          const hash = await picture(im.blob);
          if (hash) placed.push({ ...im, blob: hash });
          else data.warnings.push(`A picture on “${p.title}” was missing and was left out`);
        }
        const json: Record<string, unknown> = { ...rest, images: placed };
        if (backdrop) {
          const hash = await picture(backdrop);
          if (hash) json.backdrop = hash;
          else {
            delete json.backdrop;
            data.warnings.push(
              `The background picture of “${p.title}” was missing and was left out`,
            );
          }
        }
        data.pages.push({ id: pid, strokes, json } as InkwPage);
      }
      sections.push({
        id: sIds.get(s.id),
        name: s.name,
        color: s.color,
        ...(s.parent && sIds.has(s.parent) ? { parent: sIds.get(s.parent) } : {}),
        ...(s.collapsed ? { collapsed: true } : {}),
        pages: pids,
      });
    }
    const id = safeId(nb.id, nIds);
    data.notebooks.push({ id, json: { id, name: nb.name, sections } } as InkwNotebook);
  }
  return data;
}

/**
 * Notebooks from a document, ready to add next to existing ones: fresh ids everywhere, pictures
 * stored through `storePicture`, names that already exist get " (restored)".
 */
export async function fromInkw(
  data: InkwData,
  newId: () => string,
  storePicture: (b: BlobBytes) => Promise<string>,
  existingNames: ReadonlySet<string>,
): Promise<{ notebooks: Notebook[]; warnings: string[] }> {
  const warnings = [...data.warnings];
  const pic = new Map<string, string>();
  for (const [hash, b] of data.blobs) {
    try {
      pic.set(
        hash,
        await storePicture({
          type: EXT_TO_TYPE[b.ext] ?? 'application/octet-stream',
          bytes: b.bytes,
        }),
      );
    } catch {
      warnings.push('A picture in the file could not be read and was left out');
    }
  }
  const byId = new Map(data.pages.map((p) => [p.id, p]));
  const raw = data.notebooks.map((n) => {
    const sections = Array.isArray(n.json.sections)
      ? (n.json.sections as Record<string, unknown>[])
      : [];
    return {
      ...n.json,
      sections: sections.map((s) => ({
        ...s,
        pages: (Array.isArray(s.pages) ? (s.pages as unknown[]) : []).flatMap((pid) => {
          const p = typeof pid === 'string' ? byId.get(pid) : undefined;
          if (!p) {
            warnings.push(`A page named ${String(pid).slice(0, 40)} is missing from the file`);
            return [];
          }
          const images = Array.isArray(p.json.images) ? (p.json.images as { blob?: string }[]) : [];
          for (const im of images)
            if (im?.blob && !pic.has(im.blob)) {
              warnings.push(
                `A picture on “${String(p.json.title ?? 'a page').slice(0, 60)}” is missing from the file and was left out`,
              );
              break;
            }
          return [{ ...p.json, strokes: p.strokes }];
        }),
      })),
    };
  });
  const notebooks = cleanNotebooks(raw, pic, newId);
  for (const n of notebooks) if (existingNames.has(n.name)) n.name = `${n.name} (restored)`;
  return { notebooks, warnings };
}
