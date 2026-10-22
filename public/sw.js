// Offline-first: after one online visit Inkwell opens and works without internet.
// Hashed /assets/* files never change, so they're served cache-first; the page itself is
// network-first (to pick up new versions) with the cached copy as the offline fallback.
// ponytail: old hashed assets stay in the cache after updates; prune by age if it ever matters.
const CACHE = 'inkwell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-256.png', '/icons/icon-512.png'];

// precache.json (written by the build) lists every bundle file, lazy chunks included.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    fetch('/precache.json', { cache: 'no-store' })
      .then((r) => r.json())
      .then((files) => caches.open(CACHE).then((c) => c.addAll([...SHELL, ...files]))),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/', { ignoreVary: true })),
    );
    return;
  }
  e.respondWith(
    // ignoreVary: module scripts and stylesheets are requested with an Origin header (Vite adds
    // crossorigin), which a `Vary: Origin` response would otherwise never match offline.
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
