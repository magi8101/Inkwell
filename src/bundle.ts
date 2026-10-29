import { FileText, FolderOpen, Image as ImageIcon, X } from 'lucide';
import { h, icon, toast } from './dom';
import { storePicture } from './images';
import { importOneNote } from './onenote';
import {
  type ImageItem,
  newMarkdownPage,
  newPage,
  newSection,
  notebook,
  type Page,
  type Section,
  state,
  uid,
  update,
} from './store';

// Zips and folders, dropped on the page or picked with Insert → Zip or folder…: Inkwell lists the
// Markdown notes, PDFs and pictures inside and either imports them (the folder structure becomes
// sidebar folders; .md → Markdown notes, PDFs and pictures → pages to write on) or just shows them
// in a viewer without saving anything. A dropped folder (Chrome/Edge/Brave and the Windows app,
// which can keep a handle to it) is re-read every few seconds while the app is open: files changed
// in another app update in Inkwell. ponytail: the link to a folder lasts until the app is closed.

export interface Entry {
  /** '/'-separated, relative to the zip or folder. */
  path: string;
  file: Blob;
  /** File time, to notice changes on disk (0 when unknown, e.g. inside a zip). */
  modified: number;
}
export interface Bundle {
  name: string;
  entries: Entry[];
  /** Set when the folder can be read again later (live updates). */
  dir?: DirHandle;
}

// Not yet in TypeScript's DOM types.
interface DirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, DirHandle | { kind: 'file'; getFile(): Promise<File> }]>;
}

type Kind = 'md' | 'pdf' | 'image' | 'one';
export const kindOf = (path: string): Kind | null =>
  /\.(md|markdown)$/i.test(path)
    ? 'md'
    : /\.pdf$/i.test(path)
      ? 'pdf'
      : /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(path)
        ? 'image'
        : /\.one$/i.test(path)
          ? 'one'
          : null;
const MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
/** Zipped files carry no type; pictures need theirs (to show, and as data: URLs). */
const mimeOf = (path: string) => MIME[path.split('.').pop()!.toLowerCase()] ?? '';
/** Hidden files and OS clutter (__MACOSX, .DS_Store, .git, .obsidian…) are never shown. */
const junk = (path: string) => path.split('/').some((p) => p.startsWith('.') || p === '__MACOSX');
const MAX_FILES = 5000;

// --- Reading ---

export async function readZip(file: File): Promise<Bundle> {
  const { unzip } = await import('fflate');
  const data = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      data,
      { filter: (f) => !f.name.endsWith('/') && !junk(f.name) && !!kindOf(f.name) },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  );
  const paths = Object.keys(files);
  // A zip of one folder ("notes/…" throughout): that folder is the bundle, not a level inside it.
  const top = paths[0]?.split('/')[0];
  const wrapped = top && paths.every((p) => p.startsWith(`${top}/`));
  const entries = paths.map((p) => ({
    path: wrapped ? p.slice(top.length + 1) : p,
    file: new Blob([files[p]!.slice()], { type: mimeOf(p) }),
    modified: 0,
  }));
  return { name: wrapped ? top : file.name.replace(/\.zip$/i, ''), entries };
}

export async function readDirHandle(dir: DirHandle): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (d: DirHandle, prefix: string) => {
    for await (const [name, child] of d.entries()) {
      const path = prefix + name;
      if (junk(path) || out.length >= MAX_FILES) continue;
      if (child.kind === 'directory') await walk(child, `${path}/`);
      else if (kindOf(path)) {
        const file = await child.getFile();
        out.push({ path, file, modified: file.lastModified });
      }
    }
  };
  await walk(dir, '');
  return out;
}

/** A folder dropped as an entry (every browser), walked recursively. */
async function readDirEntry(root: FileSystemDirectoryEntry): Promise<Entry[]> {
  const out: Entry[] = [];
  const list = (d: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const reader = d.createReader();
      const all: FileSystemEntry[] = [];
      // readEntries returns at most ~100 at a time; call until it returns none.
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) resolve(all);
          else {
            all.push(...batch);
            next();
          }
        }, reject);
      next();
    });
  const walk = async (d: FileSystemDirectoryEntry, prefix: string) => {
    for (const child of await list(d)) {
      const path = prefix + child.name;
      if (junk(path) || out.length >= MAX_FILES) continue;
      if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, `${path}/`);
      else if (kindOf(path)) {
        const file = await new Promise<File>((r, j) => (child as FileSystemFileEntry).file(r, j));
        out.push({ path, file, modified: file.lastModified });
      }
    }
  };
  await walk(root, '');
  return out;
}

