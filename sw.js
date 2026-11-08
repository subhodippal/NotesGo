// Service worker: caches the app files so it opens offline once installed.
// Only runs when hosted (http/https), e.g. on GitHub Pages — browsers don't allow it on file://.
// Files are fetched network-first, so edits show up on the next online visit; bump CACHE if you add/rename files.
const CACHE = 'notesgo-v24';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './db.js',
  './vault.js',
  './sync.js',
  './app.js',
  './vendor/supabase.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle our own files; Supabase API calls always go to the network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network first (so updates show up). On a slow or missing connection, use the cached copy
  // after 3 s while the network request keeps going and refreshes the cache in the background.
  const network = fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy));
    }
    return res;
  });
  const cached = () =>
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'));
  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (!settled && r) {
          settled = true;
          resolve(r);
        }
      };
      const timer = setTimeout(() => cached().then(done), 3000);
      network
        .then((r) => {
          clearTimeout(timer);
          done(r);
        })
        .catch(() => {
          clearTimeout(timer);
          cached().then((r) => done(r || Response.error()));
        });
    }),
  );
});
