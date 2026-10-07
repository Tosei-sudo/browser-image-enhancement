/*
 * The image viewer's service worker. vite.config.ts copies it into the build
 * as sw.js, with the build's files in PRECACHE and their hash in VERSION.
 *
 * - The site's own files are cached on install, so it starts offline and
 *   installs as an app; they are served from the cache (their names carry
 *   their hash, so a new build brings new names).
 * - The page itself and config.json come from the network first (a new
 *   build, a config.json edited on the server), the cache when offline.
 * - Everything else (COGs, services, base map tiles, range requests) is left
 *   to the network as it is.
 */
const VERSION = '__VERSION__';
const PRECACHE = /* __PRECACHE__ */ [];
const CACHE = `image-viewer-${VERSION}`;

const scope = new URL(self.registration.scope);
const local = (path) => new URL(path, scope).href;
const precached = new Set(PRECACHE.map(local));
const page = local('index.html');
const config = local('config.json');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...precached])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('image-viewer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks for the newer version (its 「再読み込み」 button).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

/** From the network, kept in the cache; the cached copy when the network fails. */
async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href)) return;
  // The page, whatever its query (?url=, ?service=…).
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, page));
    return;
  }
  const bare = url.origin + url.pathname;
  if (bare === config) {
    event.respondWith(networkFirst(request, config));
    return;
  }
  if (precached.has(bare)) {
    event.respondWith(caches.match(bare).then((cached) => cached || fetch(request)));
  }
});
