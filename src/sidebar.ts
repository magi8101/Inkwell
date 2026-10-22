import {
  Book,
  BookPlus,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide';
import { capture, h, icon, openMenu } from './dom';
import { imagesVersion, onImageLoaded } from './images';
import {
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
import { drawPage } from './viewport';

const aside = document.querySelector<HTMLElement>('#sidebar')!;
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

aside.append(
  h('header', { class: 'sb-head' }, nbBtn, closeBtn),
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

function rename(id: string, current: string, commit: (v: string) => void) {
  const label = list.querySelector<HTMLElement>(`[data-id="${id}"] .name`) ?? nbName;
  const input = h('input', { class: 'rename', value: current, 'aria-label': 'Name' });
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== current) commit(v);
    else input.replaceWith(label);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
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
    const pages = section().pages;
    pages.splice(pages.indexOf(page()) + 1, 0, p);
    s.pageId = p.id;
  });
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
  if (p.strokes.length) {
    const b = p.strokes
      .map(bbox)
      .reduce((a, k) => [
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

function sectionRow(sec: Section, i: number): HTMLElement {
  const nb = notebook();
  const row = h(
    'div',
    {
      class: 'row section',
      'data-id': sec.id,
      role: 'button',
      tabIndex: 0,
      'aria-current': sec.id === state.sectionId ? 'true' : null,
      onclick: () =>
        doubleTap(sec.id)
          ? renameSection(sec)
          : update((s) => {
              s.sectionId = sec.id;
            }),
      onkeydown: (e: KeyboardEvent) =>
        e.key === 'Enter' &&
        update((s) => {
          s.sectionId = sec.id;
        }),
    },
    h('span', { class: 'dot', style: `--c:${sec.color}` }),
    h('span', { class: 'name' }, sec.name),
    more('Section options', (e) =>
      openMenu(e.currentTarget as Element, [
        { label: 'Rename', icon: Pencil, run: () => renameSection(sec) },
        ...(nb.sections.length > 1
          ? [
              {
                label: 'Delete section',
                icon: Trash2,
                danger: true,
                run: () =>
                  update(() => {
                    nb.sections.splice(i, 1);
                  }),
              },
            ]
          : []),
      ]),
    ),
  );
  return row;
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
    thumb(p),
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
    const move = (m: PointerEvent) => {
      if (!dragging && Math.abs(m.clientY - startY) < 6) return;
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
        if (doubleTap(p.id)) renamePage(p);
        else
          update((s) => {
            s.pageId = p.id;
          });
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
        const haystack = [p.title, sec.name, nb.name, ...p.texts.map((t) => t.text)];
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
                }),
            },
            h('span', { class: 'name' }, p.title),
            h('small', {}, `${nb.name} › ${sec.name}`),
          ),
        );
      }
    }
  }
  return hits.length ? hits : [h('p', { class: 'empty' }, `Nothing matches “${q}”.`)];
}

const heading = (text: string, onAdd: () => void, addLabel: string) =>
  h(
    'div',
    { class: 'sb-label' },
    h('span', {}, text),
    h(
      'button',
      { class: 'add', 'aria-label': addLabel, title: addLabel, onclick: onAdd },
      icon(Plus, 18),
    ),
  );

function render() {
  aside.hidden = !state.sidebarOpen;
  openBtn.hidden = state.sidebarOpen;
  if (!state.sidebarOpen) return;
  nbName.textContent = notebook().name;
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
      'Sections',
      () =>
        update((s) => {
          const sec = newSection(`Section ${nb.sections.length + 1}`, nb.sections.length);
          nb.sections.push(sec);
          s.sectionId = sec.id;
        }),
      'New section',
    ),
    h('div', { class: 'sections' }, ...nb.sections.map(sectionRow)),
    heading('Pages', addPage, 'New page (Ctrl+N)'),
    ol,
  );
}

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
