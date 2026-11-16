// Locked hidden photos (spec row O9). "Lock hidden photos" sets a passphrase; from
// then on the Hidden view shows nothing until the passphrase is entered, once per
// session (the unlocked state lives in memory only, so a reload locks again).
//
// What it does: while locked, lib.search() matches no hidden photo (query.js
// `lockHidden`), so the Hidden view, the trash and the agent commands list no
// hidden id and show no hidden thumbnail. What it does not do: the files are not
// encrypted, and each folder's library file keeps its "hidden" entries as before.
// It hides photos from casual viewers of this browser; anyone with the folder
// sees every file.
//
// The verifier lives in lib.store kv under 'lock:hidden':
//   { v: 1, kdf: 'PBKDF2-SHA-256', iterations: 600000, salt: base64 (16 bytes), hash: base64 (32 bytes) }
// "Reset lock" deletes it after a confirmation; it unhides nothing.
//
// createLock(store, { crypto, iterations }) -> lock (no library needed; the tests use this)
//   lock.ready, lock.isSet(), lock.isLocked(), lock.set(pass), lock.unlock(pass) -> boolean,
//   lock.lock(), lock.reset(), lock.onChange(fn)
// initLocked(lib) -> lock, and sets lib.hiddenLocked() and lib.services.lock. Each change
// emits lib 'choices' { ids: null, reason: 'lock' } so the view queries again.

export const LOCK_KEY = 'lock:hidden';
export const LOCK_ITERATIONS = 600000;
export const MIN_PASSPHRASE = 4;

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

async function derive(crypto, pass, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function createLock(store, { crypto = globalThis.crypto, iterations = LOCK_ITERATIONS } = {}) {
  let verifier = null;   // the stored object, or null when no lock is set
  let unlocked = false;
  let loaded = false;    // until the verifier is read, hidden photos stay out of sight
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener never stops the lock */ } } };

  const lock = {
    ready: Promise.resolve(store?.getKv?.(LOCK_KEY)).then(v => { verifier = v?.salt && v?.hash ? v : null; }).catch(() => {}).finally(() => { loaded = true; }),
    isSet: () => !!verifier,
    isLocked: () => !loaded || (!!verifier && !unlocked),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async set(pass) {
      await lock.ready;
      if (verifier) throw new Error('A lock is already set. Reset it first to choose a new passphrase.');
      if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await derive(crypto, pass, salt, iterations);
      const v = { v: 1, kdf: 'PBKDF2-SHA-256', iterations, salt: b64(salt), hash: b64(hash) };
      await store.setKv(LOCK_KEY, v);
      verifier = v;
      unlocked = false;
      changed();
    },

    async unlock(pass) {
      await lock.ready;
      if (!verifier) return true;
      const hash = await derive(crypto, String(pass ?? ''), unb64(verifier.salt), verifier.iterations ?? LOCK_ITERATIONS);
      if (!sameBytes(hash, unb64(verifier.hash))) return false;
      unlocked = true;
      changed();
      return true;
    },

    lock() { if (verifier && unlocked) { unlocked = false; changed(); } },

    async reset() {
      await store.deleteKv(LOCK_KEY);
      verifier = null;
      unlocked = false;
      changed();
    },

    // Writes the verifier back (Rebuild index clears every kv entry).
    async restore() { if (verifier) await store.setKv(LOCK_KEY, verifier); },
  };
  return lock;
}

export function initLocked(lib, opts) {
  const lock = createLock(lib.store, opts);
  lib.hiddenLocked = () => lock.isLocked();
  lib.services.lock = lock;
  lock.onChange(() => lib.emit('choices', { ids: null, reason: 'lock' }));
  lock.ready.then(() => lib.emit('choices', { ids: null, reason: 'lock' }));
  lib.on('records', (ev) => { if (ev?.reason === 'rebuild') lock.restore().catch(e => lib.emit('error', { message: `Could not keep the lock after the rebuild: ${e.message}` })); });
  return lock;
}
