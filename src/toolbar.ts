import {
  BrushCleaning,
  Eraser,
  EyeOff,
  GripVertical,
  Highlighter,
  type IconNode,
  LassoSelect,
  Pen,
  Presentation,
  Redo2,
  Ruler,
  Shapes,
  StarPlus,
  Type,
  Undo2,
} from 'lucide';
import { capture, clamp, h, icon, toast, togglePopover } from './dom';
import { canRedo, canUndo, redo, undo } from './ink';
import { editStyle, inkTool, PALETTE, state, subscribe, type Tool, update } from './store';
import { BLACK, inkColor } from './stroke';
import { pageIsDark } from './viewport';

export const TOOLS: { id: Tool; label: string; key: string; icon: IconNode }[] = [
  { id: 'pen', label: 'Pen', key: 'P', icon: Pen },
  { id: 'highlighter', label: 'Highlighter', key: 'H', icon: Highlighter },
  { id: 'eraser', label: 'Stroke eraser', key: 'E', icon: Eraser },
  { id: 'pixelEraser', label: 'Pixel eraser', key: 'Shift+E', icon: BrushCleaning },
  { id: 'lasso', label: 'Lasso select', key: 'L', icon: LassoSelect },
  { id: 'text', label: 'Text box', key: 'T', icon: Type },
  { id: 'ruler', label: 'Ruler and straight line', key: 'R', icon: Ruler },
  { id: 'laser', label: 'Laser pointer', key: 'K', icon: Presentation },
];
const MAX_FAVORITES = 10;

/** Swatches show the colour the ink will actually be on this page (black turns white on dark pages). */
export const shown = (c: string) => inkColor(c, pageIsDark());
export const colorName = (c: string) =>
  c === BLACK ? 'Black (draws white on dark pages, black when printed)' : c;
const HEX = /^#?([0-9a-f]{6})$/i;

export const setTool = (t: Tool) =>
  update((s) => {
    s.tool = t;
  });
const isEraser = (t: Tool) => t === 'eraser' || t === 'pixelEraser';

const bar = document.querySelector<HTMLDivElement>('#toolbar')!;
const fab = document.querySelector<HTMLButtonElement>('#toolbar-fab')!;

const btn = (
  label: string,
  node: IconNode,
  onclick: () => void,
  extra: Record<string, unknown> = {},
) =>
  h(
    'button',
    { class: 'tb-btn', 'aria-label': label, title: label, onclick, ...extra },
    icon(node),
  );
const sep = () => h('span', { class: 'tb-sep', 'aria-hidden': 'true' });

const grip = h(
  'button',
  { class: 'tb-grip', 'aria-label': 'Move toolbar', title: 'Drag to move' },
  icon(GripVertical, 18),
);
const toolButtons = new Map<Tool, HTMLButtonElement>();
for (const t of TOOLS) {
  toolButtons.set(
    t.id,
    btn(t.label, t.icon, () => setTool(t.id), { title: `${t.label} (${t.key})` }),
  );
}
const snapBtn = btn(
  'Auto-snap shapes',
  Shapes,
  () =>
    update((s) => {
      s.snap = !s.snap;
    }),
  {
    title: 'Auto-snap shapes (S)',
  },
);
const undoBtn = btn('Undo', Undo2, undo, { title: 'Undo (Ctrl+Z)' });
const redoBtn = btn('Redo', Redo2, redo, { title: 'Redo (Ctrl+Y)' });
const swatchDot = h('span', { class: 'swatch-dot' });
const swatch = h(
  'button',
  {
    class: 'tb-btn tb-swatch',
    'aria-label': 'Colour and size',
    title: 'Colour and size ([ and ] change size)',
    onclick: () => togglePopover(swatch, stylePanel()),
  },
  swatchDot,
);
const favs = h('div', { class: 'tb-favs', role: 'group', 'aria-label': 'Favourite pens' });
// Adds a new pen (a copy of the current one) and selects it, like OneNote's "Add pen": colour and
// size changes then go into the new pen, never into the one it was copied from. Previously this
// refused when the pen matched an existing favourite — which, since edits save into the selected
// favourite, was always, so no new colour could ever be added.
const addFav = btn('Add a new pen', StarPlus, () => {
  if (state.favorites.length >= MAX_FAVORITES) {
    toast(`Up to ${MAX_FAVORITES} pens — remove one from its colour panel first.`, 3500);
    return;
  }
  update((s) => {
    const tool = inkTool(s.tool);
    s.favorites = [...s.favorites, { tool, ...s.styles[tool] }];
    s.activeFavorite = s.favorites.length - 1;
    if (isEraser(s.tool)) s.tool = tool;
  });
  toast('New pen added — pick its colour and size.', 2500);
  togglePopover(swatch, stylePanel());
});
const hideBtn = btn(
  'Hide toolbar',
  EyeOff,
  () =>
    update((s) => {
      s.toolbar.collapsed = true;
    }),
  {
    title: 'Hide toolbar (Tab)',
  },
);

