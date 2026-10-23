import { DurableObject } from 'cloudflare:workers';

// Read-only share links. The browser encrypts the page (AES-GCM) with a key that only ever appears
// in the link's #fragment, which browsers don't send to servers; this Worker stores and hands back
// the encrypted bytes and can't read them. Each share is one Durable Object (SQLite storage):
//   POST   /api/share        → { id, token, days }   (the token is needed to delete it)
//   GET    /api/share/<id>   → the encrypted bytes
//   DELETE /api/share/<id>   with header x-share-token
// A share expires after 30 days (an alarm deletes it) and is capped at 6 MB.

export interface ShareEnv {
  SHARE: DurableObjectNamespace<ShareStore>;
}

const MAX_BYTES = 6_000_000;
const CHUNK = 900_000; // rows are limited to 2 MB
const TTL_MS = 30 * 24 * 3600 * 1000;
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'x-share-token, content-type',
};
const reply = (body: BodyInit | null, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });

async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Routes /api/share…; returns null for any other path. */
export async function share(req: Request, env: ShareEnv, path: string): Promise<Response | null> {
  if (path !== '/api/share' && !path.startsWith('/api/share/')) return null;
  if (req.method === 'OPTIONS') return reply(null, 204);

  if (path === '/api/share') {
    if (req.method !== 'POST') return reply('Use POST', 405);
    const length = Number(req.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) return reply('Too large (6 MB at most)', 413);
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BYTES || body.byteLength < 30) return reply('Bad size', 413);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ID_CHARS[b % ID_CHARS.length]).join('');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const stub = env.SHARE.get(env.SHARE.idFromName(id));
    const res = await stub.fetch('https://share/', {
      method: 'PUT',
      body,
      headers: { 'x-hash': await sha256(token) },
    });
    if (!res.ok) return reply('Could not store', 500);
    return reply(JSON.stringify({ id, token, days: TTL_MS / 86_400_000 }), 201, {
      'Content-Type': 'application/json',
    });
  }

  const id = /^\/api\/share\/([a-z2-9]{12})$/.exec(path)?.[1];
  if (!id) return reply('Not found', 404);
  const stub = env.SHARE.get(env.SHARE.idFromName(id));
  if (req.method === 'GET') {
    const res = await stub.fetch('https://share/');
    return res.status === 200
      ? reply(res.body, 200, { 'Content-Type': 'application/octet-stream' })
      : reply('Not found', 404);
  }
  if (req.method === 'DELETE') {
    const token = req.headers.get('x-share-token') ?? '';
    const res = await stub.fetch('https://share/', {
      method: 'DELETE',
      headers: { 'x-hash': await sha256(token) },
    });
    return reply(null, res.status === 204 ? 204 : res.status === 403 ? 403 : 404);
  }
  return reply('Method not allowed', 405);
}

/** One share's encrypted bytes. */
export class ShareStore extends DurableObject<ShareEnv> {
  async fetch(req: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    // Here, not in the constructor: deleteAll() drops the tables while this instance lives on.
    sql.exec('CREATE TABLE IF NOT EXISTS chunk (i INTEGER PRIMARY KEY, data BLOB)');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    const stored = sql.exec("SELECT v FROM meta WHERE k = 'hash'").toArray()[0]?.v as string | undefined;
    if (req.method === 'PUT') {
      if (stored) return new Response(null, { status: 409 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      for (let i = 0, at = 0; at < bytes.length; i++, at += CHUNK) {
        sql.exec('INSERT INTO chunk (i, data) VALUES (?, ?)', i, bytes.slice(at, at + CHUNK).buffer);
      }
      sql.exec("INSERT INTO meta (k, v) VALUES ('hash', ?)", req.headers.get('x-hash') ?? '');
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
      return new Response(null, { status: 201 });
    }
    if (!stored) return new Response(null, { status: 404 });
    if (req.method === 'GET') {
      const rows = sql.exec('SELECT data FROM chunk ORDER BY i').toArray();
      const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return new Response(out, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (req.method === 'DELETE') {
      if (req.headers.get('x-hash') !== stored) return new Response(null, { status: 403 });
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll(); // expired
  }
}
