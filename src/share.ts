import { Link2, X } from 'lucide';
import { h, icon, SERVER, toast } from './dom';
import { blobOf, holdPicture, storePicture } from './images';
import {
  BACKGROUNDS,
  cleanCodes,
  cleanMd,
  cleanShapes,
  cleanStroke,
  cleanText,
  hex,
  num,
  PAPERS,
} from './sanitize';
import { decryptShare, encryptShare } from './share-crypto';
import {
  codeAsText,
  type ImageItem,
  newMarkdownPage,
  newPage,
  type Page,
  page,
  section,
  sheetOf,
  update,
} from './store';
import { contentBox, drawPage } from './viewport';

// Read-only share links (see worker/share.ts and share-crypto.ts). Creating one encrypts the page
// in this browser; the key goes only in the link's #fragment. Opening one (a /s/<id> address, with
// the key after #) fetches and decrypts it and shows the page read-only, with an option to keep a
// copy in the visitor's own notebook. What arrives is treated as untrusted data (sanitize.ts).

interface Mine {
  id: string;
  token: string;
  title: string;
  at: number;
}
const LIST = 'inkwell:shares';
const mine = (): Mine[] => {
  try {
    return JSON.parse(localStorage.getItem(LIST) ?? '[]');
  } catch {
    return [];
  }
};
const keep = (list: Mine[]) => {
  try {
    localStorage.setItem(LIST, JSON.stringify(list));
  } catch {
    // The links still work; they just can't be listed for deleting later.
  }
};

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

// --- Creating a link ---

async function payloadOf(p: Page) {
  const pictures: Record<string, { mime: string; data: string }> = {};
  const ids = new Set([...p.images.map((i) => i.blob), ...(p.backdrop ? [p.backdrop] : [])]);
  for (const id of ids) {
    const b = await blobOf(id);
    if (b) pictures[id] = { mime: b.type || 'image/png', data: await dataUrl(b) };
  }
  return {
    v: 1,
    title: p.title,
    page: {
      strokes: p.strokes,
      texts: p.texts,
      shapes: p.shapes ?? [],
      codes: p.codes ?? [],
      md: p.md,
      images: p.images,
      background: p.background,
      pageColor: p.pageColor,
      paper: p.paper,
      landscape: p.landscape,
      backdrop: p.backdrop,
    },
    pictures,
  };
}

async function createShare(p: Page) {
  const { bytes, key } = await encryptShare(await payloadOf(p));
  if (bytes.length > 6_000_000)
    throw new Error(
      'This page is too big to share (6 MB at most). Remove big pictures and try again.',
    );
  const res = await fetch(`${SERVER}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`The server said ${res.status}. Are you online?`);
  const { id, token } = (await res.json()) as { id: string; token: string };
  keep([{ id, token, title: p.title, at: Date.now() }, ...mine()]);
  return { id, token, url: `${SERVER}/s/${id}#${key}` };
}

async function deleteShare(s: Mine) {
  const res = await fetch(`${SERVER}/api/share/${s.id}`, {
    method: 'DELETE',
    headers: { 'x-share-token': s.token },
  });
  if (res.ok || res.status === 404) keep(mine().filter((x) => x.id !== s.id));
  else throw new Error(`The server said ${res.status}.`);
}

/** The dialog: make a link for this page, copy it, and delete links made from this browser. */
export function openShareDialog() {
  const p = page();
  const results = h('div', { class: 'share-results' });
  const list = h('div', { class: 'share-list' });
  const close = () => overlay.remove();
  const drawList = () => {
    const all = mine();
    list.replaceChildren(
      ...(all.length
        ? [
            h('h2', { class: 'cal-sub' }, 'Links you made on this device'),
            ...all.map((s) =>
              h(
                'div',
                { class: 'share-row' },
                h('span', {}, `${s.title} · ${new Date(s.at).toLocaleDateString()}`),
                h(
                  'button',
                  {
                    class: 'cal-btn',
                    onclick: async (e: Event) => {
                      const b = e.currentTarget as HTMLButtonElement;
                      b.disabled = true;
                      try {
                        await deleteShare(s);
                        toast('Link deleted: it no longer opens.', 2500);
                      } catch (err) {
                        toast((err as Error).message, 4000);
                      }
                      drawList();
                    },
                  },
                  'Delete',
                ),
              ),
            ),
          ]
        : []),
    );
  };
  const make = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        make.disabled = true;
        make.textContent = 'Encrypting and uploading…';
        try {
          const { url } = await createShare(p);
          const box = h('input', {
            class: 'share-url',
            readOnly: true,
            value: url,
            'aria-label': 'Link',
          });
          results.replaceChildren(
            h('p', { class: 'cal-text' }, 'Your link (anyone who has it can view the page):'),
            box,
            h(
              'div',
              { class: 'share-actions' },
              h(
                'button',
                {
                  class: 'cal-btn',
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('Link copied.', 1800);
                    } catch {
                      box.select();
                      toast('Press Ctrl+C to copy the link.', 2500);
                    }
                  },
                },
                'Copy link',
              ),
              ...(navigator.share
                ? [
                    h(
                      'button',
                      {
                        class: 'cal-btn',
                        onclick: () =>
                          void navigator.share({ title: p.title, url }).catch(() => {}),
                      },
                      'Share…',
                    ),
                  ]
                : []),
            ),
          );
          make.remove();
          drawList();
        } catch (err) {
          make.disabled = false;
          make.textContent = 'Create a read-only link';
          toast((err as Error).message, 5000);
        }
      },
    },
    'Create a read-only link',
  );
  const overlay = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      {
        class: 'cal-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Share a read-only link',
      },
      h(
        'header',
        { class: 'cal-head' },
        icon(Link2, 18),
        h('span', { style: 'flex: 1' }, 'Share a read-only link'),
        h(
          'button',
          { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: close },
          icon(X, 18),
        ),
      ),
      h(
        'div',
        { class: 'cal-body' },
        h(
          'p',
          { class: 'cal-text' },
          `“${p.title}” is encrypted in this browser before it is uploaded. The key is only in the link (the part after #), which browsers never send to a server, so nobody else, including the site's owner, can read it without the link. People can view it but not change it, or keep a copy. The link stops working after 30 days, or when you delete it here.`,
        ),
        make,
        results,
        list,
      ),
    ),
  );
  document.body.append(overlay);
  drawList();
}

