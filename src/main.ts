// First, so Linux pen input is fixed up before any other listener sees it (see linux-pen.ts).
import './linux-pen';
import './styles.css';
import {
  Columns2,
  FileText,
  Grid2x2,
  Grid3x3,
  Grip,
  Image as ImageIcon,
  Moon,
  Music,
  Rows3,
  Square,
  Sun,
  SunMoon,
} from 'lucide';
import { h, IS_MAC, icon, keys, toast, togglePopover } from './dom';
import { exportButton, openExport } from './export';
import { storePicture } from './images';
import { canRedo, canUndo, redo, undo } from './ink';
import { insertButton } from './insert';
import { liveButton } from './live';
import { openRadial } from './radial';
import { addPage, search } from './sidebar';
import {
  type Background,
  editStyle,
  onSaveError,
  type Paper,
  page,
  state,
  subscribe,
  type Tool,
  update,
} from './store';
import './lasso';
import './shape-tool';
import './shortcuts';
import './laser';
import './text';
import './markdown';
import './ink-index';
import './update';
import { setTool } from './toolbar';
import { openTuning, tuneButton } from './tune';
import { actualSize, fitContent, penNear, resetView, zoomBy } from './viewport';

// --- Corner controls: page style and theme ---
const BACKGROUNDS: { id: Background; label: string; icon: typeof Square }[] = [
  { id: 'blank', label: 'Blank', icon: Square },
  { id: 'grid', label: 'Grid', icon: Grid3x3 },
  { id: 'dots', label: 'Dots', icon: Grip },
  { id: 'lines', label: 'Lines', icon: Rows3 },
];
/** Ruled layouts for a sheet of paper; "Picture" uses the page's own background picture. */
const TEMPLATE_BUTTONS: { id: Background; label: string; icon: typeof Square }[] = [
  { id: 'cornell', label: 'Cornell', icon: Columns2 },
  { id: 'staff', label: 'Music', icon: Music },
  { id: 'graph', label: 'Graph', icon: Grid2x2 },
  { id: 'picture', label: 'Picture', icon: ImageIcon },
];
const PAGE_COLORS = [
  { c: 'auto', label: 'Match theme' },
  { c: '#ffffff', label: 'White' },
  { c: '#fbf7ee', label: 'Paper' },
  { c: '#eef3f8', label: 'Mist' },
  { c: '#26272b', label: 'Slate' },
  { c: '#101012', label: 'Black' },
];
const SIZES: { id: Paper | 'infinite'; label: string }[] = [
  { id: 'infinite', label: 'Infinite' },
  { id: 'a4', label: 'A4' },
  { id: 'a3', label: 'A3' },
  { id: 'letter', label: 'Letter' },
];
const THEMES = { system: SunMoon, light: Sun, dark: Moon } as const;
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' } as const;

