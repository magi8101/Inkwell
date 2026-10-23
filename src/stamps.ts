import { Shapes as StampIcon, X } from 'lucide';
import { kvGet, kvPut } from './db';
import { h, icon, togglePopover } from './dom';
import type { ImageItem, Shape, Stroke, TextBox } from './store';

// Stamps: a selection kept for reuse (a diagram part, a symbol, a signature…). Saved from the
// selection bar's "Save as stamp"; used from Insert → Stamps, which puts a copy in the middle of
// the screen with the lasso on it. Kept on this device (IndexedDB), with a small preview.
// The selection code (lasso.ts) registers how to insert; this module knows nothing about the page.

export interface StampItems {
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  shapes: Shape[];
}
export interface Stamp {
  id: string;
  name: string;
  /** Items placed with their top-left box corner at (0, 0). */
  items: StampItems;
  w: number;
  h: number;
  /** A PNG data URL. */
  thumb: string;
}

const KEY = 'inkwell:stamps';
let stamps: Stamp[] | null = null;

const load = async () => (stamps ??= (await kvGet<Stamp[]>(KEY)) ?? []);

export async function addStamp(s: Stamp) {
  await load();
  stamps = [s, ...stamps!];
  await kvPut(KEY, stamps);
}

async function removeStamp(id: string) {
  await load();
  stamps = stamps!.filter((s) => s.id !== id);
  await kvPut(KEY, stamps);
}

let inserter: ((s: Stamp) => void) | null = null;
/** The selection code says how to put a stamp on the page. */
export const setInserter = (fn: (s: Stamp) => void) => {
  inserter = fn;
};

export function openStamps(anchor: Element) {
  const list = h('div', { class: 'stamp-grid' });
  const draw = async () => {
    const all = await load();
    list.replaceChildren(
      ...(all.length
        ? all.map((s) =>
            h(
              'div',
              { class: 'stamp' },
              h(
                'button',
                {
                  class: 'stamp-use',
                  title: `Insert “${s.name}”`,
                  'aria-label': `Insert ${s.name}`,
                  onclick: () => {
                    inserter?.(s);
                    close();
                  },
                },
                h('img', { src: s.thumb, alt: '' }),
                h('span', {}, s.name),
              ),
              h(
                'button',
                {
                  class: 'tb-btn stamp-del',
                  title: 'Delete this stamp',
                  'aria-label': `Delete ${s.name}`,
                  onclick: async () => {
                    await removeStamp(s.id);
                    await draw();
                  },
                },
                icon(X, 14),
              ),
            ),
          )
        : [
            h(
              'p',
              { class: 'panel-sub' },
              'No stamps yet. Select something with the lasso, then tap “Save as stamp” on its bar.',
            ),
          ]),
    );
  };
  const panel = h(
    'div',
    { class: 'style-panel stamp-panel' },
    h('div', { class: 'panel-title' }, icon(StampIcon, 16), ' Stamps'),
    list,
  );
  const close = togglePopover(anchor, panel);
  void draw();
}