bar.append(
  grip,
  ...toolButtons.values(),
  sep(),
  snapBtn,
  sep(),
  undoBtn,
  redoBtn,
  sep(),
  swatch,
  favs,
  addFav,
  sep(),
  hideBtn,
);
fab.addEventListener('click', () =>
  update((s) => {
    s.toolbar.collapsed = false;
  }),
);
fab.setAttribute('aria-label', 'Show toolbar');
fab.title = 'Show toolbar (Tab)';

function stylePanel(): HTMLElement {
  if (isEraser(state.tool)) {
    const out = h('output', {}, `${state.eraserWidth}px`);
    return h(
      'div',
      { class: 'style-panel' },
      h('div', { class: 'panel-title' }, 'Eraser'),
      h(
        'label',
        { class: 'slider' },
        h('span', {}, 'Size'),
        h('input', {
          type: 'range',
          min: 4,
          max: 120,
          value: state.eraserWidth,
          oninput: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            out.textContent = `${v}px`;
            update((s) => {
              s.eraserWidth = v;
            });
          },
        }),
        out,
      ),
    );
  }

  const tool = inkTool(state.tool);
  const st = () => state.styles[tool];
  const set = (patch: Partial<typeof state.styles.pen>) =>
    update((s) => {
      editStyle(s, tool, patch);
    });

  const preview = h('div', { class: 'stroke-preview' }, h('span'));
  const hex = h('input', {
    class: 'hex',
    type: 'text',
    maxLength: 7,
    spellcheck: false,
    'aria-label': 'Hex colour',
  });
  const picker = h('input', { type: 'color', 'aria-label': 'Custom colour' });
  const widthOut = h('output');
  const opacityOut = h('output');
  const width = h('input', { type: 'range', min: 0.5, max: 40, step: 0.5, 'aria-label': 'Width' });
  const opacity = h('input', { type: 'range', min: 5, max: 100, step: 5, 'aria-label': 'Opacity' });
  const swatches = PALETTE.map((c) =>
    h('button', {
      class: 'pal',
      'data-color': c,
      'aria-label': colorName(c),
      title: colorName(c),
      onclick: () => set({ color: c }),
    }),
  );

  const refresh = () => {
    const s = st();
    for (const b of swatches) {
      const c = b.dataset.color!;
      b.style.setProperty('--c', shown(c));
      b.setAttribute('aria-pressed', String(c === s.color));
    }
    if (document.activeElement !== hex) hex.value = s.color;
    hex.removeAttribute('aria-invalid');
    picker.value = s.color;
    width.value = String(s.width);
    opacity.value = String(Math.round(s.opacity * 100));
    widthOut.textContent = `${s.width}px`;
    opacityOut.textContent = `${Math.round(s.opacity * 100)}%`;
    preview.style.cssText = `--c:${shown(s.color)};--w:${Math.min(s.width, 32)}px;--o:${s.opacity}`;
  };

  hex.addEventListener('input', () => {
    const m = HEX.exec(hex.value.trim());
    if (m) set({ color: `#${m[1]!.toLowerCase()}` });
    else hex.setAttribute('aria-invalid', 'true');
  });
  hex.addEventListener('blur', refresh);
  // 'input' fires while dragging in the picker; some browsers' pickers only send 'change'.
  picker.addEventListener('input', () => set({ color: picker.value }));
  picker.addEventListener('change', () => set({ color: picker.value }));
  width.addEventListener('input', () => set({ width: Number(width.value) }));
  opacity.addEventListener('input', () => set({ opacity: Number(opacity.value) / 100 }));

  const panel = h(
    'div',
    { class: 'style-panel' },
    h(
      'div',
      { class: 'panel-title' },
      tool === 'pen' ? 'Pen' : 'Highlighter',
      state.activeFavorite !== null
        ? h('span', { class: 'panel-hint' }, ` · editing favourite ${state.activeFavorite + 1}`)
        : null,
    ),
    preview,
    h('div', { class: 'palette' }, ...swatches),
    h('div', { class: 'hex-row' }, picker, hex),
    h('label', { class: 'slider' }, h('span', {}, 'Width'), width, widthOut),
    h('label', { class: 'slider' }, h('span', {}, 'Opacity'), opacity, opacityOut),
    removePenButton(),
  );
  // Keep the open panel in step with shortcuts and favourites.
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

