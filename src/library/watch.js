// Watch folders for changes (row L9). Where the browser has FileSystemObserver (experimental,
// Chrome only today), each fsa root is observed recursively, and a change rescans only that root,
// after a quiet spell of DEBOUNCE_MS. Where it does not, nothing happens and the rescan on open stays
// the baseline. Changes inside dot-folders and to dot-files (the library file, .slate-trash) are
// ignored, so Slate's own writes never trigger a rescan.
//
//   initWatch(lib, { Observer, delay }) -> { status() -> 'watching'|'unavailable', stop() }

import { isSkippedDir } from './schema.js';

export const DEBOUNCE_MS = 1500;

let current = null;
// The status for the storage panel: 'watching' when at least one folder is observed.
export function status() { return current ? current.status() : 'unavailable'; }

export function initWatch(lib, { Observer = globalThis.FileSystemObserver, delay = DEBOUNCE_MS } = {}) {
  const watched = new Map(); // rootId -> { observer, timer }
  const api = { status: () => (Observer && watched.size ? 'watching' : 'unavailable'), stop };
  current = api;
  if (typeof Observer !== 'function') return api;

  const relevant = (records) => records.some(r => {
    const parts = r.relativePathComponents || [];
    return !parts.some(p => isSkippedDir(p));
  });

  function schedule(rootId) {
    const w = watched.get(rootId);
    if (!w) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      if (!lib.roots.has(rootId)) return;
      Promise.resolve(lib.rescan(rootId)).catch(e => console.warn('[slate library] rescan after a change failed', e));
    }, delay);
  }

  async function sync() {
    for (const [id, w] of watched) {
      if (lib.roots.get(id)?.handle) continue;
      clearTimeout(w.timer); w.observer.disconnect(); watched.delete(id);
    }
    for (const root of lib.roots.values()) {
      if (!root.handle || watched.has(root.id)) continue;
      const observer = new Observer((records) => { if (relevant(records)) schedule(root.id); });
      watched.set(root.id, { observer, timer: null });
      try { await observer.observe(root.handle, { recursive: true }); }
      catch (e) {
        // No permission yet, or the folder is gone: try again when the roots change.
        console.warn('[slate library] cannot watch', root.name, e);
        observer.disconnect(); watched.delete(root.id);
      }
    }
  }

  // A root whose permission came back (Reconnect) is picked up after its next scan.
  const offs = [
    lib.on('roots', () => { api.ready = sync(); }),
    lib.on('records', (e) => {
      if (e?.reason === 'scan' && [...lib.roots.values()].some(r => r.handle && !watched.has(r.id))) api.ready = sync();
    }),
  ];
  api.ready = sync();

  function stop() {
    for (const off of offs) off();
    for (const w of watched.values()) { clearTimeout(w.timer); w.observer.disconnect(); }
    watched.clear();
    if (current === api) current = null;
  }
  return api;
}
