// Watch folders for changes (row L9). Where the browser has FileSystemObserver (experimental,
// Chrome only today), each fsa root is observed recursively, and after a quiet spell of DEBOUNCE_MS
// the changed paths of that root are rescanned (lib.rescan(rootId, { paths })). A record of type
// 'unknown' or 'errored', or one without a path, rescans the whole root. Where the browser has no
// observer, nothing happens and the rescan on open stays the baseline.
// Ignored, so Slate's own writes never trigger a rescan: changes inside dot-folders and to
// dot-files (the library file, .slate-trash), and paths on the library's self-write list
// (lib.isSelfWrite: XMP sidecars, moves and renames Slate made in the last few seconds).
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

  // Adds what the records ask for to w (w.whole, or paths in w.paths); true when anything did.
  function collect(rootId, w, records) {
    let any = false;
    for (const r of records) {
      if (r.type === 'unknown' || r.type === 'errored' || !r.relativePathComponents) { w.whole = true; any = true; continue; }
      for (const parts of [r.relativePathComponents, r.relativePathMovedFrom]) {
        if (!parts?.length || parts.some(p => isSkippedDir(p))) continue;
        const path = parts.join('/');
        if (lib.isSelfWrite?.(rootId, path)) continue;
        w.paths.add(path); any = true;
      }
    }
    return any;
  }

  function schedule(rootId) {
    const w = watched.get(rootId);
    if (!w) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      const paths = w.whole ? null : [...w.paths];
      w.whole = false; w.paths = new Set();
      if (!lib.roots.has(rootId)) return;
      Promise.resolve(paths ? lib.rescan(rootId, { paths }) : lib.rescan(rootId)).catch(e => console.warn('[slate library] rescan after a change failed', e));
    }, delay);
  }

  async function sync() {
    for (const [id, w] of watched) {
      if (lib.roots.get(id)?.handle) continue;
      clearTimeout(w.timer); w.observer.disconnect(); watched.delete(id);
    }
    for (const root of lib.roots.values()) {
      if (!root.handle || watched.has(root.id)) continue;
      const w = { observer: null, timer: null, whole: false, paths: new Set() };
      const observer = w.observer = new Observer((records) => { if (collect(root.id, w, records)) schedule(root.id); });
      watched.set(root.id, w);
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
