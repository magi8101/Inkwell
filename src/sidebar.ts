import {
  Book,
  BookPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  FileType,
  Folder,
  FolderDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSync,
  FolderX,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide';
import { capture, h, icon, openMenu } from './dom';
import { imageBox, imagesVersion, onImageLoaded } from './images';
import { addMarkdownNote } from './markdown';
import {
  childFolders,
  folderPath,
  folderTree,
  type Notebook,
  newNotebook,
  newPage,
  newSection,
  notebook,
  type Page,
  page,
  type Section,
  section,
  state,
  subscribe,
  uid,
  update,
  whenIdle,
} from './store';
import { bbox } from './stroke';
import {
  forgetFolder,
  onVaultChange,
  openFolder,
  reconnect,
  saveToFolder,
  vault,
  vaultSupported,
} from './vault';
import { drawPage } from './viewport';

const aside = document.querySelector<HTMLElement>('#sidebar')!;
// On phones and tablets the sidebar slides over the page (see styles.css): it starts closed, and
// closes after a page is picked or the page is touched.
const narrow = matchMedia('(max-width: 960px), (max-height: 500px)');
if (narrow.matches) state.sidebarOpen = false;
const closeIfNarrow = (s: typeof state) => {
  if (narrow.matches) s.sidebarOpen = false;
};
document.querySelector('#stage')!.addEventListener(
  'pointerdown',
  () => {
    if (narrow.matches && state.sidebarOpen) update(closeIfNarrow);
  },
  { capture: true },
);
const openBtn = document.querySelector<HTMLButtonElement>('#sidebar-open')!;

const nbName = h('span', { class: 'nb-name' });
const nbBtn = h(
  'button',
  { class: 'nb-switch', title: 'Switch notebook', onclick: notebookMenu },
  icon(Book, 18),
  nbName,
  icon(ChevronDown, 16),
);
const closeBtn = h(
  'button',
  {
    class: 'tb-btn',
    'aria-label': 'Hide sidebar',
    title: 'Hide sidebar (Ctrl+\\)',
    onclick: () =>
      update((s) => {
        s.sidebarOpen = false;
      }),
  },
  icon(PanelLeftClose),
);
export const search = h('input', {
  type: 'search',
  placeholder: 'Search notes',
  'aria-label': 'Search notes',
  spellcheck: false,
  oninput: () =>
    update((s) => {
      s.query = search.value;
    }),
});
const list = h('div', { class: 'sb-scroll' });

// Which folder on disk the notebook is saved in (or a button to reconnect it after a restart).
const vaultLine = h('div', { class: 'sb-vault' });
onVaultChange(() => update(() => {}));

aside.append(
  h('header', { class: 'sb-head' }, nbBtn, closeBtn),
  vaultLine,
  h('label', { class: 'sb-search' }, icon(Search, 16), search),
  list,
);
openBtn.append(icon(PanelLeft));
openBtn.addEventListener('click', () =>
  update((s) => {
    s.sidebarOpen = true;
  }),
);

// Selecting re-renders the list, so native dblclick never sees two clicks on one node.
let lastTap = { id: '', t: 0 };
function doubleTap(id: string): boolean {
  const now = performance.now();
  const hit = lastTap.id === id && now - lastTap.t < 400;
  lastTap = { id, t: hit ? 0 : now };
  return hit;
}

/**
 * While a name is being typed the lists must not be redrawn: a redraw replaces the input, which
 * closes the on-screen keyboard (the first tap of a double-tap queues one, as do thumbnails
 * loading and saves). Redraws wait here and run when the rename is over.
 */
let renaming = false;
let redrawAfterRename = false;

function rename(id: string, current: string, commit: (v: string) => void) {
  const label = list.querySelector<HTMLElement>(`[data-id="${id}"] .name`) ?? nbName;
  const input = h('input', {
    class: 'rename',
    value: current,
    'aria-label': 'Name',
    enterKeyHint: 'done',
    autocomplete: 'off',
    spellcheck: false,
  });
  label.replaceWith(input);
  renaming = true;
  input.focus();
  // Selecting the whole name straight after focusing makes touch screens flash their selection
  // handles and close the keyboard; there the caret goes to the end instead.
  if (matchMedia('(pointer: coarse)').matches)
    input.setSelectionRange(current.length, current.length);
  else input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    renaming = false;
    const v = input.value.trim();
    if (save && v && v !== current) commit(v);
    else input.replaceWith(label);
    if (redrawAfterRename) {
      redrawAfterRename = false;
      render();
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  // Taps in the box are for the box: not a tap (or double-tap) on the folder row behind it.
  for (const type of ['pointerdown', 'click', 'dblclick'] as const)
    input.addEventListener(type, (e) => e.stopPropagation());
}

const renamePage = (p: Page) =>
  rename(p.id, p.title, (v) =>
    update(() => {
      p.title = v;
    }),
  );
const renameSection = (s: Section) =>
  rename(s.id, s.name, (v) =>
    update(() => {
      s.name = v;
    }),
  );

export function addPage() {
  update((s) => {
    const p = newPage();
    // A new page comes on the same paper as the one it follows (like a notebook's pages).
    const { paper, landscape } = page();
    if (paper) Object.assign(p, { paper, landscape });
    const pages = section().pages;
    pages.splice(pages.indexOf(page()) + 1, 0, p);
    s.pageId = p.id;
  });
}

function folderItems() {
  if (!vaultSupported) return [];
  const v = vault();
  if (v?.notebookId === state.notebookId) {
    return [
      ...(v.connected
        ? []
        : [
            {
              label: `Reconnect folder “${v.name}”`,
              icon: FolderSync,
              run: () => void reconnect(),
            },
          ]),
      { label: 'Stop saving to the folder', icon: FolderX, run: () => void forgetFolder() },
    ];
  }
  return [
    { label: 'Open a folder as a notebook…', icon: FolderOpen, run: () => void openFolder() },
    { label: 'Save this notebook to a folder…', icon: FolderDown, run: () => void saveToFolder() },
  ];
}

function renderVault() {
  const v = vault();
  vaultLine.hidden = !v || v.notebookId !== state.notebookId;
  if (vaultLine.hidden || !v) return;
  vaultLine.replaceChildren(
    v.connected
      ? h('span', { title: 'Changes save to this folder on disk' }, icon(Folder, 14), v.name)
      : h(
          'button',
          { class: 'reconnect', onclick: () => void reconnect() },
          icon(FolderSync, 14),
          `Reconnect folder “${v.name}”`,
        ),
  );
}

function notebookMenu() {
  openMenu(nbBtn, [
    ...state.notebooks.map((n) => ({
      label: n.name,
      icon: n.id === state.notebookId ? Check : Book,
      checked: n.id === state.notebookId,
      run: () =>
        update((s) => {
          s.notebookId = n.id;
        }),
    })),
    'sep',
    {
      label: 'New notebook',
      icon: BookPlus,
      run: () =>
        update((s) => {
          const n = newNotebook(`Notebook ${s.notebooks.length + 1}`);
          s.notebooks.push(n);
          s.notebookId = n.id;
        }),
    },
    ...folderItems(),
    {
      label: 'Rename notebook',
      icon: Pencil,
      run: () =>
        rename('', notebook().name, (v) =>
          update(() => {
            notebook().name = v;
          }),
        ),
    },
    ...(state.notebooks.length > 1
      ? [
          {
            label: 'Delete notebook',
            icon: Trash2,
            danger: true,
            run: () =>
              update((s) => {
                s.notebooks = s.notebooks.filter((n) => n.id !== s.notebookId);
              }),
          },
        ]
      : []),
  ]);
}

/** Fits the page's ink into a small preview; empty pages show their top-left corner. */
// Thumbnails are redrawn only when what they show changes (strokes are replaced, never mutated).
const thumbs = new Map<string, { key: unknown[]; canvas: HTMLCanvasElement }>();

function thumb(p: Page): HTMLCanvasElement {
  const key = [
    p.strokes,
    p.images,
    imagesVersion, // a picture finished loading since this thumbnail was drawn
    p.background,
    p.pageColor,
    document.documentElement.dataset.theme,
    devicePixelRatio,
  ];
  const hit = thumbs.get(p.id);
  if (hit?.key.every((k, i) => k === key[i])) return hit.canvas;
  const c = h('canvas', { class: 'thumb', 'aria-hidden': 'true' });
  thumbs.set(p.id, { key, canvas: c });
  const dpr = devicePixelRatio;
  c.width = 72 * dpr;
  c.height = 52 * dpr;
  let v = { x: 4 * dpr, y: 4 * dpr, scale: 0.3 * dpr };
  if (p.strokes.length || p.images.length) {
    // Ink and pictures (a PDF page is a picture) together.
    const b = [...p.strokes.map(bbox), ...p.images.map(imageBox)].reduce((a, k) => [
      Math.min(a[0], k[0]),
      Math.min(a[1], k[1]),
      Math.max(a[2], k[2]),
      Math.max(a[3], k[3]),
    ]);
    const scale = Math.min(0.3, 64 / (b[2] - b[0] || 1), 44 / (b[3] - b[1] || 1)) * dpr;
    v = {
      x: (c.width - (b[2] - b[0]) * scale) / 2 - b[0] * scale,
      y: (c.height - (b[3] - b[1]) * scale) / 2 - b[1] * scale,
      scale,
    };
  }
  drawPage(c.getContext('2d')!, c.width, c.height, p, v, dpr);
  return c;
}

const more = (label: string, onclick: (e: Event) => void) =>
  h(
    'button',
    {
      class: 'more',
      'aria-label': label,
      title: label,
      onclick: (e: Event) => {
        e.stopPropagation();
        onclick(e);
      },
      onpointerdown: (e: Event) => e.stopPropagation(),
    },
    icon(Ellipsis, 18),
  );

const select = (sec: Section) =>
  update((s) => {
    s.sectionId = sec.id;
  });

/** Menu of folders to move into (never into itself or a folder inside it). */
function moveMenu(
  anchor: Element,
  nb: Notebook,
  moving: Section | null,
  run: (to: Section | null) => void,
) {
  const blocked = new Set(moving ? folderTree(nb, moving).map((x) => x.id) : []);
  const targets = nb.sections.filter((x) => !blocked.has(x.id));
  openMenu(anchor, [
    ...(moving?.parent ? [{ label: 'Top level', icon: Book, run: () => run(null) }] : []),
    ...targets.map((x) => ({
      label: folderPath(nb, x).join(' › '),
      icon: Folder,
      checked: moving ? x.id === moving.parent : x.id === state.sectionId,
      run: () => run(x),
    })),
  ]);
}

function folderRow(sec: Section, depth: number): HTMLElement {
  const nb = notebook();
  const kids = childFolders(nb, sec.id);
  const toggle = h(
    'button',
    {
      class: 'twisty',
      'aria-label': sec.collapsed ? 'Expand folder' : 'Collapse folder',
      'aria-expanded': String(!sec.collapsed),
      onclick: (e: Event) => {
        e.stopPropagation();
        update(() => {
          sec.collapsed = !sec.collapsed;
        });
      },
      onpointerdown: (e: Event) => e.stopPropagation(),
    },
    icon(sec.collapsed ? ChevronRight : ChevronDown, 16),
  );
  return h(
    'div',
    {
      class: 'row section',
      'data-id': sec.id,
      role: 'button',
      tabIndex: 0,
      style: `--depth:${depth}`,
      'aria-current': sec.id === state.sectionId ? 'true' : null,
      onclick: () => (doubleTap(sec.id) ? renameSection(sec) : select(sec)),
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && select(sec),
    },
    kids.length ? toggle : h('span', { class: 'twisty' }),
    h('span', { class: 'dot', style: `--c:${sec.color}` }),
    h('span', { class: 'name' }, sec.name),
    more('Folder options', (e) =>
      openMenu(e.currentTarget as Element, [
        { label: 'Rename', icon: Pencil, run: () => renameSection(sec) },
        {
          label: 'New folder inside',
          icon: FolderPlus,
          run: () =>
            update((s) => {
              const sub = { ...newSection('New folder', nb.sections.length), parent: sec.id };
              nb.sections.push(sub);
              sec.collapsed = false;
              s.sectionId = sub.id;
            }),
        },
        {
          label: 'Move to…',
          icon: FolderInput,
          run: () =>
            moveMenu(row(sec.id) ?? aside, nb, sec, (to) =>
              update(() => {
                if (to) {
                  sec.parent = to.id;
                  to.collapsed = false;
                } else delete sec.parent;
              }),
            ),
        },
        // A folder takes everything inside it with it; the last folder can't go.
        ...(nb.sections.length > folderTree(nb, sec).length
          ? [
              {
                label: kids.length ? 'Delete folder and its folders' : 'Delete folder',
                icon: Trash2,
                danger: true,
                run: () =>
                  update(() => {
                    const gone = new Set(folderTree(nb, sec).map((x) => x.id));
                    nb.sections = nb.sections.filter((x) => !gone.has(x.id));
                  }),
              },
            ]
          : []),
      ]),
    ),
  );
}

const row = (id: string) => list.querySelector<HTMLElement>(`[data-id="${id}"]`);

/** The folder tree: each folder, then (unless collapsed) the folders inside it. */
function tree(nb: Notebook, parent?: string, depth = 0): HTMLElement[] {
  return childFolders(nb, parent).flatMap((sec) => [
    folderRow(sec, depth),
    ...(sec.collapsed ? [] : tree(nb, sec.id, depth + 1)),
  ]);
}

/** Moves a page to the end of another folder and follows it there. */
function movePage(p: Page, to: Section) {
  update((s) => {
    const from = notebook().sections.find((x) => x.pages.includes(p));
    if (!from || from === to) return;
    from.pages.splice(from.pages.indexOf(p), 1);
    to.pages.push(p);
    s.sectionId = to.id;
    s.pageId = p.id;
  });
}

function pageRow(p: Page, i: number, ol: HTMLElement): HTMLElement {
  const sec = section();
  const li = h(
    'li',
    {
      class: 'row page',
      'data-id': p.id,
      tabIndex: 0,
      'aria-current': p.id === state.pageId ? 'true' : null,
      onkeydown: (e: KeyboardEvent) =>
        e.key === 'Enter' &&
        update((s) => {
          s.pageId = p.id;
        }),
    },
    h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)),
    p.md === undefined
      ? thumb(p)
      : h('span', { class: 'thumb md-thumb', 'aria-hidden': 'true' }, icon(FileType, 20)),
    h('span', { class: 'name' }, p.title),
    more('Page options', (e) =>
      openMenu(e.currentTarget as Element, [
        { label: 'Rename', icon: Pencil, run: () => renamePage(p) },
        {
          label: 'Duplicate',
          icon: Copy,
          run: () =>
            update((s) => {
              const copy = { ...structuredClone(p), id: uid(), title: `${p.title} (copy)` };
              sec.pages.splice(i + 1, 0, copy);
              s.pageId = copy.id;
            }),
        },
        {
          label: 'Move to folder…',
          icon: FolderInput,
          run: () => moveMenu(li, notebook(), null, (to) => to && movePage(p, to)),
        },
        {
          label: 'Delete page',
          icon: Trash2,
          danger: true,
          run: () =>
            update(() => {
              sec.pages.splice(i, 1);
            }),
        },
      ]),
    ),
  );

  // Tap selects, drag reorders; works the same for pen, finger and mouse.
  li.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    const items = [...ol.children] as HTMLElement[];
    let dragging = false;
    let slot = i;
    capture(li, e.pointerId);
    let into: HTMLElement | null = null; // folder row under the dragged page
    const move = (m: PointerEvent) => {
      if (!dragging && Math.abs(m.clientY - startY) < 6) return;
      li.style.pointerEvents = 'none';
      const over = document
        .elementFromPoint(m.clientX, m.clientY)
        ?.closest<HTMLElement>('.row.section');
      li.style.pointerEvents = '';
      into?.classList.remove('drop');
      into = over && over.dataset.id !== sec.id ? over : null;
      into?.classList.add('drop');
      dragging = true;
      li.classList.add('dragging');
      li.style.transform = `translateY(${m.clientY - startY}px)`;
      slot = items.filter((it, k) => {
        if (k === i) return false;
        const r = it.getBoundingClientRect();
        return r.top + r.height / 2 < m.clientY;
      }).length;
    };
    const up = () => {
      li.removeEventListener('pointermove', move);
      li.removeEventListener('pointerup', up);
      li.removeEventListener('pointercancel', up);
      if (!dragging) {
        // The rename starts from the click that follows this tap, not from here: the phone's
        // keyboard only opens for a focus made inside a click, and an input focused here loses
        // focus again when that click lands.
        if (doubleTap(p.id)) {
          const go = () => renamePage(p);
          li.addEventListener('click', go, { once: true });
          setTimeout(() => li.removeEventListener('click', go), 600); // no click came (cancelled)
        } else
          update((s) => {
            s.pageId = p.id;
            closeIfNarrow(s);
          });
        return;
      }
      li.style.transform = '';
      li.classList.remove('dragging');
      const target = into && notebook().sections.find((x) => x.id === into!.dataset.id);
      into?.classList.remove('drop');
      if (target) {
        movePage(p, target);
        return;
      }
      update(() => {
        sec.pages.splice(i, 1);
        sec.pages.splice(slot, 0, p);
      });
    };
    li.addEventListener('pointermove', move);
    li.addEventListener('pointerup', up);
    li.addEventListener('pointercancel', up);
  });
  return li;
}