// --- Opening a link ---

async function pageFrom(payload: unknown) {
  const d = payload as {
    title?: unknown;
    page?: Record<string, unknown>;
    pictures?: Record<string, { data?: unknown }>;
  };
  if (!d?.page || typeof d.page !== 'object') throw new Error('Not a share');
  const x = d.page;
  const title = typeof d.title === 'string' ? d.title.slice(0, 120) : 'Shared page';
  // Pictures: only ordinary raster formats, decoded in memory.
  const held = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  for (const [id, pic] of Object.entries(d.pictures ?? {}).slice(0, 200)) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp));base64,/i.exec(
      String(pic?.data ?? ''),
    );
    if (!m) continue;
    try {
      const blob = await (await fetch(String(pic.data))).blob();
      const heldId = await holdPicture(blob);
      held.set(id, heldId);
      blobs.set(heldId, blob);
    } catch {
      // A picture that can't be decoded is skipped.
    }
  }
  const md = cleanMd(x.md);
  const p = md === undefined ? newPage(title) : newMarkdownPage(title, md);
  p.strokes = (Array.isArray(x.strokes) ? x.strokes : [])
    .map(cleanStroke)
    .filter((s): s is NonNullable<typeof s> => !!s);
  p.texts = (Array.isArray(x.texts) ? x.texts : [])
    .map(cleanText)
    .filter((t): t is NonNullable<typeof t> => !!t);
  p.shapes = cleanShapes(x.shapes);
  p.codes = cleanCodes(x.codes);
  p.images = (Array.isArray(x.images) ? x.images : []).flatMap((im: ImageItem) =>
    im &&
    typeof im.id === 'string' &&
    [im.cx, im.cy, im.w, im.h, im.angle].every(num) &&
    held.has(im.blob)
      ? [
          {
            id: im.id.slice(0, 64),
            blob: held.get(im.blob)!,
            cx: im.cx,
            cy: im.cy,
            w: im.w,
            h: im.h,
            angle: im.angle,
          },
        ]
      : [],
  );
  if (BACKGROUNDS.includes(x.background as never))
    p.background = x.background as Page['background'];
  const backdrop = typeof x.backdrop === 'string' ? held.get(x.backdrop) : undefined;
  if (x.background === 'picture' && backdrop) {
    p.background = 'picture';
    p.backdrop = backdrop;
  }
  if (x.pageColor === 'auto' || hex(x.pageColor)) p.pageColor = x.pageColor as string;
  if (typeof x.paper === 'string' && PAPERS.includes(x.paper)) p.paper = x.paper as Page['paper'];
  if (x.landscape === true) p.landscape = true;
  return { title, page: p, blobs };
}

