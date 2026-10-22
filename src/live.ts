import { Copy, LogOut, Radio, Users } from 'lucide';
import { h, icon, SERVER, toast, togglePopover } from './dom';
import {
  type Background,
  type Notebook,
  newPage,
  newSection,
  notebook,
  type Page,
  page,
  type Stroke,
  state,
  subscribe,
  type TextBox,
  update,
} from './store';
import { FONTS } from './stroke';
import { toScreen, toWorld } from './viewport';

// Live sessions: draw on one note together. The creator starts a session and gets a code; others
// join with the code (website, desktop app or APK), each under an anonymous name, and everyone can
// draw. The session lasts while the creator stays; everyone keeps their own copy of the note.
// The relay is the Cloudflare Worker (worker/index.ts).

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
const BATCH_BYTES = 200_000;

interface Peer {
  id: string;
  name: string;
  color: string;
  host: boolean;
}
interface Session {
  ws: WebSocket;
  code: string;
  host: boolean;
  me: Peer | null;
  peers: Map<string, Peer>;
  /** The shared note: the host's page, or each guest's own copy. */
  pageId: string;
  /** What the others already have, to send only changes. */
  sent: { strokes: Stroke[]; texts: TextBox[]; meta: string };
  ended: boolean;
}
let session: Session | null = null;
let applying = false;

const pretty = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;
const newCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    (b) => CODE_CHARS[b % CODE_CHARS.length],
  ).join('');

function findPage(nb: Notebook, id: string): Page | undefined {
  for (const sec of nb.sections) for (const p of sec.pages) if (p.id === id) return p;
}
const sharedPage = () => {
  if (!session) return undefined;
  for (const nb of state.notebooks) {
    const p = findPage(nb, session.pageId);
    if (p) return p;
  }
};
const metaOf = (p: Page) => JSON.stringify({ background: p.background, pageColor: p.pageColor });

// --- What others send is data: keep only well-formed strokes and text boxes ---

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
function cleanStroke(s: unknown): Stroke | null {
  const x = s as Stroke;
  if (!x || typeof x.id !== 'string' || x.id.length > 64) return null;
  if (x.tool !== 'pen' && x.tool !== 'highlighter') return null;
  if (!hex(x.color) || !num(x.width) || !num(x.opacity) || typeof x.pressure !== 'boolean')
    return null;
  if (!Array.isArray(x.points) || x.points.length % 3 || !x.points.every(num)) return null;
  return {
    id: x.id,
    tool: x.tool,
    color: x.color,
    width: x.width,
    opacity: x.opacity,
    pressure: x.pressure,
    points: x.points,
  };
}
function cleanText(t: unknown): TextBox | null {
  const x = t as TextBox;
  if (!x || typeof x.id !== 'string' || typeof x.text !== 'string' || !(x.font in FONTS))
    return null;
  if (![x.x, x.y, x.w, x.size].every(num) || !hex(x.color)) return null;
  return {
    id: x.id,
    x: x.x,
    y: x.y,
    w: x.w,
    text: x.text.slice(0, 20_000),
    font: x.font,
    size: x.size,
    color: x.color,
    bold: !!x.bold,
    italic: !!x.italic,
    ...(num(x.angle) ? { angle: x.angle } : {}),
  };
}
const BACKGROUNDS: Background[] = ['blank', 'dots', 'grid', 'lines'];

// --- Sending ---

