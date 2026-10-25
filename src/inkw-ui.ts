import { X } from 'lucide';
import { askPassword } from './backup-ui';
import { h, icon, toast } from './dom';
import { download } from './export';
import { blobOf, storePicture } from './images';
import {
  INKW_MIME,
  InkwError,
  isInkwLocked,
  readInkw,
  readInkwLocked,
  writeInkw,
  writeInkwLocked,
} from './inkw';
import { type BlobBytes, fromInkw, toInkw } from './inkw-model';
import { type Notebook, notebook, page, section, state, uid, update } from './store';

// Save and open .inkw files (docs/inkw-spec.md). What a file holds is recorded in its manifest
// (`extra.kind`): a page opens as a new page after the current one, a folder as a new folder in the
// current notebook, a notebook (or everything) as new notebooks. Nothing already in the app is ever
// replaced, and everything in a file is checked on the way in.

type Scope = 'page' | 'folder' | 'notebook' | 'all';

const getBlob = async (id: string): Promise<BlobBytes | null> => {
  const b = await blobOf(id);
  return b ? { type: b.type, bytes: new Uint8Array(await b.arrayBuffer()) } : null;
};

/** The notebooks to save for a scope, as a self-contained copy (folders and pages get a wrapper). */
function pick(scope: Scope): { name: string; notebooks: Notebook[] } {
  if (scope === 'all') return { name: 'All notebooks', notebooks: state.notebooks };
  if (scope === 'notebook')
    return { name: notebook().name, notebook: undefined, notebooks: [notebook()] } as never;
  if (scope === 'page') {
    const p = page();
    return {
      name: p.title,
      notebooks: [
        {
          id: uid(),
          name: p.title,
          sections: [{ id: uid(), name: 'Pages', color: '#3e63dd', pages: [p] }],
        },
      ],
    };
  }
  const root = section();
  const all = notebook().sections;
  const inside = new Set([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of all) {
      if (s.parent && inside.has(s.parent) && !inside.has(s.id)) {
        inside.add(s.id);
        grew = true;
      }
    }
  }
  const sections = all
    .filter((s) => inside.has(s.id))
    .map((s) => (s.id === root.id ? { ...s, parent: undefined } : s));
  return { name: root.name, notebooks: [{ id: uid(), name: root.name, sections }] };
}

const day = () => new Date().toISOString().slice(0, 10);
// A name every OS accepts: no path separators or reserved characters, no control characters.
const safeName = (s: string) =>
  [...s]
    .map((c) => (/[\\/:*?"<>|]/.test(c) || c.charCodeAt(0) < 32 ? '-' : c))
    .join('')
    .trim()
    .slice(0, 80) || 'Inkwell';

export async function saveInkw(scope: Scope, password: string, fileName?: string) {
  toast('Saving…', 60_000);
  try {
    const { name, notebooks } = pick(scope);
    const doc = await toInkw(notebooks, getBlob);
    doc.extra = { kind: scope === 'all' ? 'notebook' : scope };
    const { bytes, skipped } = password
      ? await writeInkwLocked(doc, password)
      : await writeInkw(doc);
    const file = `${safeName(fileName ?? name)} ${day()}.inkw`;
    if (await download(new Blob([bytes as BlobPart], { type: INKW_MIME }), file)) {
      const parts = [
        `Saved ${file} (${(bytes.length / 1e6).toFixed(1)} MB)${password ? ', locked' : ''}.`,
      ];
      if (skipped)
        parts.push(`${skipped} damaged stroke${skipped === 1 ? ' was' : 's were'} left out.`);
      if (doc.warnings.length)
        parts.push(
          `${doc.warnings.length} picture${doc.warnings.length === 1 ? ' was' : 's were'} missing.`,
        );
      toast(parts.join(' '), 6000);
    }
  } catch (e) {
    toast(`Couldn’t save: ${e instanceof InkwError ? e.message : (e as Error).message}`, 6000);
  }
}

/** The Save dialog: what to save, and an optional password. */
export function openSaveInkwDialog() {
  let scope: Scope = 'page';
  const options: [Scope, string][] = [
    ['page', 'This page'],
    ['folder', 'This folder'],
    ['notebook', 'This notebook'],
    ['all', 'Everything'],
  ];
  const btns = options.map(([v, label]) =>
    h(
      'button',
      {
        class: 'seg',
        onclick: () => {
          scope = v;
          sync();
        },
      },
      h('span', {}, label),
    ),
  );
  const sync = () => {
    for (const [i, b] of btns.entries())
      b.setAttribute('aria-pressed', String(options[i]![0] === scope));
  };
  sync();
  const pw = h('input', {
    class: 'share-url',
    type: 'password',
    autocomplete: 'off',
    placeholder: 'Password (optional)',
    'aria-label': 'Password',
  });
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'cal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Save as .inkw' },
      h(
        'header',
        { class: 'cal-head' },
        h('span', { style: 'flex: 1' }, 'Save as .inkw'),
        h(
          'button',
          { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: close },
          icon(X, 18),
        ),
      ),
      h(
        'div',
        { class: 'cal-body' },
        h(
          'p',
          { class: 'cal-text' },
          'One file that opens in Inkwell on any device, with pictures included. Open it with Insert → Inkwell file, or drop it on a page. A password locks it (there is no way to recover a lost one).',
        ),
        h('div', { class: 'segmented', style: 'grid-template-columns:repeat(2,1fr)' }, ...btns),
        pw,
        h(
          'div',
          { class: 'share-actions' },
          h(
            'button',
            {
              class: 'primary',
              onclick: () => {
                const p = pw.value;
                close();
                void saveInkw(scope, p);
              },
            },
            'Save',
          ),
        ),
      ),
    ),
  );
  document.body.append(overlay);
}

