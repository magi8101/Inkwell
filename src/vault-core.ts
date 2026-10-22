// A notebook kept in a folder on disk, Obsidian-style: each folder is a directory, each page a
// `<title>.inkwell` file (JSON), pictures sit in `attachments/`. Pure logic, no DOM, so
// vault.check.ts can run it against an in-memory folder.

import type { Notebook, Page, Section } from './store.ts';

/** The folder on disk, as the browser (File System Access) or the desktop app's Rust side sees it. */
export interface Backend {
  /** Every file, plus every directory with a trailing `/`. */
  list(): Promise<string[]>;
  read(path: string): Promise<Blob>;
  write(path: string, data: Blob | string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Deletes a file, or a directory (trailing `/`) only if it's empty. */
  remove(path: string): Promise<void>;
}

/** What the app last wrote to (or read from) each path: content hash, and the page id for pages. */
export type Written = Record<string, { h: string; id?: string }>;

const EXT = '.inkwell';
const ATTACHMENTS = 'attachments/';

/** A name that's valid on Windows, macOS and Linux. */
export const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120) || 'Untitled';

/** Appends " (2)", " (3)"… until the name is free (case-insensitively, for Windows and macOS). */
function unique(name: string, taken: Set<string>) {
  let n = name;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} (${i})`;
  taken.add(n.toLowerCase());
  return n;
}

/** FNV-1a: cheap change detection for page files (not security). */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

export const pageText = (p: Page) => JSON.stringify({ inkwell: 1, ...p });

const extOf = (type: string) =>
  (type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/\W/g, '');

type Entry =
  | { kind: 'dir'; sec: Section }
  | { kind: 'page'; page: Page }
  | { kind: 'att'; blob: string };

/** Where every folder, page and picture of the notebook goes on disk. */
export function layout(nb: Notebook, types: ReadonlyMap<string, string>): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (parent: string | undefined, prefix: string) => {
    const taken = new Set(prefix ? [] : ['attachments']);
    for (const sec of nb.sections.filter((x) => x.parent === parent)) {
      const dir = `${prefix}${unique(safe(sec.name), taken)}/`;
      out.set(dir, { kind: 'dir', sec });
      const names = new Set<string>();
      for (const page of sec.pages) {
        out.set(`${dir}${unique(safe(page.title), names)}${EXT}`, { kind: 'page', page });
        for (const im of page.images) {
          out.set(`${ATTACHMENTS}${im.blob}.${extOf(types.get(im.blob) ?? '')}`, {
            kind: 'att',
            blob: im.blob,
          });
        }
      }
      walk(sec.id, dir);
    }
  };
  walk(undefined, '');
  return out;
}

/**
 * Writes what changed since the last sync and deletes what's gone. Only the app's own files are
 * ever deleted; a directory goes only once it's empty.
 */
export async function syncOut(
  nb: Notebook,
  disk: Backend,
  written: Written,
  readBlob: (id: string) => Promise<Blob | undefined>,
  types: Map<string, string>,
) {
  for (const p of nb.sections.flatMap((s) => s.pages)) {
    for (const im of p.images) {
      if (!types.has(im.blob)) types.set(im.blob, (await readBlob(im.blob))?.type ?? '');
    }
  }
  const want = layout(nb, types);
  for (const [path, e] of want) {
    if (e.kind === 'dir') {
      if (!written[path]) {
        await disk.mkdir(path);
        written[path] = { h: 'dir' };
      }
    } else if (e.kind === 'att') {
      const blob = !written[path] && (await readBlob(e.blob));
      if (blob) {
        await disk.write(path, blob);
        written[path] = { h: 'att' };
      }
    } else {
      const text = pageText(e.page);
      const h = hash(text);
      if (written[path]?.h !== h) {
        await disk.write(path, text);
        written[path] = { h, id: e.page.id };
      }
    }
  }
  // Longest paths first, so a directory's files are gone before the directory.
  const gone = Object.keys(written)
    .filter((p) => !want.has(p))
    .sort((a, b) => b.length - a.length);
  for (const p of gone) {
    await disk.remove(p);
    delete written[p];
  }
}

export interface DiskPlan {
  dirs: string[];
  /** Pages new or changed on disk since the app last wrote them. */
  pages: { path: string; dir: string; page: Page; h: string }[];
  /** Pages the app wrote that are no longer on disk. */
  deleted: { path: string; id: string }[];
  /** Folders the app made that are no longer on disk. */
  deletedDirs: string[];
}

/** Reads the folder: what's new, changed or deleted there since the app last synced. */
export async function readDisk(
  disk: Backend,
  written: Written,
  hasBlob: (id: string) => Promise<boolean>,
  putBlob: (id: string, blob: Blob) => Promise<void>,
): Promise<DiskPlan> {
  const files = await disk.list();
  const onDisk = new Set(files);
  const plan: DiskPlan = { dirs: [], pages: [], deleted: [], deletedDirs: [] };
  for (const f of files) {
    if (f.startsWith(ATTACHMENTS)) continue;
    if (f.endsWith('/')) {
      plan.dirs.push(f);
      continue;
    }
    if (!f.endsWith(EXT)) continue;
    const text = await (await disk.read(f)).text();
    const h = hash(text);
    if (written[f]?.h === h) continue; // unchanged since the app wrote it
    let page: Page;
    try {
      const { inkwell, ...rest } = JSON.parse(text);
      if (inkwell !== 1) continue;
      page = rest;
    } catch {
      continue; // not one of ours, or half-written by a sync client: try again next time
    }
    const slash = f.lastIndexOf('/');
    page.id ||= `${f}`;
    page.title = f.slice(slash + 1, -EXT.length); // the file name is the title, as in Obsidian
    page.strokes ??= [];
    page.texts ??= [];
    page.images ??= [];
    page.background ??= 'blank';
    page.pageColor ??= 'auto';
    // Pages loose in the top of the folder go into an "Unsorted" folder.
    plan.pages.push({ path: f, dir: slash < 0 ? 'Unsorted/' : f.slice(0, slash + 1), page, h });
    for (const im of page.images) {
      if (await hasBlob(im.blob)) continue;
      const file = files.find((x) => x.startsWith(`${ATTACHMENTS}${im.blob}.`));
      if (file) await putBlob(im.blob, await disk.read(file));
    }
  }
  const renamed = new Set(plan.pages.map((p) => p.page.id));
  for (const [path, w] of Object.entries(written)) {
    if (onDisk.has(path)) continue;
    if (w.id && !renamed.has(w.id)) plan.deleted.push({ path, id: w.id });
    else if (w.id) delete written[path]; // renamed or moved on disk: the new path takes over
    if (w.h === 'dir') plan.deletedDirs.push(path);
  }
  return plan;
}

/** Applies what changed on disk to the notebook (call inside `update`). */
export function applyDisk(
  nb: Notebook,
  plan: DiskPlan,
  written: Written,
  newFolder: (name: string, parent?: string) => Section,
) {
  const at = new Map<string, Section>();
  for (const [path, e] of layout(nb, new Map())) if (e.kind === 'dir') at.set(path, e.sec);
  const folder = (dir: string): Section => {
    const hit = at.get(dir);
    if (hit) return hit;
    const parts = dir.slice(0, -1).split('/');
    const parent = parts.length > 1 ? folder(`${parts.slice(0, -1).join('/')}/`) : undefined;
    const sec = newFolder(parts.at(-1)!, parent?.id);
    nb.sections.push(sec);
    at.set(dir, sec);
    written[dir] = { h: 'dir' };
    return sec;
  };
  for (const d of plan.dirs) folder(d);
  const pageAt = (id: string) => {
    for (const sec of nb.sections) {
      const i = sec.pages.findIndex((p) => p.id === id);
      if (i >= 0) return { sec, i };
    }
    return null;
  };
  for (const { path, dir, page, h } of plan.pages) {
    const target = folder(dir);
    const old = pageAt(page.id);
    if (old?.sec === target) target.pages[old.i] = page;
    else {
      old?.sec.pages.splice(old.i, 1);
      target.pages.push(page);
    }
    written[path] = { h, id: page.id };
  }
  for (const { path, id } of plan.deleted) {
    const old = pageAt(id);
    old?.sec.pages.splice(old.i, 1);
    delete written[path];
  }
  // A folder deleted on disk goes too, once nothing is left in it.
  for (const dir of plan.deletedDirs.sort((a, b) => b.length - a.length)) {
    const sec = at.get(dir);
    if (sec && !sec.pages.length && !nb.sections.some((x) => x.parent === sec.id)) {
      nb.sections.splice(nb.sections.indexOf(sec), 1);
    }
    delete written[dir];
  }
}
