/* sw.js — offline app-shell cache for the 360 Tour PWA.
 *
 * Strategy: stale-while-revalidate for same-origin GETs (HTML, hashed JS/CSS,
 * icons) — serve from cache instantly, refresh in the background. Bundle files
 * are content-hashed, so we cache them on first use rather than precaching by
 * name. Camera streams aren't fetches; the stitch call is a cross-origin POST
 * to the backend — both pass straight through, never cached. */
const CACHE = '360tour-v5';
const SHELL = ['/', '/builder.html', '/index.html', '/site.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only same-origin GETs. Cross-origin (the backend stitch POST) and non-GET
  // pass through untouched. Skip webpack-dev-server HMR traffic so live reload
  // keeps working while developing.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('hot-update') || url.pathname.startsWith('/ws')) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;          // cache-first, but always revalidates
    })
  );
});
