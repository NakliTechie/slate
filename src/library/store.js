// The library index store. Two implementations with one async API:
//   idbStore()    IndexedDB database `slate.library`, used in the browser
//   memoryStore() a Map, used by the Node tests and as a last resort
//
// The index is disposable: every row can be rebuilt by rescanning the folders.
// Thumbnails do not live here; they are files in OPFS (thumbs.js).
//
// Object stores (version 1):
//   photos  keyPath 'id', index 'root' on rootId        PhotoRecord rows (schema.js)
//   roots   keyPath 'id'                                 { id, name, handle, mode, added, lastScan }
//   kv      out-of-line keys                             small values: browse-only library files, settings
//
// API (all async):
//   putPhotos(records)          upsert many, one transaction
//   deletePhotos(ids)           delete many, one transaction
//   allPhotos()                 every row (getAll; the library keeps them in memory)
//   putRoot(root) / allRoots() / deleteRoot(id)   deleteRoot also deletes that root's photos
//   getKv(key) / setKv(key, value) / deleteKv(key)
//   clear()                     drop every row in every store (rebuild index)
//   estimate()                  { photos, roots } row counts

export const DB_NAME = 'slate.library';

// Rebuild index keeps the person's settings, the hidden-photo lock and text already read from photos.
export function keepKv(key) { return typeof key === 'string' && (key.startsWith('setting:') || key.startsWith('lock:') || key === 'textindex'); }
export const DB_VERSION = 1;

export function memoryStore() {
  const photos = new Map();
  const roots = new Map();
  const kv = new Map();
  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    async putPhotos(records) { for (const r of records) photos.set(r.id, clone(r)); },
    async deletePhotos(ids) { for (const id of ids) photos.delete(id); },
    async allPhotos() { return [...photos.values()].map(clone); },
    async putRoot(root) { roots.set(root.id, { ...root }); },
    async allRoots() { return [...roots.values()].map(r => ({ ...r })); },
    async deleteRoot(id) {
      roots.delete(id);
      for (const [pid, r] of photos) if (r.rootId === id) photos.delete(pid);
    },
    async getKv(key) { return kv.has(key) ? clone(kv.get(key)) : undefined; },
    async setKv(key, value) { kv.set(key, clone(value)); },
    async deleteKv(key) { kv.delete(key); },
    async clear() { photos.clear(); roots.clear(); for (const k of [...kv.keys()]) if (!keepKv(k)) kv.delete(k); },
    async estimate() { return { photos: photos.size, roots: roots.size }; },
  };
}

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export async function idbStore(name = DB_NAME) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('root', 'rootId');
      if (!d.objectStoreNames.contains('roots')) d.createObjectStore('roots', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('the library index is open in another Slate tab with an older version'));
  });

  // Large batches are split so one transaction never holds tens of thousands of puts.
  const CHUNK = 2000;
  return {
    kind: 'idb',
    db,
    async putPhotos(records) {
      for (let i = 0; i < records.length; i += CHUNK) {
        const tx = db.transaction('photos', 'readwrite');
        const st = tx.objectStore('photos');
        for (const r of records.slice(i, i + CHUNK)) st.put(r);
        await done(tx);
      }
    },
    async deletePhotos(ids) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const tx = db.transaction('photos', 'readwrite');
        const st = tx.objectStore('photos');
        for (const id of ids.slice(i, i + CHUNK)) st.delete(id);
        await done(tx);
      }
    },
    async allPhotos() { return req(db.transaction('photos').objectStore('photos').getAll()); },
    async putRoot(root) { const tx = db.transaction('roots', 'readwrite'); tx.objectStore('roots').put(root); await done(tx); },
    async allRoots() { return req(db.transaction('roots').objectStore('roots').getAll()); },
    async deleteRoot(id) {
      const tx = db.transaction(['roots', 'photos'], 'readwrite');
      tx.objectStore('roots').delete(id);
      const idx = tx.objectStore('photos').index('root');
      const keys = await req(idx.getAllKeys(IDBKeyRange.only(id)));
      for (const k of keys) tx.objectStore('photos').delete(k);
      await done(tx);
    },
    async getKv(key) { return req(db.transaction('kv').objectStore('kv').get(key)); },
    async setKv(key, value) { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); await done(tx); },
    async deleteKv(key) { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); await done(tx); },
    async clear() {
      const keys = await req(db.transaction('kv').objectStore('kv').getAllKeys());
      const tx = db.transaction(['photos', 'roots', 'kv'], 'readwrite');
      tx.objectStore('photos').clear();
      tx.objectStore('roots').clear();
      for (const k of keys) if (!keepKv(k)) tx.objectStore('kv').delete(k);
      await done(tx);
    },
    async estimate() {
      const tx = db.transaction(['photos', 'roots']);
      return { photos: await req(tx.objectStore('photos').count()), roots: await req(tx.objectStore('roots').count()) };
    },
  };
}