/** Files picked with a folder input (webkitdirectory): paths come with the folder's name first. */
export function readPickedFolder(files: File[]): Bundle {
  const name = files[0]?.webkitRelativePath.split('/')[0] ?? 'Folder';
  const entries = files
    .map((f) => ({
      path: f.webkitRelativePath.split('/').slice(1).join('/'),
      file: f,
      modified: f.lastModified,
    }))
    .filter((e) => e.path && !junk(e.path) && kindOf(e.path))
    .slice(0, MAX_FILES);
  return { name, entries };
}

/**
 * Called during a drop: picks out dropped folders and zips (items are only readable during the
 * event, so their entries and handles are taken synchronously). Returns null when there are none.
 */
export function takeDroppedBundles(dt: DataTransfer): Promise<Bundle>[] | null {
  const out: Promise<Bundle>[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      // Chromium can also hand over a handle that stays readable: that's what makes live updates.
      const handle = (
        item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<DirHandle | null> }
      ).getAsFileSystemHandle?.();
      out.push(
        (async () => {
          const dir = (await handle?.catch(() => null)) ?? undefined;
          const entries = dir
            ? await readDirHandle(dir)
            : await readDirEntry(entry as FileSystemDirectoryEntry);
          return { name: entry.name, entries, dir: dir?.kind === 'directory' ? dir : undefined };
        })(),
      );
    } else {
      const file = item.getAsFile();
      if (file && /\.zip$/i.test(file.name)) out.push(readZip(file));
    }
  }
  return out.length ? out : null;
}

// --- Markdown pictures ---

/** Resolves `rel` (as written in a note at `from`) against the bundle's paths. */
function resolve(from: string, rel: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const p of decodeURI(rel).split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}
const MAX_INLINE = 3 * 1024 * 1024;

/**
 * Pictures a note shows from inside the bundle (`![](pics/a.png)`, or Obsidian's `![[a.png]]`),
 * rewritten to `url(entry)`: data: URLs when importing (the note keeps them), blob: when viewing.
 */
export async function withPictures(
  md: string,
  at: string,
  entries: Entry[],
  url: (e: Entry) => Promise<string | null>,
): Promise<string> {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const byName = new Map(entries.map((e) => [e.path.split('/').pop()!, e]));
  const find = (target: string) => {
    if (/^[a-z]+:/i.test(target)) return undefined; // http:, data:… stay as they are
    try {
      return byPath.get(resolve(at, target)) ?? byName.get(decodeURI(target).split('/').pop()!);
    } catch {
      return undefined;
    }
  };
  const swaps = new Map<string, string>();
  const refs = [
    ...md.matchAll(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g),
    ...md.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g),
  ];
  for (const m of refs) {
    const target = m[0].startsWith('![[') ? m[1]! : m[2]!;
    const e = find(target);
    const src = e && kindOf(e.path) === 'image' ? await url(e) : null;
    if (src) swaps.set(m[0], `![${m[0].startsWith('![[') ? '' : m[1]}](${src})`);
  }
  return md.replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]*\)/g, (s) => swaps.get(s) ?? s);
}

export const dataUrl = (e: Entry) =>
  e.file.size > MAX_INLINE
    ? Promise.resolve(null)
    : new Promise<string | null>((r) => {
        const fr = new FileReader();
        fr.onload = () => r(String(fr.result));
        fr.onerror = () => r(null);
        fr.readAsDataURL(e.file);
      });

// --- Importing ---

const baseName = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, '');

async function picturePage(e: Entry): Promise<Page> {
  const { blob, width, height } = await storePicture(e.file);
  const picture: ImageItem = {
    id: uid(),
    blob,
    cx: width / 2,
    cy: height / 2,
    w: width,
    h: height,
    angle: 0,
  };
  const p = newPage(baseName(e.path));
  p.images = [picture];
  return p;
}

/** The import's link to its files: which page each came from, for live updates. */
interface Imported {
  pageId: string;
  modified: number;
  /** The note's Markdown as imported, to tell whether it was edited in Inkwell since. */
  md?: string;
}
interface Link {
  bundle: Bundle;
  notebookId: string;
  /** Folder path ('' = the top folder) → sidebar folder id. */
  folders: Map<string, string>;
  files: Map<string, Imported>;
  conflicts: Set<string>;
}
const links: Link[] = [];