function viewer(title: string, p: Page, blobs: Map<string, Blob>) {
  document.title = `${title} — Inkwell`;
  const canvas = h('canvas', { class: 'share-canvas' });
  const body = h('div', { class: 'share-body' }, canvas);
  const close = () => {
    overlay.remove();
    history.replaceState(null, '', '/');
    document.title = 'Inkwell';
  };
  const copy = async () => {
    // Keep a copy: pictures go into this device's storage under new ids.
    const ids = new Map<string, string>();
    for (const [heldId, blob] of blobs) ids.set(heldId, (await storePicture(blob)).blob);
    const mapped: Page = {
      ...p,
      images: p.images.map((im) => ({ ...im, blob: ids.get(im.blob) ?? im.blob })),
      ...(p.backdrop ? { backdrop: ids.get(p.backdrop) ?? p.backdrop } : {}),
    };
    update((s) => {
      const pages = section().pages;
      pages.splice(pages.indexOf(page()) + 1, 0, mapped);
      s.pageId = mapped.id;
    });
    close();
    toast('Kept a copy in your notebook.', 2500);
  };
  const overlay = h(
    'div',
    { class: 'share-view', role: 'dialog', 'aria-label': `${title} (read-only)` },
    h(
      'header',
      { class: 'share-head' },
      h('strong', { class: 'share-title' }, title),
      h('span', { class: 'share-badge' }, 'Read-only'),
      h('button', { class: 'cal-btn', onclick: () => void copy() }, 'Keep a copy in Inkwell'),
      h('button', { class: 'tb-btn', 'aria-label': 'Close', onclick: close }, icon(X, 18)),
    ),
    body,
  );
  document.body.append(overlay);

  if (p.md !== undefined) {
    body.replaceChildren();
    const host = h('div', { class: 'md-body share-md' });
    body.append(host);
    void import('./markdown-editor').then(({ createEditor }) =>
      createEditor(host, p.md ?? '', { onUpdate: () => {}, onSelection: () => {} }, false),
    );
    return;
  }

  // Ink and shapes: one canvas, pan with a drag, zoom with a pinch or Ctrl+wheel, double-tap to fit.
  const shown: Page = p.codes?.length
    ? { ...p, texts: [...p.texts, ...p.codes.map(codeAsText)] }
    : p;
  const v = { x: 0, y: 0, scale: 1 };
  const draw = () => {
    const dpr = devicePixelRatio;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    drawPage(
      canvas.getContext('2d')!,
      canvas.width,
      canvas.height,
      shown,
      { x: v.x * dpr, y: v.y * dpr, scale: v.scale * dpr },
      dpr,
    );
  };
  const fit = () => {
    const sheet = sheetOf(shown);
    const b = sheet ? [0, 0, sheet[0], sheet[1]] : (contentBox(shown) ?? [0, 0, 800, 600]);
    const w = Math.max(1, b[2]! - b[0]!);
    const ht = Math.max(1, b[3]! - b[1]!);
    v.scale = Math.min(2, (canvas.clientWidth - 48) / w, (canvas.clientHeight - 48) / ht);
    v.x = (canvas.clientWidth - w * v.scale) / 2 - b[0]! * v.scale;
    v.y = (canvas.clientHeight - ht * v.scale) / 2 - b[1]! * v.scale;
    draw();
  };
  const zoomAt = (cx: number, cy: number, f: number) => {
    const s = Math.min(8, Math.max(0.05, v.scale * f));
    v.x = cx - ((cx - v.x) / v.scale) * s;
    v.y = cy - ((cy - v.y) / v.scale) * s;
    v.scale = s;
    draw();
  };
  const pointers = new Map<number, { x: number; y: number }>();
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  canvas.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const others = [...pointers.entries()].filter(([id]) => id !== e.pointerId).map(([, q]) => q);
    if (others.length) {
      const o = others[0]!;
      const before = Math.hypot(last.x - o.x, last.y - o.y);
      const after = Math.hypot(e.clientX - o.x, e.clientY - o.y);
      const r = canvas.getBoundingClientRect();
      if (before > 0)
        zoomAt((e.clientX + o.x) / 2 - r.left, (e.clientY + o.y) / 2 - r.top, after / before);
    } else {
      v.x += e.clientX - last.x;
      v.y += e.clientY - last.y;
      draw();
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  for (const t of ['pointerup', 'pointercancel'] as const)
    canvas.addEventListener(t, (e) => pointers.delete(e.pointerId));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      else {
        v.x -= e.deltaX;
        v.y -= e.deltaY;
        draw();
      }
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', fit);
  new ResizeObserver(draw).observe(canvas);
  fit();
  // Pictures decode a moment after they are held: draw again when they're ready.
  setTimeout(draw, 300);
}

function problem(text: string) {
  const overlay = h(
    'div',
    { class: 'share-view' },
    h('header', { class: 'share-head' }, h('strong', { class: 'share-title' }, 'Inkwell')),
    h(
      'div',
      { class: 'share-body share-msg' },
      h('p', {}, text),
      h(
        'button',
        {
          class: 'cal-btn',
          onclick: () => {
            overlay.remove();
            history.replaceState(null, '', '/');
          },
        },
        'Open Inkwell',
      ),
    ),
  );
  document.body.append(overlay);
}

/** If this address is a share link, show it. */
async function maybeOpen() {
  const id = /^\/s\/([a-z2-9]{12})$/.exec(location.pathname)?.[1];
  if (!id) return;
  const key = location.hash.slice(1);
  if (!key)
    return problem('This link is incomplete: the part after # is missing. Copy the whole address.');
  try {
    const res = await fetch(`${location.origin}/api/share/${id}`);
    if (res.status === 404) return problem('This link has expired or was deleted.');
    if (!res.ok) return problem('Couldn’t load this link. Check your connection and try again.');
    let payload: unknown;
    try {
      payload = await decryptShare(new Uint8Array(await res.arrayBuffer()), key);
    } catch {
      return problem(
        'Couldn’t open this link. It looks incomplete or changed: copy the whole address, including the part after #.',
      );
    }
    const { title, page: p, blobs } = await pageFrom(payload);
    viewer(title, p, blobs);
  } catch {
    problem('Couldn’t open this link.');
  }
}
void maybeOpen();