function pagePanel(): HTMLElement {
  const bgButtons = BACKGROUNDS.map((b) =>
    h(
      'button',
      {
        class: 'seg',
        'aria-label': b.label,
        title: b.label,
        onclick: () =>
          update(() => {
            page().background = b.id;
          }),
      },
      icon(b.icon, 18),
      h('span', {}, b.label),
    ),
  );
  const colorButtons = PAGE_COLORS.map((p) =>
    h('button', {
      class: `pal page-color${p.c === 'auto' ? ' auto' : ''}`,
      style: `--c:${p.c === 'auto' ? 'var(--page)' : p.c}`,
      'aria-label': p.label,
      title: p.label,
      onclick: () =>
        update(() => {
          page().pageColor = p.c;
        }),
    }),
  );
  // Paper: an infinite canvas, or a sheet of a real size (exported to PDF at that size).
  const sizeButtons = SIZES.map((z) =>
    h(
      'button',
      {
        class: 'seg',
        onclick: () => {
          update(() => {
            const p = page();
            if (z.id === 'infinite') delete p.paper;
            else p.paper = z.id;
          });
          resetView(); // show the new sheet
        },
      },
      h('span', {}, z.label),
    ),
  );
  const turnButtons = (['portrait', 'landscape'] as const).map((o) =>
    h(
      'button',
      {
        class: 'seg',
        onclick: () => {
          update(() => {
            page().landscape = o === 'landscape';
          });
          resetView();
        },
      },
      h('span', {}, o === 'portrait' ? 'Portrait' : 'Landscape'),
    ),
  );
  const turnRow = h('div', { class: 'segmented two' }, ...turnButtons);
  // Templates need a sheet, so picking one puts an infinite page on A4.
  const useTemplate = (id: Background) => {
    update(() => {
      const p = page();
      p.background = id;
      p.paper ??= 'a4';
    });
    resetView();
  };
  const backdropInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  backdropInput.addEventListener('change', async () => {
    const file = backdropInput.files?.[0];
    backdropInput.value = '';
    if (!file) return;
    try {
      const { blob } = await storePicture(file);
      update(() => {
        const p = page();
        p.backdrop = blob;
        p.background = 'picture';
        p.paper ??= 'a4';
      });
      resetView();
    } catch {
      toast('Couldn’t read that picture.', 3000);
    }
  });
  const templateButtons = TEMPLATE_BUTTONS.map((tb) =>
    h(
      'button',
      {
        class: 'seg',
        onclick: () => (tb.id === 'picture' ? backdropInput.click() : useTemplate(tb.id)),
      },
      icon(tb.icon, 18),
      h('span', {}, tb.label),
    ),
  );
  const refresh = () => {
    const paper = page().paper ?? 'infinite';
    for (const [i, z] of SIZES.entries())
      sizeButtons[i]!.setAttribute('aria-pressed', String(paper === z.id));
    turnRow.hidden = paper === 'infinite';
    for (const [i, b] of turnButtons.entries())
      b.setAttribute('aria-pressed', String(!!page().landscape === (i === 1)));
    for (const [i, b] of BACKGROUNDS.entries()) {
      bgButtons[i]!.setAttribute('aria-pressed', String(page().background === b.id));
    }
    for (const [i, tb] of TEMPLATE_BUTTONS.entries()) {
      templateButtons[i]!.setAttribute('aria-pressed', String(page().background === tb.id));
    }
    for (const [i, p] of PAGE_COLORS.entries()) {
      colorButtons[i]!.setAttribute('aria-pressed', String(page().pageColor === p.c));
    }
  };
  const panel = h(
    'div',
    { class: 'style-panel' },
    h('div', { class: 'panel-title' }, 'Page'),
    h('div', { class: 'segmented' }, ...bgButtons),
    h('div', { class: 'panel-sub' }, 'Template'),
    h('div', { class: 'segmented' }, ...templateButtons),
    backdropInput,
    h('div', { class: 'panel-sub' }, 'Colour'),
    h('div', { class: 'palette page-colors' }, ...colorButtons),
    h('div', { class: 'panel-sub' }, 'Size'),
    h('div', { class: 'segmented' }, ...sizeButtons),
    turnRow,
  );
  const unsub = subscribe(refresh);
  new MutationObserver((_, obs) => {
    if (!panel.isConnected) {
      unsub();
      obs.disconnect();
    }
  }).observe(document.body, { childList: true });
  refresh();
  return panel;
}

const pageBtn = h(
  'button',
  { class: 'tb-btn', 'aria-label': 'Page style', title: 'Page style' },
  icon(FileText),
);
pageBtn.addEventListener('click', () => togglePopover(pageBtn, pagePanel()));
const themeBtn = h('button', {
  class: 'tb-btn',
  onclick: () =>
    update((s) => {
      s.theme = NEXT_THEME[s.theme];
    }),
});
document
  .querySelector('#corner')!
  .append(liveButton, insertButton, exportButton, tuneButton, pageBtn, themeBtn);
const syncTheme = () => {
  themeBtn.replaceChildren(icon(THEMES[state.theme]));
  themeBtn.title = `Theme: ${state.theme}`;
  themeBtn.setAttribute('aria-label', `Theme: ${state.theme}`);
};
subscribe(syncTheme);
syncTheme();

// --- Finger tap chords from the canvas: two fingers undo, three redo, with visible feedback ---
document.querySelector('#bg')!.addEventListener('tapgesture', (e) => {
  const fingers = (e as CustomEvent<number>).detail;
  if (fingers === 2) {
    if (!canUndo()) return toast('Nothing to undo.', 1200);
    undo();
    toast('Undone · tap with three fingers to redo', 1500);
  } else {
    if (!canRedo()) return toast('Nothing to redo.', 1200);
    redo();
    toast('Redone', 1200);
  }
});