function send(msg: object) {
  if (session?.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
}
function sendStrokes(strokes: Stroke[]) {
  let batch: Stroke[] = [];
  let size = 0;
  for (const s of strokes) {
    const n = s.points.length * 8 + 200;
    if (batch.length && size + n > BATCH_BYTES) {
      send({ t: 'add', strokes: batch });
      batch = [];
      size = 0;
    }
    batch.push(s);
    size += n;
  }
  if (batch.length) send({ t: 'add', strokes: batch });
}

/** After any change: send what changed on the shared note (by stroke object, so moves count). */
subscribe(() => {
  if (!session?.me || applying) return;
  const p = sharedPage();
  if (!p) return;
  const { sent } = session;
  if (p.strokes !== sent.strokes) {
    const before = new Set(sent.strokes);
    const ids = new Set(p.strokes.map((s) => s.id));
    sendStrokes(p.strokes.filter((s) => !before.has(s)));
    const removed = sent.strokes.filter((s) => !ids.has(s.id)).map((s) => s.id);
    if (removed.length) send({ t: 'remove', ids: removed });
    sent.strokes = p.strokes;
  }
  if (p.texts !== sent.texts) {
    send({ t: 'texts', texts: p.texts });
    sent.texts = p.texts;
  }
  const meta = metaOf(p);
  if (meta !== sent.meta) {
    send({ t: 'meta', meta: JSON.parse(meta) });
    sent.meta = meta;
  }
});

/** Changes from others, applied without echoing them back. */
function applyRemote(fn: (p: Page) => void) {
  const p = sharedPage();
  if (!p || !session) return;
  applying = true;
  try {
    update(() => fn(p));
  } finally {
    applying = false;
  }
  session.sent = { strokes: p.strokes, texts: p.texts, meta: metaOf(p) };
}

// --- Receiving ---

function receive(raw: string) {
  if (!session) return;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const s = session;
  switch (m.t) {
    case 'error': {
      s.ended = true;
      s.ws.close();
      session = null;
      changed();
      if (m.reason === 'taken' && s.host)
        start(); // that code is in use: pick another
      else if (m.reason === 'full') toast('That session is full.', 3500);
      else
        toast(
          `No live session with code ${pretty(s.code)}. Check the code, or ask its creator to start it.`,
          5000,
        );
      return;
    }
    case 'welcome': {
      s.me = m.you as Peer;
      for (const p of (m.peers as Peer[]) ?? []) s.peers.set(p.id, p);
      if (s.host) {
        // Hand the note over: settings, text, then the strokes in size-limited batches.
        const p = sharedPage()!;
        send({ t: 'meta', meta: JSON.parse(metaOf(p)) });
        send({ t: 'texts', texts: p.texts });
        sendStrokes(p.strokes);
        s.sent = { strokes: p.strokes, texts: p.texts, meta: metaOf(p) };
        toast(`Live session started. Others join with code ${pretty(s.code)}.`, 5000);
      } else {
        // The guest's own copy of the note, in a "Live sessions" folder.
        const copy = newPage(`Live ${pretty(s.code)}`);
        copy.texts = ((m.texts as unknown[]) ?? []).map(cleanText).filter((t): t is TextBox => !!t);
        applyMeta(copy, m.meta);
        applying = true;
        update((st) => {
          const nb = notebook();
          let folder = nb.sections.find((x) => x.name === 'Live sessions' && !x.parent);
          if (!folder) {
            folder = { ...newSection('Live sessions', nb.sections.length), pages: [] };
            nb.sections.push(folder);
          }
          folder.pages.push(copy);
          st.sectionId = folder.id;
          st.pageId = copy.id;
        });
        applying = false;
        s.pageId = copy.id;
        s.sent = { strokes: copy.strokes, texts: copy.texts, meta: metaOf(copy) };
        toast(`Joined as ${s.me.name}. Draw away!`, 3500);
      }
      changed();
      return;
    }
    case 'add': {
      const incoming = ((m.strokes as unknown[]) ?? [])
        .map(cleanStroke)
        .filter((x): x is Stroke => !!x);
      applyRemote((p) => {
        const at = new Map(p.strokes.map((x, i) => [x.id, i]));
        const next = p.strokes.slice();
        for (const x of incoming) {
          const i = at.get(x.id);
          if (i === undefined) next.push(x);
          else next[i] = x;
        }
        p.strokes = next;
      });
      return;
    }
    case 'remove': {
      const ids = new Set(((m.ids as unknown[]) ?? []).map(String));
      applyRemote((p) => {
        p.strokes = p.strokes.filter((x) => !ids.has(x.id));
      });
      return;
    }
    case 'texts': {
      const texts = ((m.texts as unknown[]) ?? []).map(cleanText).filter((t): t is TextBox => !!t);
      applyRemote((p) => {
        p.texts = texts;
      });
      return;
    }
    case 'meta':
      applyRemote((p) => applyMeta(p, m.meta));
      return;
    case 'join': {
      const p = m.peer as Peer;
      s.peers.set(p.id, p);
      toast(`${p.name} joined.`, 2000);
      changed();
      return;
    }
    case 'left': {
      const p = s.peers.get(String(m.id));
      s.peers.delete(String(m.id));
      cursors.get(String(m.id))?.el.remove();
      cursors.delete(String(m.id));
      if (p) toast(`${p.name} left.`, 2000);
      changed();
      return;
    }
    case 'cursor':
      if (num(m.x) && num(m.y)) moveCursor(String(m.id), m.x as number, m.y as number);
      return;
    case 'ended':
      s.ended = true;
      finish('The creator ended the session. Your copy of the note is in “Live sessions”.');
      return;
  }
}

function applyMeta(p: Page, meta: unknown) {
  const x = (meta ?? {}) as Partial<Page>;
  if (BACKGROUNDS.includes(x.background as Background)) p.background = x.background!;
  if (x.pageColor === 'auto' || hex(x.pageColor)) p.pageColor = x.pageColor!;
}

// --- Starting, joining, leaving ---

function connect(code: string, host: boolean) {
  const ws = new WebSocket(
    `${SERVER.replace(/^http/, 'ws')}/api/live/${code}?role=${host ? 'host' : 'guest'}`,
  );
  session = {
    ws,
    code,
    host,
    me: null,
    peers: new Map(),
    pageId: page().id,
    sent: { strokes: [], texts: [], meta: '' },
    ended: false,
  };
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') receive(e.data);
  });
  ws.addEventListener('close', () => {
    if (session?.ws !== ws || session.ended) return;
    finish(
      session.host
        ? 'Connection lost, so the live session ended.'
        : 'Disconnected from the live session. Your copy of the note is in “Live sessions”.',
    );
  });
  changed();
}

export function start() {
  if (session) return;
  connect(newCode(), true);
}