async function pagesFor(e: Entry, entries: Entry[]): Promise<{ pages: Page[]; md?: string }> {
  const kind = kindOf(e.path);
  if (kind === 'md') {
    const md = await withPictures(await e.file.text(), e.path, entries, dataUrl);
    return { pages: [newMarkdownPage(baseName(e.path), md)], md };
  }
  if (kind === 'pdf') {
    const { pdfPages } = await import('./pdf-import');
    return { pages: await pdfPages(e.file, baseName(e.path)) };
  }
  return { pages: [await picturePage(e)] };
}

const byPath = (a: Entry, b: Entry) => a.path.localeCompare(b.path, undefined, { numeric: true });

export async function importBundle(bundle: Bundle) {
  // A picture that a note shows is part of that note, not a page of its own.
  const notes = await Promise.all(
    bundle.entries.filter((e) => kindOf(e.path) === 'md').map((e) => e.file.text()),
  );
  const shown = (img: Entry) => notes.some((md) => md.includes(img.path.split('/').pop()!));
  // OneNote sections open as sections of their own (onenote.ts), after the rest.
  const ones = bundle.entries.filter((e) => kindOf(e.path) === 'one');
  const files = bundle.entries.filter(
    (e) => kindOf(e.path) !== 'one' && (kindOf(e.path) !== 'image' || !shown(e)),
  );
  files.sort(byPath);
  const link: Link = {
    bundle,
    notebookId: state.notebookId,
    folders: new Map(),
    files: new Map(),
    conflicts: new Set(),
  };
  const nb = notebook();
  const sections: Section[] = [];
  const folderFor = (dir: string): Section => {
    const id = link.folders.get(dir);
    const found = id && sections.find((s) => s.id === id);
    if (found) return found;
    const parent = dir ? folderFor(dir.split('/').slice(0, -1).join('/')) : undefined;
    const sec = newSection(
      dir ? dir.split('/').pop()! : bundle.name,
      nb.sections.length + sections.length,
    );
    sec.pages = [];
    if (parent) sec.parent = parent.id;
    sections.push(sec);
    link.folders.set(dir, sec.id);
    return sec;
  };
  let failed = 0;
  for (const [i, e] of files.entries()) {
    toast(`Importing “${bundle.name}”: ${i + 1} of ${files.length}…`, 60_000);
    try {
      const { pages, md } = await pagesFor(e, bundle.entries);
      folderFor(e.path.split('/').slice(0, -1).join('/')).pages.push(...pages);
      link.files.set(e.path, { pageId: pages[0]!.id, modified: e.modified, md });
    } catch (err) {
      console.error(e.path, err);
      failed++;
    }
  }
  const first = sections.find((s) => s.pages.length);
  if (!first && !ones.length) {
    toast(`Nothing in “${bundle.name}” could be imported.`, 4000);
    return;
  }
  if (first) {
    update((s) => {
      nb.sections.push(...sections);
      s.sectionId = first.id;
      s.pageId = first.pages[0]!.id;
    });
    if (bundle.dir) {
      links.push(link);
      watch();
    }
  }
  for (const e of ones.sort(byPath))
    await importOneNote(new File([e.file], e.path.split('/').pop() ?? 'section.one'));
  if (!first) return; // the OneNote imports said what happened
  toast(
    `Imported “${bundle.name}”: ${link.files.size} file${link.files.size === 1 ? '' : 's'}` +
      (failed ? `, ${failed} couldn’t be read` : '') +
      (bundle.dir
        ? '. Changes made to the folder in other apps show up here while Inkwell is open.'
        : '.'),
    6000,
  );
}

// --- Live updates from disk ---

let timer = 0;
let viewerRefresh: (() => Promise<void>) | null = null;
function watch() {
  if (timer) return;
  timer = window.setInterval(() => {
    if (document.hidden) return;
    void (async () => {
      for (const l of links) await refresh(l).catch(() => {});
      await viewerRefresh?.().catch(() => {});
    })();
  }, 3000);
}

const findPage = (id: string) => {
  for (const nb of state.notebooks)
    for (const sec of nb.sections)
      for (const p of sec.pages) if (p.id === id) return { nb, sec, p };
  return null;
};

