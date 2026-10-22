// Inkwell's Cloudflare Worker: serves the web app (static files) and runs live sessions.
//
// A live session is one shared note. Its creator gets a 6-character code; anyone who types the
// code joins (website, desktop app or APK) under an anonymous name and can draw. Each session is
// a Durable Object named by its code: it holds the note's current strokes and text so latecomers
// see everything, relays changes and cursors between people, and ends the session for everyone
// when the creator leaves. Nothing is stored after that; each person keeps their own copy.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  LIVE: DurableObjectNamespace<LiveSession>;
  ASSETS: Fetcher;
}

/** Codes avoid look-alike characters (0/O, 1/I/L). */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = new RegExp(`^[${CODE_CHARS}]{6}$`);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/api\/live\/(\w{6})$/.exec(url.pathname);
    if (m) {
      const code = m[1]!.toUpperCase();
      if (!CODE.test(code)) return new Response('Bad session code', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      return env.LIVE.get(env.LIVE.idFromName(code)).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

const ADJECTIVES = [
  'Amber',
  'Azure',
  'Brisk',
  'Calm',
  'Coral',
  'Cosmic',
  'Dusky',
  'Ember',
  'Frosty',
  'Golden',
  'Hazel',
  'Indigo',
  'Jade',
  'Lunar',
  'Maple',
  'Misty',
  'Nimble',
  'Olive',
  'Pebble',
  'Quiet',
  'Ruby',
  'Saffron',
  'Silver',
  'Sunny',
  'Teal',
  'Velvet',
  'Willow',
  'Zesty',
];
const ANIMALS = [
  'Badger',
  'Crane',
  'Dolphin',
  'Eagle',
  'Falcon',
  'Fox',
  'Gecko',
  'Heron',
  'Ibis',
  'Jaguar',
  'Koala',
  'Lynx',
  'Marten',
  'Narwhal',
  'Otter',
  'Panda',
  'Quail',
  'Raven',
  'Seal',
  'Swift',
  'Tern',
  'Tiger',
  'Vole',
  'Walrus',
  'Wren',
  'Yak',
  'Zebra',
];
const COLORS = [
  '#e5484d',
  '#f76b15',
  '#30a46c',
  '#0090ff',
  '#8e4ec6',
  '#d6409f',
  '#12a594',
  '#ad7f58',
];
const MAX_MESSAGE = 1_000_000;
const BATCH_BYTES = 200_000;
const MAX_PEOPLE = 32;

interface Peer {
  id: string;
  name: string;
  color: string;
  host: boolean;
}
type Item = { id: string };

/** One live session: everyone connected to one code. */
export class LiveSession extends DurableObject<Env> {
  // ponytail: kept in memory while anyone is connected (no hibernation), which is fine for
  // short sessions; switch to the hibernation API if sessions run for hours.
  private peers = new Map<WebSocket, Peer>();
  private strokes = new Map<string, Item>();
  private texts: Item[] = [];
  private meta: Record<string, unknown> = {};

  async fetch(req: Request): Promise<Response> {
    const host = new URL(req.url).searchParams.get('role') === 'host';
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    const hasHost = [...this.peers.values()].some((p) => p.host);
    const refuse = host
      ? hasHost
        ? 'taken'
        : null
      : !hasHost
        ? 'missing'
        : this.peers.size >= MAX_PEOPLE
          ? 'full'
          : null;
    if (refuse) {
      server.send(JSON.stringify({ t: 'error', reason: refuse }));
      server.close(4000, refuse);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (host) {
      // A new session under this code starts empty.
      this.strokes.clear();
      this.texts = [];
      this.meta = {};
    }
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), ...this.identity(), host };
    this.peers.set(server, peer);
    server.send(
      JSON.stringify({
        t: 'welcome',
        you: peer,
        peers: [...this.peers.values()].filter((p) => p !== peer),
        meta: this.meta,
        texts: this.texts,
      }),
    );
    for (const strokes of batches([...this.strokes.values()])) {
      server.send(JSON.stringify({ t: 'add', strokes }));
    }
    this.broadcast(server, { t: 'join', peer });
    server.addEventListener('message', (e) => this.receive(server, e.data));
    server.addEventListener('close', () => this.leave(server));
    server.addEventListener('error', () => this.leave(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** An anonymous name and colour nobody else in the session has. */
  private identity() {
    const taken = new Set([...this.peers.values()].map((p) => p.name));
    for (let i = 0; i < 50; i++) {
      const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
      if (!taken.has(name)) return { name, color: COLORS[this.peers.size % COLORS.length]! };
    }
    return {
      name: `Guest ${this.peers.size + 1}`,
      color: COLORS[this.peers.size % COLORS.length]!,
    };
  }

  private receive(ws: WebSocket, data: string | ArrayBuffer) {
    const peer = this.peers.get(ws);
    if (!peer || typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let m: {
      t?: string;
      strokes?: Item[];
      ids?: string[];
      texts?: Item[];
      meta?: object;
      x?: number;
      y?: number;
    };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.t) {
      case 'add':
        if (!Array.isArray(m.strokes)) return;
        for (const s of m.strokes) if (typeof s?.id === 'string') this.strokes.set(s.id, s);
        break;
      case 'remove':
        if (!Array.isArray(m.ids)) return;
        for (const id of m.ids) this.strokes.delete(String(id));
        break;
      case 'texts':
        if (!Array.isArray(m.texts)) return;
        this.texts = m.texts;
        break;
      case 'meta':
        if (typeof m.meta !== 'object' || !m.meta) return;
        this.meta = { ...this.meta, ...m.meta };
        break;
      case 'cursor':
        if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
        this.broadcast(ws, { t: 'cursor', id: peer.id, x: m.x, y: m.y });
        return;
      default:
        return;
    }
    this.broadcast(ws, { ...m, from: peer.id });
  }

  private leave(ws: WebSocket) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);
    if (!peer.host) {
      this.broadcast(ws, { t: 'left', id: peer.id });
      return;
    }
    // The creator left: the session is over for everyone (they keep their copies).
    for (const other of this.peers.keys()) {
      try {
        other.send(JSON.stringify({ t: 'ended' }));
        other.close(1000, 'ended');
      } catch {}
    }
    this.peers.clear();
    this.strokes.clear();
    this.texts = [];
    this.meta = {};
  }

  private broadcast(from: WebSocket, msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of this.peers.keys()) {
      if (ws === from) continue;
      try {
        ws.send(text);
      } catch {
        this.leave(ws);
      }
    }
  }
}

const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;

/** Splits a big note into messages under the WebSocket size limit. */
function* batches(items: Item[]) {
  let batch: Item[] = [];
  let size = 0;
  for (const it of items) {
    const n = JSON.stringify(it).length;
    if (batch.length && size + n > BATCH_BYTES) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(it);
    size += n;
  }
  if (batch.length) yield batch;
}
