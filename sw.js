// Offline-first service worker: serve the app shell from cache, refresh it in the background.
const CACHE = 'voice-journal-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './zip.js',
  './prompts.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? './index.html' : request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(request)
      .then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
