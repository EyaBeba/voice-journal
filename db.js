// Tiny IndexedDB wrapper. Everything lives on this device.
import { sealEntry, openEntry, encryptBytes, decryptBytes } from './crypt.js';

// When encryption is on, this holds the key (only while unlocked) and entries are sealed.
let key = null;
export const setKey = (k) => { key = k; };
const DB_NAME = 'voice-journal';
const DB_VERSION = 2;
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
      // v2: audio pieces saved every second while recording, so a crash can't lose a note
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['draft', 'seq'] });
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
  run('entries', 'readonly', (s) => s.getAll())
    .then((list) => Promise.all(list.map((e) => (e.sealed ? openEntry(key, e) : e))))
    .then((list) => list.sort((a, b) => b.createdAt - a.createdAt));
export const putEntry = async (entry) => {
  const stored = key ? await sealEntry(key, entry) : entry;
  return run('entries', 'readwrite', (s) => s.put(stored));
};
export const deleteEntry = (id) => run('entries', 'readwrite', (s) => s.delete(id));

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
export const deleteMeta = (key) => run('meta', 'readwrite', (s) => s.delete(key));

// Recording drafts: { draft, seq, data: ArrayBuffer }
export const putChunk = async (draft, seq, data) => {
  const stored = key ? { draft, seq, sealed: await encryptBytes(key, data) } : { draft, seq, data };
  return run('chunks', 'readwrite', (s) => s.put(stored));
};
export const getChunks = (draft) =>
  run('chunks', 'readonly', (s) => s.getAll(IDBKeyRange.bound([draft, 0], [draft, Infinity])))
    .then((list) => Promise.all(list.sort((a, b) => a.seq - b.seq).map((c) => (c.sealed ? decryptBytes(key, c.sealed) : c.data))));
export const deleteChunks = (draft) =>
  run('chunks', 'readwrite', (s) => s.delete(IDBKeyRange.bound([draft, 0], [draft, Infinity])));