// --- Opening ---

/** Is this file a .inkw (locked or not), whatever it is called? */
export async function sniffInkw(f: File): Promise<boolean> {
  const b = new Uint8Array(await f.slice(0, 80).arrayBuffer());
  const text = (a: number, z: number) => new TextDecoder().decode(b.slice(a, z));
  return (
    isInkwLocked(b) ||
    (b[0] === 0x50 &&
      b[1] === 0x4b &&
      text(30, 38) === 'mimetype' &&
      text(38, 38 + INKW_MIME.length) === INKW_MIME)
  );
}
export const isInkwName = (f: File) => /\.inkw$/i.test(f.name);

export async function openInkw(file: File) {
  try {
    if (!(await sniffInkw(file))) {
      toast('That is not an Inkwell file (.inkw).', 4000);
      return;
    }
    toast('Opening…', 60_000);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let data: Awaited<ReturnType<typeof readInkw>>;
    if (isInkwLocked(bytes)) {
      const pw = await askPassword('Locked file', 'This file is locked. Type its password.', false);
      if (pw === null) return;
      data = await readInkwLocked(bytes, pw);
    } else data = await readInkw(bytes);
    const { notebooks, warnings } = await fromInkw(
      data,
      uid,
      async (b) => (await storePicture(new Blob([b.bytes as BlobPart], { type: b.type }))).blob,
      new Set(state.notebooks.map((n) => n.name)),
    );
    if (!notebooks.length) throw new InkwError('format', 'The file has no notebooks');
    const kind = data.extra.kind;
    const first = notebooks[0]!;
    let what: string;
    update((s) => {
      if (kind === 'page' && first.sections[0]?.pages.length) {
        const pages = first.sections[0].pages;
        const here = section().pages;
        here.splice(here.indexOf(page()) + 1, 0, ...pages);
        s.pageId = pages[0]!.id;
        what = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
      } else if (kind === 'folder' && first.sections.length) {
        notebook().sections.push(...first.sections);
        s.sectionId = first.sections[0]!.id;
        s.pageId = first.sections[0]!.pages[0]!.id;
        what = `the folder “${first.sections[0]!.name}”`;
      } else {
        s.notebooks.push(...notebooks);
        what = `${notebooks.length} notebook${notebooks.length === 1 ? '' : 's'}`;
      }
    });
    toast(
      `Opened ${what!}, added next to yours.${warnings.length ? ` ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings[0]}` : ''}`,
      warnings.length ? 8000 : 4000,
    );
  } catch (e) {
    toast(
      e instanceof InkwError
        ? e.code === 'password'
          ? 'Wrong password.'
          : `Couldn’t open: ${e.message}`
        : `Couldn’t open: ${(e as Error).message}`,
      6000,
    );
  }
}
