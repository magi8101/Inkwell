import './styles.css';
import { FileText, Grid3x3, Grip, Moon, Rows3, Square, Sun, SunMoon } from 'lucide';
import { h, icon, toast, togglePopover } from './dom';
import { exportButton, openExport } from './export';
import { canRedo, canUndo, redo, undo } from './ink';
import { openRadial } from './radial';
import { addPage, search } from './sidebar';
import { type Background, onSaveError, page, state, subscribe, type Tool, update } from './store';
import './lasso';
import './laser';
import './text';
import { setTool } from './toolbar';
import { openTuning, tuneButton } from './tune';
import { penNear, resetView, zoomBy } from './viewport';

// --- Corner controls: page style and theme ---
const BACKGROUNDS: { id: Background; label: string; icon: typeof Square }[] = [
  { id: 'blank', label: 'Blank', icon: Square },
  { id: 'grid', label: 'Grid', icon: Grid3x3 },
  { id: 'dots', label: 'Dots', icon: Grip },
  { id: 'lines', label: 'Lines', icon: Rows3 },
];
const PAGE_COLORS = [
  { c: 'auto', label: 'Match theme' },
  { c: '#ffffff', label: 'White' },
  { c: '#fbf7ee', label: 'Paper' },
  { c: '#eef3f8', label: 'Mist' },
  { c: '#26272b', label: 'Slate' },
  { c: '#101012', label: 'Black' },
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
  const refresh = () => {
    for (const [i, b] of BACKGROUNDS.entries()) {
      bgButtons[i]!.setAttribute('aria-pressed', String(page().background === b.id));
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
    h('div', { class: 'panel-sub' }, 'Colour'),
    h('div', { class: 'palette page-colors' }, ...colorButtons),
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
document.querySelector('#corner')!.append(exportButton, tuneButton, pageBtn, themeBtn);
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
  if (e.pointerType === 'pen' && e.button === 2) openRadial(e.clientX, e.clientY);
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
      z: undo,
      Z: redo,
      y: redo,
      D: openTuning,
      e: openExport,
      '0': resetView,
      '=': () => zoomBy(1.25),
      '+': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
    };
    const run = actions[e.key];
    if (run) {
      e.preventDefault();
      run();
    }
    return;
  }
  if (e.key === 'Tab' && target === document.body) {
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
        const st = s.styles[s.tool === 'highlighter' ? 'highlighter' : 'pen'];
        st.width = Math.min(40, Math.max(0.5, st.width + d * (st.width < 4 ? 0.5 : 2)));
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
