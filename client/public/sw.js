// The service worker: the app opens without a connection. The page and its
// assets come from the cache when the network does not answer; the API is
// never cached here — data offline comes from the app's own saved cache,
// and changes wait in its outbox (client/hooks/offline.ts).
//
// The cache belongs to the whole domain and so can be shared with another
// installation under another path: its name carries this one's scope, and
// only this one's caches are touched (a name without "|": an older version).
const SCOPE = self.registration.scope;
const CACHE = `yartt-shell-v3|${SCOPE}`;
const SHELL = ['./', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key !== CACHE && (!key.includes('|') || key.endsWith(`|${SCOPE}`)))
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  // Pages: the network first (a new release), the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(SCOPE, copy));
        return response;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(SCOPE))));
    return;
  }

  // Assets have hashed names: the cache first, filled as they are fetched;
  // without the network, a failed response rather than an uncaught error.
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  }))).catch(() => Response.error()));
});
