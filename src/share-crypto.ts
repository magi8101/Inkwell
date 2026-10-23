// Encryption for read-only share links. A page (JSON) is compressed, then encrypted with AES-GCM
// under a fresh random 256-bit key. The key travels only in the link's #fragment, which browsers
// never send to a server, so the Worker that stores the bytes can't read them. Pure Web Crypto, so
// share-crypto.check.ts runs in Node too.
//
// Bytes: [format 1][12-byte IV][AES-GCM ciphertext + tag]. Format 1 = gzip-compressed JSON.

const FORMAT = 1;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function gzip(bytes: Uint8Array, mode: 'compress' | 'decompress') {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(
      mode === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip'),
    );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encrypts `data`; returns the bytes to store and the key (base64url) for the link fragment. */
export async function encryptShare(data: unknown): Promise<{ bytes: Uint8Array; key: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(data)), 'compress');
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource),
  );
  const bytes = new Uint8Array(1 + iv.length + cipher.length);
  bytes[0] = FORMAT;
  bytes.set(iv, 1);
  bytes.set(cipher, 1 + iv.length);
  return { bytes, key: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', key))) };
}

/** Decrypts what encryptShare made. Throws if the key is wrong or the bytes were changed. */
export async function decryptShare(bytes: Uint8Array, keyText: string): Promise<unknown> {
  if (bytes[0] !== FORMAT || bytes.length < 30) throw new Error('Not a share');
  const key = await crypto.subtle.importKey(
    'raw',
    unb64url(keyText) as BufferSource,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 13) },
      key,
      bytes.slice(13) as BufferSource,
    ),
  );
  return JSON.parse(new TextDecoder().decode(await gzip(plain, 'decompress')));
}
