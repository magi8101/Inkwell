import { ArrowUpRight, Circle, Diamond, Minus, RectangleHorizontal, Unlock } from 'lucide';
import { h, icon, toast } from './dom';
import { commitSnapshot, snapshot } from './ink';
import { type Shape, type ShapeKind, state, update } from './store';

// The Shapes tool's panel: what the next drag draws (rectangle, ellipse, diamond, line, arrow),
// how it's filled and stroked; colour and width come from the pen. Also unlocks locked shapes.

const KINDS: { id: ShapeKind; label: string; icon: typeof Circle }[] = [
  { id: 'rect', label: 'Rectangle', icon: RectangleHorizontal },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'diamond', label: 'Diamond', icon: Diamond },
  { id: 'line', label: 'Line', icon: Minus },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight },
];
const FILLS: { id: Shape['fill']; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'tint', label: 'Light' },
  { id: 'solid', label: 'Solid' },
  { id: 'hatch', label: 'Hatch' },
];
const DASHES: { id: Shape['dash']; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
];

export function shapePanel(): HTMLElement {
  const group = <T extends string>(
    title: string,
    options: { id: T; label: string; icon?: typeof Circle }[],
    get: () => T,
    set: (v: T) => void,
    cls = '',
  ) => {
    const btns = options.map((o) =>
      h(
        'button',
        {
          class: 'seg',
          title: o.label,
          'aria-label': o.label,
          onclick: () => {
            set(o.id);
            sync();
          },
        },
        o.icon ? icon(o.icon, 18) : null,
        h('span', {}, o.label),
      ),
    );
    const sync = () => {
      for (const [i, b] of btns.entries())
        b.setAttribute('aria-pressed', String(options[i]!.id === get()));
    };
    sync();
    return [
      h('div', { class: 'panel-sub' }, title),
      h('div', { class: `segmented ${cls}` }, ...btns),
    ];
  };

  const locked = (
    state.notebooks
      .flatMap((n) => n.sections.flatMap((s) => s.pages))
      .find((p) => p.id === state.pageId)?.shapes ?? []
  ).filter((s) => s.locked).length;
  const unlock = h(
    'button',
    {
      class: 'menu-item',
      onclick: () => {
        const before = snapshot();
        commitSnapshot(before, {
          strokes: before.strokes,
          texts: before.texts,
          shapes: (before.shapes ?? []).map(({ locked: _l, ...s }) => s as Shape),
        });
        unlock.remove();
        toast('Unlocked.', 1500);
      },
    },
    icon(Unlock, 18),
    h('span', {}, `Unlock all (${locked} locked)`),
  );

  return h(
    'div',
    { class: 'style-panel shape-panel' },
    h('div', { class: 'panel-title' }, 'Shapes'),
    ...group(
      'Shape',
      KINDS,
      () => state.shapeKind,
      (v) => update((s) => void (s.shapeKind = v)),
      'five',
    ),
    ...group(
      'Fill',
      FILLS,
      () => state.shapeFill,
      (v) => update((s) => void (s.shapeFill = v)),
    ),
    ...group(
      'Line',
      DASHES,
      () => state.shapeDash,
      (v) => update((s) => void (s.shapeDash = v)),
      'three',
    ),
    h(
      'p',
      { class: 'panel-sub' },
      'Drag to draw. Shift for squares, circles and 15° lines. Colour and width come from the pen.',
    ),
    locked ? unlock : null,
  );
}
