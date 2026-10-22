import { Bold, Italic, Minus, Plus, Trash2 } from 'lucide';
import { capture, clamp, h, icon } from './dom';
import { commitSnapshot, type Snapshot, snapshot } from './ink';
import { PALETTE, page, state, subscribe, type TextBox, type TextFont, uid, update } from './store';
import { FONTS, fontCss, inkColor } from './stroke';
import { colorName, shown } from './toolbar';
import { pageIsDark, penSeen, toWorld, view } from './viewport';

// Text boxes are real DOM elements on a layer that pans and zooms with the page, so typing,
// selection, IME and spellcheck all come from the browser. With the Text tool (T):
// tap empty canvas to add a box, tap a box to select it, double-tap to edit, drag to move,
// drag its right edge to change the wrap width.

const DEFAULT_SIZE = 20;
const DEFAULT_WIDTH = 260;
const TAP_SLOP = 6;

const layer = document.querySelector<HTMLDivElement>('#texts')!;
const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const els = new Map<string, { box: HTMLDivElement; body: HTMLDivElement }>();
let selectedId: string | null = null;
let editingId: string | null = null;
let editBefore: Snapshot | null = null;
let lastStyle: Pick<TextBox, 'font' | 'size' | 'bold' | 'italic'> = {
  font: 'sans',
  size: DEFAULT_SIZE,
  bold: false,
  italic: false,
};

const find = (id: string | null) => page().texts.find((t) => t.id === id);

/** Replace one box (texts are immutable, like strokes) and record it for undo. */
function change(id: string, patch: Partial<TextBox>, before = snapshot()) {
  const texts = page().texts.map((t) => (t.id === id ? { ...t, ...patch } : t));
  commitSnapshot(before, { strokes: page().strokes, texts });
}

function remove(id: string, before = snapshot()) {
  if (editingId === id) editingId = null;
  if (selectedId === id) selectedId = null;
  commitSnapshot(before, {
    strokes: page().strokes,
    texts: page().texts.filter((t) => t.id !== id),
  });
}

/** Editing inserts line breaks as <br>; only innerText turns those back into newlines. */
const readText = (el: HTMLElement) =>
  // biome-ignore lint/performance/useDomNodeTextContent: textContent drops <br> line breaks
  el.innerText.replace(/\n$/, '');

// --- Editing ---

function startEditing(id: string, before = snapshot()) {
  const el = els.get(id);
  if (!el) return;
  editingId = id;
  selectedId = id;
  editBefore = before;
  // 'plaintext-only' keeps pasted formatting out, but older Firefox throws on it.
  try {
    el.body.contentEditable = 'plaintext-only';
  } catch {
    el.body.contentEditable = 'true';
  }
  el.body.focus();
  const range = document.createRange();
  range.selectNodeContents(el.body);
  range.collapse(false);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  renderTexts();
}

function stopEditing() {
  const id = editingId;
  if (!id) return;
  const el = els.get(id);
  editingId = null;
  if (!el) return;
  el.body.contentEditable = 'false';
  const text = readText(el.body);
  const before = editBefore ?? snapshot();
  editBefore = null;
  const existedBefore = before.texts.some((t) => t.id === id);
  if (!text.trim()) {
    // An empty box disappears; if it was brand new, leave no trace in the undo history.
    if (existedBefore) remove(id, before);
    else
      update(() => {
        page().texts = page().texts.filter((t) => t.id !== id);
      });
    selectedId = null;
    return;
  }
  if (!existedBefore || text !== find(id)?.text) change(id, { text }, before);
  renderTexts();
}

function create(clientX: number, clientY: number) {
  const before = snapshot();
  const w = toWorld(clientX, clientY);
  const size = lastStyle.size;
  const t: TextBox = {
    id: uid(),
    x: w.x,
    y: w.y - (size * 1.3) / 2,
    w: DEFAULT_WIDTH / Math.max(view.scale, 0.25),
    text: '',
    color: state.styles.pen.color,
    ...lastStyle,
  };
  update(() => {
    page().texts = [...page().texts, t];
  });
  startEditing(t.id, before);
}

// --- Rendering ---