async function refresh(l: Link) {
  if (!l.bundle.dir) return;
  const entries = await readDirHandle(l.bundle.dir);
  l.bundle.entries = entries;
  const changes: (() => void)[] = [];
  for (const e of entries) {
    const known = l.files.get(e.path);
    if (kindOf(e.path) !== 'md') continue; // ponytail: only notes follow the disk; PDFs and pictures are copies
    if (!known) {
      // A new note on disk: add it to its folder (when that folder is still in the notebook).
      const dir = e.path.split('/').slice(0, -1).join('/');
      const md = await withPictures(await e.file.text(), e.path, entries, dataUrl);
      const page = newMarkdownPage(baseName(e.path), md);
      l.files.set(e.path, { pageId: page.id, modified: e.modified, md });
      changes.push(() => {
        const nb = state.notebooks.find((n) => n.id === l.notebookId);
        const sec = nb?.sections.find((s) => s.id === (l.folders.get(dir) ?? l.folders.get('')));
        sec?.pages.push(page);
      });
      continue;
    }
    if (e.modified <= known.modified) continue;
    known.modified = e.modified;
    const md = await withPictures(await e.file.text(), e.path, entries, dataUrl);
    const found = findPage(known.pageId);
    if (!found || md === found.p.md) {
      known.md = md;
      continue;
    }
    if (found.p.md !== known.md) {
      // Edited both here and on disk: keep what's in Inkwell, say so once.
      if (!l.conflicts.has(e.path)) {
        l.conflicts.add(e.path);
        toast(`“${e.path}” changed on disk and in Inkwell. Kept the Inkwell version.`, 6000);
      }
      continue;
    }
    known.md = md;
    changes.push(() => {
      found.p.md = md;
    });
  }
  if (changes.length)
    update(() => {
      for (const c of changes) c();
    });
}

// --- The choice, and the viewer ---

function summary(b: Bundle) {
  const n = (k: Kind) => b.entries.filter((e) => kindOf(e.path) === k).length;
  const parts = [
    [n('md'), 'Markdown note'],
    [n('pdf'), 'PDF'],
    [n('image'), 'picture'],
    [n('one'), 'OneNote section'],
  ]
    .filter(([c]) => c)
    .map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function overlay(label: string, ...children: HTMLElement[]) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const close = () => {
    el.remove();
    removeEventListener('keydown', onKey);
    viewerRefresh = null;
    for (const u of urls) URL.revokeObjectURL(u);
    urls.length = 0;
  };
  const el = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === el && close() },
    h(
      'div',
      { class: 'cal-card bundle-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
      ...children,
    ),
  );
  document.body.append(el);
  addEventListener('keydown', onKey);
  return close;
}
const urls: string[] = [];
const blobUrl = (e: Entry) => {
  const u = URL.createObjectURL(e.file);
  urls.push(u);
  return Promise.resolve(u);
};

/** Asks what to do with a zip or folder: import it, or just look. */
export function offerBundle(b: Bundle) {
  if (!b.entries.length) {
    toast(`“${b.name}” has no Markdown notes, PDFs, pictures or OneNote sections.`, 4000);
    return;
  }
  const closeBtn = h('button', { class: 'tb-btn cal-close', 'aria-label': 'Close' }, icon(X, 18));
  const close = overlay(
    b.name,
    h(
      'header',
      { class: 'cal-head' },
      icon(FolderOpen, 18),
      h('span', { style: 'flex: 1' }, b.name),
      closeBtn,
    ),
    h(
      'div',
      { class: 'cal-body' },
      h('p', { class: 'cal-text' }, `${summary(b)}.`),
      h(
        'p',
        { class: 'cal-text' },
        'Import adds them to this notebook as folders: Markdown notes you can edit, PDFs and pictures as pages to write on. View shows them without saving anything.' +
          (b.dir
            ? ' Either way, changes to the folder in other apps show up here while Inkwell is open.'
            : ''),
      ),
      h(
        'ul',
        { class: 'bundle-list' },
        ...b.entries
          .slice(0, 200)
          .sort(byPath)
          .map((e) => h('li', {}, e.path)),
      ),
    ),
    h(
      'footer',
      { class: 'cal-foot' },
      h(
        'button',
        {
          class: 'cal-btn',
          onclick: () => {
            close();
            openViewer(b);
          },
        },
        'View',
      ),
      h(
        'button',
        {
          class: 'primary',
          onclick: () => {
            close();
            void importBundle(b);
          },
        },
        'Import',
      ),
    ),
  );
  closeBtn.addEventListener('click', close);
}