export function join(raw: string) {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!new RegExp(`^[${CODE_CHARS}]{6}$`).test(code)) {
    toast('A session code is 6 letters and numbers, like K7Q-4MZ.', 3500);
    return;
  }
  if (session) leave();
  connect(code, false);
}

export function leave() {
  if (!session) return;
  session.ended = true;
  session.ws.close(1000, 'left');
  finish(
    session.host ? 'Live session ended.' : 'You left the session. Your copy of the note stays.',
  );
}

function finish(message: string) {
  session = null;
  for (const c of cursors.values()) c.el.remove();
  cursors.clear();
  toast(message, 5000);
  changed();
}

// --- Other people's cursors ---

const stage = document.querySelector<HTMLElement>('#stage')!;
const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const cursors = new Map<string, { el: HTMLElement; x: number; y: number; seen: number }>();
function moveCursor(id: string, x: number, y: number) {
  const peer = session?.peers.get(id);
  if (!peer || session?.pageId !== page().id) return;
  let c = cursors.get(id);
  if (!c) {
    const el = h(
      'div',
      { class: 'live-cursor', style: `--c:${peer.color}` },
      h('span', {}, peer.name),
    );
    stage.append(el);
    c = { el, x, y, seen: 0 };
    cursors.set(id, c);
  }
  Object.assign(c, { x, y, seen: performance.now() });
  placeCursors();
}
let raf = 0;
function placeCursors() {
  cancelAnimationFrame(raf);
  const now = performance.now();
  for (const c of cursors.values()) {
    const s = toScreen(c.x, c.y);
    c.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    c.el.hidden = now - c.seen > 8000 || session?.pageId !== page().id;
  }
  // Keep them on the page while it pans and zooms.
  if (cursors.size) raf = requestAnimationFrame(placeCursors);
}
let lastCursor = 0;
bg.addEventListener('pointermove', (e) => {
  if (!session?.me || session.pageId !== page().id || e.timeStamp - lastCursor < 50) return;
  lastCursor = e.timeStamp;
  const w = toWorld(e.clientX, e.clientY);
  send({ t: 'cursor', x: Math.round(w.x), y: Math.round(w.y) });
});

// --- The Live button and its panel ---

export const liveButton = h(
  'button',
  { class: 'tb-btn', 'aria-label': 'Live session', title: 'Live session: draw together' },
  icon(Radio),
);
liveButton.addEventListener('click', () => togglePopover(liveButton, panel()));

function changed() {
  liveButton.classList.toggle('live-on', !!session?.me);
  document.querySelector('.live-panel')?.replaceWith(panel());
}

function panel(): HTMLElement {
  if (session) {
    const s = session;
    const people = [s.me, ...s.peers.values()].filter((p): p is Peer => !!p);
    return h(
      'div',
      { class: 'style-panel live-panel' },
      h('div', { class: 'panel-title' }, s.me ? 'Live session' : 'Connecting…'),
      h(
        'div',
        { class: 'live-code' },
        h('output', { 'aria-label': 'Session code' }, pretty(s.code)),
        h(
          'button',
          {
            class: 'tb-btn',
            'aria-label': 'Copy code',
            title: 'Copy code',
            onclick: () =>
              navigator.clipboard?.writeText(pretty(s.code)).then(
                () => toast('Code copied.', 1500),
                () => {},
              ),
          },
          icon(Copy, 18),
        ),
      ),
      h(
        'p',
        { class: 'panel-sub' },
        s.host
          ? 'Others join with this code. The session lasts while you stay.'
          : 'You can draw on this note with everyone.',
      ),
      h('div', { class: 'panel-sub' }, h('span', {}, icon(Users, 14), ` ${people.length} here`)),
      h(
        'ul',
        { class: 'live-people' },
        ...people.map((p) =>
          h(
            'li',
            { style: `--c:${p.color}` },
            `${p.name}${p === s.me ? ' (you)' : ''}${p.host ? ' · creator' : ''}`,
          ),
        ),
      ),
      h(
        'button',
        { class: 'menu-item danger', onclick: () => leave() },
        icon(LogOut, 18),
        h('span', {}, s.host ? 'End session for everyone' : 'Leave session'),
      ),
    );
  }
  const input = h('input', {
    class: 'hex live-input',
    placeholder: 'K7Q-4MZ',
    maxLength: 7,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Session code',
  });
  const go = () => join(input.value);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go();
  });
  return h(
    'div',
    { class: 'style-panel live-panel' },
    h('div', { class: 'panel-title' }, 'Live session'),
    h(
      'p',
      { class: 'panel-sub' },
      'Draw on this note together. Others join with a code, under an anonymous name.',
    ),
    h('button', { class: 'primary', onclick: () => start() }, 'Start a live session'),
    h('div', { class: 'panel-sub' }, 'Or join one:'),
    h('div', { class: 'hex-row' }, input, h('button', { class: 'cal-btn', onclick: go }, 'Join')),
  );
}

// The shared note, viewed again after visiting other pages: cursors come back.
subscribe(() => {
  if (cursors.size) placeCursors();
});