function makeBox(id: string) {
  const body = h('div', { class: 'tbox-body', spellcheck: true });
  const handle = h('div', { class: 'tbox-resize', 'aria-hidden': 'true' });
  const box = h('div', { class: 'tbox', 'data-id': id }, body, handle);
  body.addEventListener('blur', () => {
    if (editingId === id) stopEditing();
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') body.blur();
  });
  box.addEventListener('pointerdown', (e) => onBoxDown(e, id, box, false));
  handle.addEventListener('pointerdown', (e) => onBoxDown(e, id, box, true));
  return { box, body };
}

export function renderTexts() {
  document.body.dataset.tool = state.tool;
  const texts = page().texts;
  const ids = new Set(texts.map((t) => t.id));
  for (const [id, el] of els) {
    if (!ids.has(id)) {
      el.box.remove();
      els.delete(id);
    }
  }
  if (selectedId && !ids.has(selectedId)) selectedId = null;
  if (editingId && !ids.has(editingId)) editingId = null;
  const dark = pageIsDark();
  for (const t of texts) {
    let el = els.get(t.id);
    if (!el) {
      el = makeBox(t.id);
      els.set(t.id, el);
      layer.append(el.box);
    }
    el.box.style.cssText = `left:${t.x}px;top:${t.y}px;width:${t.w}px;font:${fontCss(t)};color:${inkColor(t.color, dark)}`;
    if (editingId !== t.id && readText(el.body) !== t.text) el.body.textContent = t.text;
    el.box.classList.toggle('selected', selectedId === t.id);
    el.box.classList.toggle('editing', editingId === t.id);
  }
  renderBar();
}

// --- Select, double-tap to edit, drag to move, drag the edge to resize ---

let lastTap = { id: '', t: 0 };

function onBoxDown(e: PointerEvent, id: string, box: HTMLDivElement, resizing: boolean) {
  if (state.tool !== 'text' || e.button !== 0) return;
  if (editingId === id && !resizing) return; // let the caret move
  e.stopPropagation();
  e.preventDefault();
  if (editingId) stopEditing();
  const t = find(id);
  if (!t) return;
  selectedId = id;
  renderTexts();
  capture(box, e.pointerId);
  const before = snapshot();
  const start = { x: e.clientX, y: e.clientY };
  let moved = false;
  const move = (m: PointerEvent) => {
    const dx = (m.clientX - start.x) / view.scale;
    const dy = (m.clientY - start.y) / view.scale;
    if (!moved && Math.hypot(m.clientX - start.x, m.clientY - start.y) < TAP_SLOP) return;
    moved = true;
    if (resizing) box.style.width = `${Math.max(40, t.w + dx)}px`;
    else {
      box.style.left = `${t.x + dx}px`;
      box.style.top = `${t.y + dy}px`;
    }
    positionBar();
  };
  const up = (u: PointerEvent) => {
    box.removeEventListener('pointermove', move);
    box.removeEventListener('pointerup', up);
    box.removeEventListener('pointercancel', up);
    if (moved) {
      const dx = (u.clientX - start.x) / view.scale;
      const dy = (u.clientY - start.y) / view.scale;
      change(id, resizing ? { w: Math.max(40, t.w + dx) } : { x: t.x + dx, y: t.y + dy }, before);
      return;
    }
    const now = performance.now();
    const double = lastTap.id === id && now - lastTap.t < 400;
    lastTap = { id, t: double ? 0 : now };
    if (double) startEditing(id);
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
}

// Tap on empty canvas: finish/deselect first, otherwise create a box there.
let downAt: { x: number; y: number; id: number } | null = null;
bg.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'text' || e.button !== 0) return;
  if (e.pointerType === 'touch' && penSeen) return; // fingers navigate once a pen is around
  downAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
bg.addEventListener('pointerup', (e) => {
  const d = downAt;
  downAt = null;
  if (!d || d.id !== e.pointerId || state.tool !== 'text') return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;
  if (editingId || selectedId) {
    if (editingId) els.get(editingId)?.body.blur();
    selectedId = null;
    renderTexts();
    return;
  }
  create(e.clientX, e.clientY);
});

addEventListener('keydown', (e) => {
  if (editingId || !selectedId || state.tool !== 'text') return;
  if (
    (e.target as HTMLElement).closest(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  )
    return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    remove(selectedId);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    startEditing(selectedId);
  } else if (e.key === 'Escape') {
    selectedId = null;
    renderTexts();
  }
});

