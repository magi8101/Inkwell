import { Keyboard, X } from 'lucide';
import { h, icon, keys } from './dom';

// The shortcut sheet: press ? (Shift+/) anywhere outside a text field, or open it from About. One
// list, here, so it can't drift from what the keys do (main.ts, lasso.ts, viewport.ts); the keys
// shown for Ctrl turn into ⌘ on a Mac.

const SECTIONS: [string, [string, string][]][] = [
  [
    'Tools',
    [
      ['P', 'Pen'],
      ['H', 'Highlighter'],
      ['E', 'Stroke eraser'],
      ['Shift+E', 'Pixel eraser'],
      ['L', 'Lasso select'],
      ['T', 'Text box'],
      ['R', 'Ruler and straight line'],
      ['O', 'Shapes'],
      ['K', 'Laser pointer'],
      ['S', 'Auto-snap shapes on or off'],
      ['[ and ]', 'Pen or eraser size'],
      ['Tab', 'Hide or show the toolbar'],
    ],
  ],
  [
    'Edit',
    [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Y or Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+C / X / V', 'Copy, cut, paste the selection'],
      ['Ctrl+D', 'Duplicate the selection'],
      ['Delete', 'Delete the selection'],
      ['Esc', 'Deselect'],
      ['Shift (while drawing a shape)', 'Square, circle or 15° line'],
    ],
  ],
  [
    'View',
    [
      ['Ctrl+wheel, Ctrl+= and Ctrl+-', 'Zoom'],
      ['Ctrl+0', 'Actual size (100%)'],
      ['Shift+1', 'Fit everything on screen'],
      ['Page Up / Page Down', 'Previous or next page'],
    ],
  ],
  [
    'Notebook',
    [
      ['Ctrl+N', 'New page'],
      ['Ctrl+F', 'Search notes'],
      ['Ctrl+\\', 'Show or hide the sidebar'],
      ['Ctrl+E', 'Export'],
      ['Ctrl+Shift+D', 'Pen feel and palm settings'],
      ['?', 'This list'],
    ],
  ],
];

let open: HTMLElement | null = null;

export function openShortcuts() {
  if (open) return;
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const close = () => {
    overlay.remove();
    open = null;
    removeEventListener('keydown', onKey);
  };
  const overlay = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      {
        class: 'cal-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Keyboard shortcuts',
      },
      h(
        'header',
        { class: 'cal-head' },
        icon(Keyboard, 18),
        h('span', { style: 'flex: 1' }, 'Keyboard shortcuts'),
        h(
          'button',
          { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: close },
          icon(X, 18),
        ),
      ),
      h(
        'div',
        { class: 'cal-body' },
        ...SECTIONS.flatMap(([title, rows]) => [
          h('h2', { class: 'cal-sub' }, title),
          h(
            'dl',
            { class: 'keys-list' },
            ...rows.flatMap(([k, what]) => [h('dt', {}, h('kbd', {}, keys(k))), h('dd', {}, what)]),
          ),
        ]),
      ),
    ),
  );
  open = overlay;
  document.body.append(overlay);
  addEventListener('keydown', onKey);
}

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable]')) return;
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    openShortcuts();
  }
});
