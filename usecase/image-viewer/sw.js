/*
 * The image viewer's service worker. vite.config.ts copies it into the build
 * as sw.js, with the build's files in PRECACHE and their hash in VERSION.
 *
 * - The site's own files are cached on install, so it starts offline and
 *   installs as an app; they are served from the cache (their names carry
 *   their hash, so a new build brings new names). Large files only some
 *   tools need (LAZY: ONNX Runtime's WebAssembly and the sample models of the AI tools) are
 *   cached the first time they are used instead.
 * - The page itself and config.json come from the network first (a new
 *   build, a config.json edited on the server), the cache when offline.
 * - The page is made cross-origin isolated (COOP same-origin, COEP
 *   credentialless on it and the site's own files it answers, workers
 *   included) so ONNX Runtime can run the AI tools on several threads.
 *   This takes effect from the next load the service worker answers;
 *   cross-origin files the page asks for without CORS come without cookies.
 *   Browsers without credentialless (Safari) just stay as they were.
 * - Everything else (COGs, services, base map tiles, range requests) is left
 *   to the network as it is.
 * - What other apps share to the installed app (the manifest's share_target,
 *   a POST to ./share-target) is kept in the cache SHARE_CACHE under an id, and
 *   the page opens at ./?share=<id> to take it (src/share-target.ts).
 * - The installed app's Periodic Background Sync checks the image catalog
 *   watches (src/catalog-watch-sw.ts, bundled in where __WATCH__ is).
 */
const VERSION = '__VERSION__';
const PRECACHE = /* __PRECACHE__ */ [];
const LAZY = /* __LAZY__ */ [];
const CACHE = `image-viewer-${VERSION}`;

const scope = new URL(self.registration.scope);
const local = (path) => new URL(path, scope).href;
const precached = new Set(PRECACHE.map(local));
const lazy = new Set(LAZY.map(local));
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

/** A response of the site with the headers that make the page (and its workers) cross-origin isolated. */
async function isolated(response) {
  if (response.type === 'opaqueredirect' || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method === 'POST' && request.url.split('?')[0] === shareAction) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href)) return;
  // The sign-in popup's return page (src/auth.ts): from the network as it is, never answered with (or cached as) the viewer's page.
  if (/\/oauth-callback\.(html|js)$/.test(url.pathname)) return;
  const bare = url.origin + url.pathname;
  // The page, whatever its query (?url=, ?service=…); other pages of the site (embed-example.html) as files below.
  if (request.mode === 'navigate' && (bare === page || bare === scope.href)) {
    event.respondWith(networkFirst(request, page).then(isolated));
    return;
  }
  if (bare === config) {
    event.respondWith(networkFirst(request, config).then(isolated));
    return;
  }
  if (precached.has(bare)) {
    const file = caches.match(bare).then((cached) => cached || fetch(request));
    // Another page (embed-example.html) is not isolated: it embeds the viewer from elsewhere in an iframe.
    event.respondWith(request.mode === 'navigate' ? file : file.then(isolated));
  } else if (lazy.has(bare)) {
    event.respondWith(
      caches.match(bare).then(
        (cached) =>
          cached ||
          fetch(request).then(async (response) => {
            if (response.ok) await (await caches.open(CACHE)).put(bare, response.clone());
            return response;
          }),
      ).then(isolated),
    );
  }
});

// ------------------------------------------------------------ share target

/** Where shared files wait for the page (not image-viewer-…, which activate clears). */
const SHARE_CACHE = 'iv-share';
const shareAction = local('share-target');
const MAX_SHARE_FILES = 100;
const MAX_SHARE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SHARE_TEXT = 200000;
/** Shares the page never took are dropped after a day. */
const SHARE_KEEP_MS = 24 * 60 * 60 * 1000;

/** Keeps a shared form's files and text, and sends the page to take them. */
async function receiveShare(request) {
  const id = self.crypto.randomUUID();
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    await dropOldShares(cache);
    const key = (part) => local(`share/${id}/${part}`);
    const files = [];
    let bytes = 0;
    for (const file of form.getAll('files')) {
      if (typeof file === 'string' || !file.size) continue;
      if (files.length >= MAX_SHARE_FILES || bytes + file.size > MAX_SHARE_BYTES) break;
      bytes += file.size;
      await cache.put(key(String(files.length)), new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
      files.push({ name: String(file.name).slice(-200), type: file.type });
    }
    const text = (name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value.slice(0, MAX_SHARE_TEXT) : '';
    };
    const meta = { created: Date.now(), files, title: text('title'), text: text('text'), url: text('url') };
    await cache.put(key('meta'), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    // Nothing kept: the page opens as it is.
    return Response.redirect(scope.href, 303);
  }
  return Response.redirect(`${scope.href}?share=${id}`, 303);
}

/** Deletes shares older than SHARE_KEEP_MS. */
async function dropOldShares(cache) {
  const requests = await cache.keys();
  const old = new Set();
  for (const request of requests) {
    const m = /\/share\/([0-9a-f-]+)\/meta$/.exec(request.url);
    if (!m) continue;
    const meta = await (await cache.match(request))?.json().catch(() => null);
    if (!meta || !(Date.now() - meta.created < SHARE_KEEP_MS)) old.add(m[1]);
  }
  for (const request of requests) {
    const m = /\/share\/([0-9a-f-]+)\//.exec(request.url);
    if (m && old.has(m[1])) await cache.delete(request);
  }
}

// ------------------------------------------------------------ catalog watches

/* __WATCH__ */