// --- Format bar for the selected box ---

const bar = h('div', {
  class: 'textbar',
  role: 'toolbar',
  'aria-label': 'Text format',
  hidden: true,
});
document.body.append(bar);
// Keep focus in the text while using the bar, so editing continues.
bar.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
});

function style(patch: Partial<TextBox>) {
  if (!selectedId) return;
  lastStyle = { ...lastStyle, ...patch } as typeof lastStyle;
  // While typing, fold the style change into the same undo step as the typing.
  if (editingId === selectedId) {
    update(() => {
      page().texts = page().texts.map((t) => (t.id === selectedId ? { ...t, ...patch } : t));
    });
  } else change(selectedId, patch);
}

function renderBar() {
  const t = find(selectedId);
  const el = selectedId ? els.get(selectedId) : undefined;
  bar.hidden = !t || !el || state.tool !== 'text';
  if (bar.hidden || !t || !el) return;
  const fontBtns = (Object.keys(FONTS) as TextFont[]).map((f) =>
    h(
      'button',
      {
        class: 'seg',
        'aria-pressed': String(t.font === f),
        style: `font-family:${FONTS[f].css}`,
        onclick: () => style({ font: f }),
      },
      FONTS[f].label,
    ),
  );
  const toggle = (on: boolean, label: string, node: typeof Bold, patch: Partial<TextBox>) =>
    h(
      'button',
      {
        class: 'tb-btn',
        'aria-pressed': String(on),
        'aria-label': label,
        title: label,
        onclick: () => style(patch),
      },
      icon(node, 18),
    );
  bar.replaceChildren(
    h('div', { class: 'segmented fonts' }, ...fontBtns),
    h(
      'div',
      { class: 'size' },
      h(
        'button',
        {
          class: 'tb-btn',
          'aria-label': 'Smaller',
          onclick: () => style({ size: Math.max(8, t.size - 2) }),
        },
        icon(Minus, 16),
      ),
      h('output', { 'aria-label': 'Font size' }, String(Math.round(t.size))),
      h(
        'button',
        {
          class: 'tb-btn',
          'aria-label': 'Larger',
          onclick: () => style({ size: Math.min(200, t.size + 2) }),
        },
        icon(Plus, 16),
      ),
    ),
    toggle(t.bold, 'Bold', Bold, { bold: !t.bold }),
    toggle(t.italic, 'Italic', Italic, { italic: !t.italic }),
    h(
      'div',
      { class: 'colors' },
      ...PALETTE.slice(0, 8).map((c) =>
        h('button', {
          class: 'pal',
          style: `--c:${shown(c)}`,
          'aria-pressed': String(t.color === c),
          'aria-label': colorName(c),
          title: colorName(c),
          onclick: () => style({ color: c }),
        }),
      ),
    ),
    h(
      'button',
      {
        class: 'tb-btn danger',
        'aria-label': 'Delete text box',
        title: 'Delete (Del)',
        onclick: () => selectedId && remove(selectedId),
      },
      icon(Trash2, 18),
    ),
  );
  positionBar();
}

function positionBar() {
  const el = selectedId ? els.get(selectedId) : undefined;
  if (bar.hidden || !el) return;
  const r = el.box.getBoundingClientRect();
  const bh = bar.offsetHeight;
  const top = r.top - bh - 12 > 8 ? r.top - bh - 12 : r.bottom + 12;
  bar.style.top = `${clamp(top, 8, innerHeight - bh - 8)}px`;
  bar.style.left = `${clamp(r.left, 8, innerWidth - bar.offsetWidth - 8)}px`;
}

let shownTool = state.tool;
let shownPage = page().id;
subscribe(() => {
  if (state.tool !== shownTool || page().id !== shownPage) {
    if (editingId) els.get(editingId)?.body.blur();
    selectedId = null;
    shownTool = state.tool;
    shownPage = page().id;
  }
  renderTexts();
});
// Keep the bar glued to its box while panning and zooming.
new MutationObserver(() => {
  if (selectedId) positionBar();
}).observe(layer, { attributes: true, attributeFilter: ['style'] });
renderTexts();