function results(q: string): HTMLElement[] {
  const needle = q.toLowerCase();
  const hits: HTMLElement[] = [];
  for (const nb of state.notebooks) {
    for (const sec of nb.sections) {
      for (const p of sec.pages) {
        const haystack = [
          p.title,
          ...folderPath(nb, sec),
          nb.name,
          ...p.texts.map((t) => t.text),
          ...(p.codes ?? []).map((c) => c.code),
          p.md ?? '',
        ];
        if (!haystack.some((t) => t.toLowerCase().includes(needle))) continue;
        hits.push(
          h(
            'button',
            {
              class: 'row result',
              onclick: () =>
                update((s) => {
                  s.notebookId = nb.id;
                  s.sectionId = sec.id;
                  s.pageId = p.id;
                  closeIfNarrow(s);
                  // Open the folders it's in, so it shows in the tree.
                  for (let up = nb.sections.find((x) => x.id === sec.parent); up; ) {
                    up.collapsed = false;
                    const parent = up.parent;
                    up = nb.sections.find((x) => x.id === parent);
                  }
                }),
            },
            h('span', { class: 'name' }, p.title),
            h('small', {}, [nb.name, ...folderPath(nb, sec)].join(' › ')),
          ),
        );
      }
    }
  }
  return hits.length ? hits : [h('p', { class: 'empty' }, `Nothing matches “${q}”.`)];
}

