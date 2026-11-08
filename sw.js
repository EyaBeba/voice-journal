// Offline-first service worker: serve the app shell from cache, refresh it in the background.
const CACHE = 'voice-journal-v13';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './crypt.js',
  './zip.js',
  './prompts.js',
  './transcribe.js',
  './transcriber.worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './fonts/cormorant-garamond-latin-500-normal.woff2',
  './fonts/cormorant-garamond-latin-500-italic.woff2',
  './fonts/cormorant-garamond-latin-600-normal.woff2',
  './fonts/inter-latin-wght-normal.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
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

  // Bundled speech-to-text engine: large and never changes, so cache it on first use
  // and don't re-download it in the background.
  if (new URL(request.url).pathname.includes('/vendor/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) await cache.put(request, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? './index.html' : request;
    const cached = await cache.match(key, { ignoreSearch: true });
    // Always check GitHub for a newer file (skipping the browser's HTTP cache).
    const network = fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
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

/* ---------- daily reminder (Periodic Background Sync) ---------- */
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('voice-journal');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const idbGet = (db, store, key) => new Promise((resolve) => {
  if (!db.objectStoreNames.contains(store)) return resolve(undefined);
  const q = db.transaction(store).objectStore(store).get(key);
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => resolve(undefined);
});
const localDay = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

async function maybeRemind() {
  const db = await idb();
  const reminder = await idbGet(db, 'meta', 'reminder');
  if (!reminder?.on) return;
  const now = new Date();
  const [hh, mm] = (reminder.time || '20:00').split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
  if (reminder.lastShown === localDay(now)) return;
  // skip if there is already a note today
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = await new Promise((resolve) => {
    if (!db.objectStoreNames.contains('entries')) return resolve(0);
    const q = db.transaction('entries').objectStore('entries').index('createdAt').count(IDBKeyRange.lowerBound(+start));
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => resolve(0);
  });
  if (!today) {
    await self.registration.showNotification('Time to journal', {
      body: 'A minute or two about your day. Tap to start recording.',
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'daily-reminder',
      data: { url: './?action=record' },
    });
  }
  await new Promise((resolve) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ ...reminder, lastShown: localDay(now) }, 'reminder');
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'daily-reminder') event.waitUntil(maybeRemind());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open[0]) { await open[0].navigate(url).catch(() => {}); return open[0].focus(); }
    return self.clients.openWindow(url);
  })());
});
