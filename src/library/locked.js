// Locked hidden photos (spec row O9). "Lock hidden photos" sets a passphrase; from
// then on every hidden photo is out of sight until the passphrase is entered, once per
// session (the unlocked state lives in memory only, so a reload locks again).
//
// What it does: initLocked installs lib.visible(id), the one check every reader uses
// (search, Duplicates, People, the photo.* and album.* commands, the face and CLIP jobs).
// It is false for a hidden photo while the lock is set and not unlocked. lib.search()
// also leaves such photos out. What it does not do: the files are not encrypted, and
// each folder's library file keeps its "hidden" entries as before. It hides photos from
// casual viewers of this browser; anyone with the folder sees every file.
//
// The verifier lives in lib.store kv under 'lock:hidden':
//   { v: 1, kdf: 'PBKDF2-SHA-256', iterations: 600000, salt: base64 (16 bytes), hash: base64 (32 bytes) }
// Removing the lock needs the current passphrase (lock.remove(pass)).
//
// A forgotten passphrase (lock.forgot(newPass, hiddenIds)): the photos hidden at that
// moment stay hidden and sealed under the old passphrase, and the new passphrase locks
// photos hidden from then on. So "Forgot the passphrase" shows a casual viewer nothing.
// A sealed photo opens again only with the old passphrase, or when someone with the
// folder removes its "hidden" mark in .slate-library.json. Seals live in kv 'lock:sealed':
//   [{ iterations, salt, hash, ids: [photo id] }]
//
// createLock(store, { crypto, iterations }) -> lock (no library needed; the tests use this)
//   lock.ready, lock.isSet(), lock.isLocked(), lock.set(pass), lock.unlock(pass) -> boolean,
//   lock.lock(), lock.remove(pass) -> boolean, lock.forgot(newPass, ids), lock.sealed(id),
//   lock.sealedCount(), lock.onChange(fn)
// initLocked(lib) -> lock, and sets lib.hiddenLocked(), lib.visible(id) and lib.services.lock.
// Each change emits lib 'choices' { ids: null, reason: 'lock' } so the views query again.

export const LOCK_KEY = 'lock:hidden';
export const SEALED_KEY = 'lock:sealed';
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
  let seals = [];        // [{ iterations, salt, hash, ids: Set, open }]
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener never stops the lock */ } } };

  const matches = async (v, pass) => sameBytes(await derive(crypto, String(pass ?? ''), unb64(v.salt), v.iterations ?? LOCK_ITERATIONS), unb64(v.hash));
  const makeVerifier = async (pass) => {
    if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(crypto, pass, salt, iterations);
    return { v: 1, kdf: 'PBKDF2-SHA-256', iterations, salt: b64(salt), hash: b64(hash) };
  };
  const saveSeals = () => seals.length
    ? store.setKv(SEALED_KEY, seals.map(s => ({ iterations: s.iterations, salt: s.salt, hash: s.hash, ids: [...s.ids] })))
    : store.deleteKv(SEALED_KEY);

  const lock = {
    ready: Promise.all([store?.getKv?.(LOCK_KEY), store?.getKv?.(SEALED_KEY)]).then(([v, s]) => {
      verifier = v?.salt && v?.hash ? v : null;
      seals = Array.isArray(s) ? s.filter(x => x?.salt && x?.hash).map(x => ({ ...x, ids: new Set(x.ids ?? []), open: false })) : [];
    }).catch(() => {}).finally(() => { loaded = true; }),
    isSet: () => !!verifier,
    isLocked: () => !loaded || (!!verifier && !unlocked),
    // A sealed photo stays out of sight until the passphrase of its seal is entered.
    sealed: (id) => !loaded || seals.some(s => !s.open && s.ids.has(id)),
    sealedCount: () => seals.reduce((n, s) => n + (s.open ? 0 : s.ids.size), 0),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async set(pass) {
      await lock.ready;
      if (verifier) throw new Error('A lock is already set. Remove it first to choose a new passphrase.');
      const v = await makeVerifier(pass);
      await store.setKv(LOCK_KEY, v);
      verifier = v;
      unlocked = false;
      changed();
    },

    // Opens the lock and any seal whose passphrase this is. True when something opened,
    // or when there is nothing to open.
    async unlock(pass) {
      await lock.ready;
      let ok = !verifier && !seals.some(s => !s.open);
      if (verifier && !unlocked && await matches(verifier, pass)) { unlocked = true; ok = true; }
      else if (verifier && unlocked) ok = ok || await matches(verifier, pass);
      for (const s of seals) if (!s.open && await matches(s, pass)) { s.open = true; ok = true; }
      if (ok) changed();
      return ok;
    },

    lock() {
      let any = false;
      if (verifier && unlocked) { unlocked = false; any = true; }
      for (const s of seals) if (s.open) { s.open = false; any = true; }
      if (any) changed();
    },

    // Removes the lock, only with the current passphrase. Seals under the same passphrase go too.
    async remove(pass) {
      await lock.ready;
      if (!verifier) return true;
      if (!await matches(verifier, pass)) return false;
      const keep = [];
      for (const s of seals) if (!await matches(s, pass)) keep.push(s);
      seals = keep;
      await saveSeals();
      await store.deleteKv(LOCK_KEY);
      verifier = null;
      unlocked = false;
      changed();
      return true;
    },

    // A forgotten passphrase: the photos hidden now (`ids`) stay sealed under the old
    // passphrase, and `newPass` becomes the lock for photos hidden from now on.
    async forgot(newPass, ids = []) {
      await lock.ready;
      const v = await makeVerifier(newPass);
      if (verifier) {
        const sealIds = new Set([...ids].filter(id => !seals.some(s => s.ids.has(id))));
        if (sealIds.size) seals.push({ iterations: verifier.iterations ?? LOCK_ITERATIONS, salt: verifier.salt, hash: verifier.hash, ids: sealIds, open: false });
        await saveSeals();
      }
      await store.setKv(LOCK_KEY, v);
      verifier = v;
      unlocked = false;
      changed();
    },

    // Writes the verifier and the seals back (Rebuild index clears every kv entry).
    async restore() {
      if (verifier) await store.setKv(LOCK_KEY, verifier);
      if (seals.length) await saveSeals();
    },
  };
  return lock;
}

export function initLocked(lib, opts) {
  const lock = createLock(lib.store, opts);
  lib.hiddenLocked = () => lock.isLocked();
  lib.visible = (id) => {
    if (!lib.choice(id).hidden) return true;
    return !lock.isLocked() && !lock.sealed(id);
  };
  // The library's own search leaves out every hidden photo while locked (query.js
  // lockHidden); sealed photos are left out here, because they stay sealed after an unlock.
  const search = lib.search.bind(lib);
  lib.search = (o) => { const out = search(o); return lock.sealedCount() ? out.filter(r => lib.visible(r.id)) : out; };
  lib.services.lock = lock;
  lock.forgotPassphrase = (newPass) => lock.forgot(newPass, [...lib.records.keys()].filter(id => lib.choice(id).hidden));
  lock.onChange(() => lib.emit('choices', { ids: null, reason: 'lock' }));
  lock.ready.then(() => lib.emit('choices', { ids: null, reason: 'lock' }));
  lib.on('records', (ev) => { if (ev?.reason === 'rebuild') lock.restore().catch(e => lib.emit('error', { message: `Could not keep the lock after the rebuild: ${e.message}` })); });
  return lock;
}