const heading = (text: string, onAdd: () => void, addLabel: string, extra?: HTMLElement) =>
  h(
    'div',
    { class: 'sb-label' },
    h('span', {}, text),
    extra,
    h(
      'button',
      { class: 'add', 'aria-label': addLabel, title: addLabel, onclick: onAdd },
      icon(Plus, 18),
    ),
  );
const addNoteBtn = h(
  'button',
  {
    class: 'add',
    'aria-label': 'New Markdown note',
    title: 'New Markdown note (typed, formats as you type)',
    onclick: () => {
      addMarkdownNote();
      update(closeIfNarrow); // on phones, out of the way so the note can be typed in
    },
  },
  icon(FileType, 18),
);

function render() {
  aside.hidden = !state.sidebarOpen;
  openBtn.hidden = state.sidebarOpen;
  if (!state.sidebarOpen) return;
  if (renaming) {
    redrawAfterRename = true;
    return;
  }
  nbName.textContent = notebook().name;
  renderVault();
  const q = state.query.trim();
  if (q) {
    list.replaceChildren(h('div', { class: 'sb-label' }, h('span', {}, 'Results')), ...results(q));
    return;
  }
  const nb = notebook();
  const ol = h('ol', { class: 'pages' });
  ol.append(...section().pages.map((p, i) => pageRow(p, i, ol)));
  list.replaceChildren(
    heading(
      'Folders',
      () =>
        update((s) => {
          const sec = newSection(`Folder ${nb.sections.length + 1}`, nb.sections.length);
          nb.sections.push(sec);
          s.sectionId = sec.id;
        }),
      'New folder',
    ),
    h('div', { class: 'sections', role: 'tree' }, ...tree(nb)),
    heading(
      'Pages',
      () => {
        addPage();
        update(closeIfNarrow);
      },
      'New page (Ctrl+N)',
      addNoteBtn,
    ),
    ol,
  );
}

