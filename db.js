// Tiny IndexedDB wrapper. Everything lives on this device.
const DB_NAME = 'voice-journal';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// Entries: { id, createdAt, durationMs, mime, title, mood, tags[], prompt, audio: ArrayBuffer }
export const allEntries = () =>
  run('entries', 'readonly', (s) => s.getAll()).then((list) => list.sort((a, b) => b.createdAt - a.createdAt));
export const putEntry = (entry) => run('entries', 'readwrite', (s) => s.put(entry));
export const deleteEntry = (id) => run('entries', 'readwrite', (s) => s.delete(id));

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
export const deleteMeta = (key) => run('meta', 'readwrite', (s) => s.delete(key));