// --- Radial menu: pen barrel button or right-click on the canvas ---
const canvas = document.querySelector<HTMLCanvasElement>('#bg')!;
let lastDownType = '';
canvas.addEventListener('pointerdown', (e) => {
  lastDownType = e.pointerType;
  // 'Menu only' keeps the old behaviour: the ring opens as soon as the side button touches down.
  if (e.pointerType === 'pen' && e.button === 2 && state.tuning.sideButton === 'menu') {
    openRadial(e.clientX, e.clientY);
  }
});
// Otherwise a quick, still side-button press is a tap (from ink.ts) and opens the ring there.
canvas.addEventListener('barreltap', (e) => {
  const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
  openRadial(x, y);
});
addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault(); // also kills Windows' press-and-hold right-click
  if (t === canvas && lastDownType === 'mouse' && !penNear(e.timeStamp))
    openRadial(e.clientX, e.clientY);
});

// --- Keyboard shortcuts ---
const TOOL_KEYS: Record<string, Tool> = {
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  E: 'pixelEraser',
  l: 'lasso',
  t: 'text',
  r: 'ruler',
  k: 'laser',
  o: 'shape',
};
addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, [contenteditable]')) return;
  if (e.ctrlKey || e.metaKey) {
    const actions: Record<string, () => void> = {
      '\\': () =>
        update((s) => {
          s.sidebarOpen = !s.sidebarOpen;
        }),
      f: () => {
        update((s) => {
          s.sidebarOpen = true;
        });
        search.focus();
      },
      n: addPage,
      // Cmd+Shift+Z reports a lowercase 'z' on macOS, so check Shift rather than the letter case.
      z: () => (e.shiftKey ? redo() : undo()),
      Z: redo,
      y: redo,
      D: openTuning,
      e: openExport,
      '0': actualSize,
      '=': () => zoomBy(1.25),
      '+': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
    };
    // Fall back to physical keys: on some layouts Ctrl/Cmd changes what e.key reports for +/-/0.
    const byCode: Record<string, string> = {
      Equal: '=',
      NumpadAdd: '+',
      Minus: '-',
      NumpadSubtract: '-',
      Digit0: '0',
      Numpad0: '0',
    };
    const run = actions[e.key] ?? actions[byCode[e.code] ?? ''];
    if (run) {
      e.preventDefault();
      run();
    }
    return;
  }
  if (e.shiftKey && e.code === 'Digit1') {
    e.preventDefault();
    fitContent();
  } else if (e.key === 'Tab' && target === document.body) {
    e.preventDefault();
    update((s) => {
      s.toolbar.collapsed = !s.toolbar.collapsed;
    });
  } else if (TOOL_KEYS[e.key]) {
    setTool(TOOL_KEYS[e.key]!);
  } else if (e.key === 's') {
    update((s) => {
      s.snap = !s.snap;
    });
  } else if (e.key === '[' || e.key === ']') {
    const d = e.key === ']' ? 1 : -1;
    update((s) => {
      if (s.tool === 'eraser' || s.tool === 'pixelEraser') {
        s.eraserWidth = Math.min(120, Math.max(4, s.eraserWidth + d * 4));
      } else {
        const tool = s.tool === 'highlighter' ? 'highlighter' : 'pen';
        const w = s.styles[tool].width;
        editStyle(s, tool, { width: Math.min(40, Math.max(0.5, w + d * (w < 4 ? 0.5 : 2))) });
      }
    });
  }
});

onSaveError(() =>
  toast(
    'Couldn’t save — browser storage is full or blocked. Recent changes will be lost on reload.',
    10000,
  ),
);

// Offline-first web build: cache the app after the first visit. Skipped in dev (stale modules)
// and in the desktop app, whose files are already on disk.
const secure = location.protocol === 'https:' || location.hostname === 'localhost';
if (import.meta.env.PROD && secure && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Static tooltips in index.html get the same ⌘ treatment as built elements.
if (IS_MAC)
  for (const el of document.querySelectorAll('[title]'))
    el.setAttribute('title', keys(el.getAttribute('title')!));
