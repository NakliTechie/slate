const DB_NAME  = 'slate.v1';
const DB_VER   = 1;
const STORE    = 'sessions';

let _db = null;

async function getDb() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

export async function saveSession(data) {
  try {
    const db = await getDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, 'current');
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch {}
}

export async function loadSession() {
  try {
    const db = await getDb();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('current');
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
}

export async function clearSession() {
  try {
    const db = await getDb();
    await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch {}
}
