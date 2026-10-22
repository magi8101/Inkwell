import { X } from 'lucide';
import { clamp, h, icon } from './dom';
import { inkTool, PALETTE, state, update } from './store';
import { setTool, TOOLS } from './toolbar';

const INNER = 72;
const OUTER = 124;
let close: (() => void) | null = null;

const at = (r: number, i: number, n: number) => {
  const a = (i / n) * Math.PI * 2 - Math.PI / 2;
  return `--x:${Math.cos(a) * r}px;--y:${Math.sin(a) * r}px`;
};

/** Ring menu at the pen tip: tools inside, colours outside. One tap picks and closes. */
export function openRadial(x: number, y: number) {
  close?.();
  const cx = clamp(x, OUTER + 24, innerWidth - OUTER - 24);
  const cy = clamp(y, OUTER + 24, innerHeight - OUTER - 24);
  const pick = (fn: () => void) => () => {
    fn();
    close?.();
  };
  const ring = h(
    'div',
    { class: 'radial', role: 'menu', style: `left:${cx}px;top:${cy}px` },
    h(
      'button',
      { class: 'radial-center', 'aria-label': 'Close', onclick: () => close?.() },
      icon(X, 18),
    ),
    ...TOOLS.map((t, i) =>
      h(
        'button',
        {
          class: 'radial-btn',
          role: 'menuitemradio',
          style: at(INNER, i, TOOLS.length),
          'aria-checked': String(state.tool === t.id),
          'aria-label': t.label,
          title: t.label,
          onclick: pick(() => setTool(t.id)),
        },
        icon(t.icon),
      ),
    ),
    ...PALETTE.map((c, i) =>
      h('button', {
        class: 'radial-color',
        role: 'menuitemradio',
        style: `${at(OUTER, i, PALETTE.length)};--c:${c}`,
        'aria-checked': String(state.styles[inkTool(state.tool)].color === c),
        'aria-label': c,
        onclick: pick(() =>
          update((s) => {
            if (s.tool !== 'highlighter') s.tool = 'pen';
            s.styles[inkTool(s.tool)].color = c;
          }),
        ),
      }),
    ),
  );
  const onDown = (e: PointerEvent) => {
    if (!ring.contains(e.target as Node)) close?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close?.();
  };
  close = () => {
    ring.remove();
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('keydown', onKey, true);
    close = null;
  };
  document.body.append(ring);
  // Defer so the opening press doesn't immediately count as an outside tap.
  requestAnimationFrame(() => {
    addEventListener('pointerdown', onDown, true);
    addEventListener('keydown', onKey, true);
  });
}