/** Reads a zip/folder without importing: a file list, and the chosen file shown read-only. */
export function openViewer(b: Bundle) {
  const list = h('nav', { class: 'bundle-files', 'aria-label': 'Files' });
  const pane = h('div', { class: 'bundle-pane' });
  const card = h('div', { class: 'bundle-view' }, list, pane);
  let current = '';
  let shownModified = -1;
  let editor: { destroy(): void } | null = null;

  const show = async (e: Entry) => {
    current = e.path;
    shownModified = e.modified;
    card.classList.add('showing'); // phones: the file replaces the list (Back returns)
    for (const a of list.querySelectorAll('button'))
      a.setAttribute('aria-current', String(a.dataset.path === e.path));
    editor?.destroy();
    editor = null;
    const back = h(
      'button',
      { class: 'cal-btn bundle-back', onclick: () => card.classList.remove('showing') },
      '← Files',
    );
    const kind = kindOf(e.path);
    if (kind === 'image') {
      pane.replaceChildren(
        back,
        h('img', { class: 'bundle-img', src: await blobUrl(e), alt: e.path }),
      );
    } else if (kind === 'md') {
      const md = await withPictures(await e.file.text(), e.path, b.entries, blobUrl);
      const host = h('div', { class: 'md-body' });
      pane.replaceChildren(back, host);
      const { createEditor } = await import('./markdown-editor');
      editor = createEditor(host, md, { onUpdate: () => {}, onSelection: () => {} }, false);
    } else if (kind === 'one') {
      pane.replaceChildren(
        back,
        h(
          'p',
          { class: 'cal-text' },
          'A OneNote section cannot be previewed here. Choose Import to open it as an editable section, with its ink, text and pictures.',
        ),
      );
    } else {
      const pages = h('div', { class: 'bundle-pdf' });
      pane.replaceChildren(back, pages);
      await renderPdf(e.file, pages);
    }
  };

  const fill = () => {
    const sorted = [...b.entries].sort(byPath);
    list.replaceChildren(
      ...sorted.map((e) =>
        h(
          'button',
          {
            class: 'menu-item',
            'data-path': e.path,
            'aria-current': String(e.path === current),
            onclick: () => void show(e),
          },
          icon(kindOf(e.path) === 'image' ? ImageIcon : FileText, 16),
          h('span', {}, e.path),
        ),
      ),
    );
  };
  fill();

  const closeBtn = h('button', { class: 'tb-btn cal-close', 'aria-label': 'Close' }, icon(X, 18));
  const close = overlay(
    b.name,
    h(
      'header',
      { class: 'cal-head' },
      icon(FolderOpen, 18),
      h('span', { style: 'flex: 1' }, b.name),
      h(
        'button',
        {
          class: 'cal-btn',
          onclick: () => {
            close();
            void importBundle(b);
          },
        },
        'Import',
      ),
      closeBtn,
    ),
    card,
  );
  closeBtn.addEventListener('click', () => {
    editor?.destroy();
    close();
  });
  const first = [...b.entries].sort(byPath).find((e) => kindOf(e.path) === 'md') ?? b.entries[0];
  if (first && innerWidth > 700) void show(first);

  if (b.dir) {
    viewerRefresh = async () => {
      b.entries = await readDirHandle(b.dir!);
      fill();
      const e = b.entries.find((x) => x.path === current);
      if (e && e.modified !== shownModified) await show(e);
    };
    watch();
  }
}

async function renderPdf(file: Blob, into: HTMLElement) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const width = Math.max(320, into.clientWidth || 640);
  for (let n = 1; n <= doc.numPages && into.isConnected; n++) {
    const pg = await doc.getPage(n);
    const base = pg.getViewport({ scale: 1 });
    const view = pg.getViewport({ scale: (width / base.width) * devicePixelRatio });
    const canvas = h('canvas', { class: 'bundle-pdf-page' });
    canvas.width = Math.ceil(view.width);
    canvas.height = Math.ceil(view.height);
    into.append(canvas);
    await pg.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: view }).promise;
  }
}