// Page "3 / 12" in the corner of the canvas, with previous/next.
const pager = document.querySelector<HTMLElement>('#pager')!;
const goPage = (step: number) =>
  update((s) => {
    const pages = section().pages;
    const i = pages.findIndex((p) => p.id === s.pageId) + step;
    if (pages[i]) s.pageId = pages[i]!.id;
  });
const prevBtn = h(
  'button',
  {
    class: 'tb-btn',
    'aria-label': 'Previous page',
    title: 'Previous page (Page Up)',
    onclick: () => goPage(-1),
  },
  icon(ChevronLeft, 18),
);
const nextBtn = h(
  'button',
  {
    class: 'tb-btn',
    'aria-label': 'Next page',
    title: 'Next page (Page Down)',
    onclick: () => goPage(1),
  },
  icon(ChevronRight, 18),
);
const pageNo = h('output', { class: 'page-no', 'aria-live': 'polite' });
pager.append(prevBtn, pageNo, nextBtn);
function renderPager() {
  const pages = section().pages;
  const i = pages.findIndex((p) => p.id === state.pageId);
  pageNo.textContent = `${i + 1} / ${pages.length}`;
  pageNo.title = `Page ${i + 1} of ${pages.length} in “${section().name}”`;
  prevBtn.disabled = i <= 0;
  nextBtn.disabled = i >= pages.length - 1;
}
addEventListener('keydown', (e) => {
  if ((e.key !== 'PageUp' && e.key !== 'PageDown') || e.ctrlKey || e.metaKey) return;
  if (
    (e.target as HTMLElement).closest(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  )
    return;
  e.preventDefault();
  goPage(e.key === 'PageUp' ? -1 : 1);
});
subscribe(renderPager);
renderPager();

// Showing and hiding is instant (waiting for idle made the hide button feel broken); opening fills
// the lists straight away, since they weren't kept up to date while hidden.
let shown = state.sidebarOpen;
subscribe(() => {
  aside.hidden = !state.sidebarOpen;
  openBtn.hidden = state.sidebarOpen;
  if (state.sidebarOpen && !shown) render();
  shown = state.sidebarOpen;
});

// The sidebar (lists and thumbnails) refreshes when idle, so it never delays the pen.
onImageLoaded(() => update(() => {}));
let renderPending = false;
subscribe(() => {
  if (renderPending) return;
  renderPending = true;
  whenIdle(() => {
    renderPending = false;
    render();
  });
});
render();
