import { createElement, type IconNode } from 'lucide';

type Child = Node | string | null | undefined | false;

/** macOS users see ⌘ where the shortcut uses Cmd (Ctrl shortcuts accept either key). */
/** Inkwell's server (live sessions, online handwriting reading). The installed apps and file://
 * pages use the public site; the web app its own origin. */
export const SERVER =
  /^https?:$/.test(location.protocol) && !('__TAURI_INTERNALS__' in window)
    ? location.origin
    : 'https://inkwell.sharmamagi0.workers.dev';
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const keys = (s: string) =>
  IS_MAC ? s.replaceAll('Ctrl+', '⌘').replaceAll('Ctrl/Cmd', '⌘') : s;

/** Tiny element builder: `on*` props become listeners, known props are set, the rest are attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el: HTMLElement = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'title' || k === 'aria-label') {
      el.setAttribute(k, keys(String(v)));
    } else if (k in el) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c) el.append(typeof c === 'string' ? keys(c) : c);
  return el as HTMLElementTagNameMap[K];
}

export function icon(node: IconNode, size = 20): SVGElement {
  return createElement(node, {
    width: size,
    height: size,
    'stroke-width': 1.75,
    'aria-hidden': 'true',
  });
}

/** Pointer capture throws if the pointer is already gone; losing capture is harmless, a throw isn't. */
export function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer ended before we could capture it.
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let current: { anchor: Element; close: () => void } | null = null;

/** Opens a popover under `anchor`; tapping the same anchor again closes it. */
export function togglePopover(anchor: Element, content: HTMLElement): () => void {
  if (current?.anchor === anchor) {
    current.close();
    return () => {};
  }
  current?.close();
  const pop = h('div', { class: 'popover', role: 'dialog' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const gap = 8;
  let top = r.bottom + gap;
  if (top + pop.offsetHeight > innerHeight - gap) top = r.top - pop.offsetHeight - gap;
  pop.style.top = `${clamp(top, gap, innerHeight - pop.offsetHeight - gap)}px`;
  pop.style.left = `${clamp(r.left + r.width / 2 - pop.offsetWidth / 2, gap, innerWidth - pop.offsetWidth - gap)}px`;

  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !anchor.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    pop.remove();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    if (current?.close === close) current = null;
  }
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  current = { anchor, close };
  return close;
}

export interface MenuItem {
  label: string;
  icon: IconNode;
  run: () => void;
  danger?: boolean;
  checked?: boolean;
}

/** Popover menu. Danger items need a second tap instead of a modal confirm. */
export function openMenu(anchor: Element, items: (MenuItem | 'sep')[]) {
  const menu = h('div', { class: 'menu', role: 'menu' });
  let close = () => {};
  for (const it of items) {
    if (it === 'sep') {
      menu.append(h('hr'));
      continue;
    }
    const label = h('span', {}, it.label);
    const btn = h(
      'button',
      {
        class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`,
        role: 'menuitem',
        onclick: () => {
          if (it.danger && !btn.dataset.armed) {
            btn.dataset.armed = '1';
            label.textContent = 'Tap again to delete';
            return;
          }
          close();
          it.run();
        },
      },
      icon(it.icon, 18),
      label,
    );
    menu.append(btn);
  }
  close = togglePopover(anchor, menu);
}

/** Short non-blocking message at the bottom of the screen. */
export function toast(message: string, ms = 6000) {
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
