/**
 * idb.js — tiny promise wrapper over IndexedDB (no dependencies).
 *
 * Used instead of localStorage so the builder can hold many full-resolution
 * panoramas (localStorage caps around ~5 MB; a single 4096×2048 JPEG as a data
 * URL is ~2–3 MB, so localStorage overflowed after ~2 rooms). IndexedDB has a
 * much larger, disk-backed quota.
 */
const DB_NAME = 'vt360';
const STORE = 'tours';
const VERSION = 1;

let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function withStore(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const idbSet = (key, val) => withStore('readwrite', (s) => s.put(val, key));
export const idbGet = (key) => withStore('readonly', (s) => s.get(key));
export const idbDelete = (key) => withStore('readwrite', (s) => s.delete(key));
export const idbAll = () => withStore('readonly', (s) => s.getAll()).then((r) => r || []);
export const idbKeys = () => withStore('readonly', (s) => s.getAllKeys()).then((r) => r || []);