/** Touch devices have no right-click, so the selected pen can be removed from its panel. */
function removePenButton(): HTMLElement | null {
  const i = state.activeFavorite;
  if (i === null) return null;
  const label = h('span', {}, 'Remove this pen');
  const b = h(
    'button',
    {
      class: 'menu-item danger',
      onclick: () => {
        if (!b.dataset.armed) {
          b.dataset.armed = '1';
          label.textContent = 'Tap again to remove';
          return;
        }
        update((s) => {
          s.favorites.splice(i, 1);
          s.activeFavorite = null;
        });
        b.remove();
      },
    },
    label,
  );
  return b;
}

function renderFavorites() {
  favs.replaceChildren(
    ...state.favorites.map((f, i) => {
      const active = state.activeFavorite === i && !isEraser(state.tool);
      return h(
        'button',
        {
          class: `fav fav-${f.tool}`,
          style: `--c:${shown(f.color)};--o:${f.opacity};--w:${clamp(f.width, 3, 14)}px`,
          'aria-pressed': String(active),
          'aria-label': `${f.tool} ${f.color} ${f.width}px`,
          title: `${f.tool === 'pen' ? 'Pen' : 'Highlighter'} · ${f.width}px — tap the colour chip to edit, right-click to remove`,
          onclick: () =>
            update((s) => {
              s.tool = f.tool;
              s.styles[f.tool] = { color: f.color, width: f.width, opacity: f.opacity };
              s.activeFavorite = i;
            }),
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            update((s) => {
              s.favorites.splice(i, 1);
              if (s.activeFavorite === i) s.activeFavorite = null;
              else if (s.activeFavorite !== null && s.activeFavorite > i) s.activeFavorite--;
            });
          },
        },
        h('span'),
      );
    }),
  );
}

const stage = bar.parentElement!;

/** Positions are relative to the canvas area, which moves when the sidebar opens. */
function place(x: number, y: number) {
  const w = bar.offsetWidth;
  const ht = bar.offsetHeight;
  const left = x < 0 ? (stage.clientWidth - w) / 2 : x;
  bar.style.left = `${clamp(left, 8, stage.clientWidth - w - 8)}px`;
  bar.style.top = `${clamp(y, 8, stage.clientHeight - ht - 8)}px`;
}

grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture(grip, e.pointerId);
  const r = bar.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  bar.classList.add('dragging');
  const origin = stage.getBoundingClientRect();
  const move = (m: PointerEvent) =>
    place(m.clientX - origin.left - dx, m.clientY - origin.top - dy);
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    bar.classList.remove('dragging');
    update((s) => {
      s.toolbar.x = bar.offsetLeft;
      s.toolbar.y = bar.offsetTop;
    });
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});

function sync() {
  for (const [id, b] of toolButtons) b.setAttribute('aria-pressed', String(state.tool === id));
  snapBtn.setAttribute('aria-pressed', String(state.snap));
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
  const eraser = isEraser(state.tool);
  const st = state.styles[inkTool(state.tool)];
  // A fixed-size chip, so the current colour is always visible (width is shown in the panel).
  swatchDot.style.cssText = eraser
    ? '--c:transparent;--o:1'
    : `--c:${shown(st.color)};--o:${Math.max(st.opacity, 0.45)}`;
  swatchDot.classList.toggle('eraser', eraser);
  swatchDot.classList.toggle('highlighter', !eraser && inkTool(state.tool) === 'highlighter');
  swatch.title = eraser
    ? `Eraser size: ${state.eraserWidth}px`
    : `Colour ${colorName(st.color)}, ${st.width}px — tap to change ([ and ] change size)`;
  renderFavorites();
  bar.hidden = state.toolbar.collapsed;
  fab.hidden = !state.toolbar.collapsed;
  const tool = TOOLS.find((t) => t.id === state.tool)!;
  fab.replaceChildren(icon(tool.icon));
  if (!bar.hidden && !bar.classList.contains('dragging')) place(state.toolbar.x, state.toolbar.y);
}

subscribe(sync);
new ResizeObserver(() => place(state.toolbar.x, state.toolbar.y)).observe(stage);
sync();
