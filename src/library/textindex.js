// Read text in photos (spec row X3). When the setting "Read text in photos" is on,
// Slate runs Tesseract.js (src/ops/ocr.js) over every photo in the library through
// lib.jobs (kind 'ocr', so the Pause button pauses it), and the search box then
// also matches the words it found. "Read text" in the action bar runs it now for
// the selection, whether the setting is on or not.
//
// The text stays in this browser: lib.store kv, one key per photo,
// 'textindex:<id>' -> { t: text, s: "size:mtime" }, so a save writes only the photos
// read since the last save (review S15). It is never written to the library file.
// A photo whose size or modified time changes is read again. The store cannot list
// keys, so each record's key is read when the record first appears (load or scan).
// An older build kept one object under 'textindex'; it is split into per-photo keys
// once and deleted.
//
// initTextIndex(lib, { recognise, loadImage, saveDelay }) -> api
//   api.ready              resolves once the setting and the stored text of the known records are loaded
//   api.enabled() / api.setEnabled(on)
//   api.textOf(id)         the text read from that photo, '' when it has none, undefined when unread
//   api.runFor(ids)        read these photos first; returns how many were queued
//   api.count()            how many photos have been read
//   api.forget()           delete every stored text
//   api.flush()            write the text now
// It also sets lib.textOf (the hook query.js reads as `opts.textOf`) and
// lib.services.textIndex, and emits lib 'text' { ids } after each save.
// `recognise(blob) -> { text }` and `loadImage(file) -> blob` default to ocr.js; tests pass fakes.

import { extractText, ocrImage } from '../ops/ocr.js';

export const TEXT_SETTING_KEY = 'setting:readText';
export const TEXT_INDEX_KEY = 'textindex';            // older single-object form, read once and removed
export const TEXT_KEY_PREFIX = 'textindex:';
export const textKey = (id) => TEXT_KEY_PREFIX + id;
const PROBE_BATCH = 500;
const SAVE_DELAY_MS = 2000;

const sigOf = (r) => `${r.size}:${r.mtime}`;

export function initTextIndex(lib, { recognise = (b) => extractText(b), loadImage = ocrImage, saveDelay = SAVE_DELAY_MS } = {}) {
  const entries = new Map();   // id -> { t, s }
  const queued = new Set();    // ids waiting or running in lib.jobs
  const changed = new Set();   // ids read since the last save
  const probed = new Set();    // ids whose kv key has been read
  let on = false;
  let timer = null;

  const kv = (fn, ...a) => Promise.resolve(lib.store?.[fn]?.(...a));

  const eligible = (r) => !!r && r.kind === 'photo' && !r.missing && !lib.choice(r.id).trashed;
  const needs = (id) => { const r = lib.get(id); return eligible(r) && !queued.has(id) && entries.get(id)?.s !== sigOf(r); };

  async function readOne({ id }, signal) {
    try {
      const r = lib.get(id);
      if (signal?.aborted || !eligible(r)) return;
      const img = await loadImage(await lib.getFile(id));
      if (signal?.aborted) return;
      const { text } = await recognise(img);
      entries.set(id, { t: String(text ?? ''), s: sigOf(r) });
      changed.add(id);
      scheduleSave();
    } finally { queued.delete(id); }
  }

  function add(ids) {
    if (!ids.length) return;
    for (const id of ids) queued.add(id);
    lib.jobs.add('ocr', ids.map(id => ({ id })), readOne, { lane: 'background' });
  }

  function enqueueAll() { add([...lib.records.keys()].filter(needs)); }

  // Read the stored text of records not seen yet. Runs in batches so a 100,000-photo
  // library does not open 100,000 requests at once.
  async function probe(ids) {
    const todo = ids.filter(id => !probed.has(id) && !entries.has(id));
    for (const id of todo) probed.add(id);
    for (let i = 0; i < todo.length; i += PROBE_BATCH) {
      const part = todo.slice(i, i + PROBE_BATCH);
      const got = await Promise.all(part.map(id => kv('getKv', textKey(id)).catch(() => undefined)));
      part.forEach((id, k) => { if (got[k] && !entries.has(id)) entries.set(id, got[k]); });
    }
  }

  // Loads run one after another; api.ready is the latest of them.
  let chain = Promise.resolve();
  function after(fn) { chain = chain.then(fn).catch(() => {}); return chain; }

  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(() => { api.flush().catch(e => lib.emit('error', { message: `Could not save the text read from photos: ${e.message}` })); }, saveDelay);
  }

  const api = {
    enabled: () => on,
    async setEnabled(value) {
      on = !!value;
      await kv('setKv', TEXT_SETTING_KEY, on);
      if (on) enqueueAll();
      else { lib.jobs.cancel('ocr'); queued.clear(); }
    },
    textOf: (id) => entries.get(id)?.t,
    count: () => entries.size,
    // Puts these photos ahead of the rest of the queue.
    runFor(ids) {
      const first = [...new Set(ids)].filter(id => eligible(lib.get(id)) && entries.get(id)?.s !== sigOf(lib.get(id)));
      const rest = [...queued].filter(id => !first.includes(id));
      if (queued.size) { lib.jobs.cancel('ocr'); queued.clear(); }
      add(first);
      add(rest.filter(needs));
      return first.length;
    },
    async forget() {
      clearTimeout(timer);
      const ids = new Set([...entries.keys(), ...probed]);
      entries.clear(); changed.clear();
      await Promise.all([...ids].map(id => kv('deleteKv', textKey(id))));
      await kv('deleteKv', TEXT_INDEX_KEY);
      lib.emit('text', { ids: null });
    },
    // Writes one kv key for each photo read since the last save, and nothing else.
    async flush() {
      clearTimeout(timer);
      const ids = [...changed]; changed.clear();
      for (const id of ids) {
        const e = entries.get(id);
        await kv(e ? 'setKv' : 'deleteKv', textKey(id), e);
      }
      lib.emit('text', { ids });
    },
  };
  Object.defineProperty(api, 'ready', { get: () => chain, enumerable: true });

  after(async () => {
    const [setting, legacy] = await Promise.all([kv('getKv', TEXT_SETTING_KEY), kv('getKv', TEXT_INDEX_KEY)]);
    on = setting === true;
    if (legacy && typeof legacy === 'object') {
      for (const [id, e] of Object.entries(legacy)) if (!entries.has(id)) { entries.set(id, e); probed.add(id); changed.add(id); }
      await api.flush();
      await kv('deleteKv', TEXT_INDEX_KEY);
    }
    await probe([...lib.records.keys()]);
    if (on && lib.records.size) enqueueAll();
  });

  lib.on('records', (ev = {}) => {
    // Rebuild clears the kv store (store.keepKv keeps settings); write the setting and every text back.
    if (ev.reason === 'rebuild') {
      kv('setKv', TEXT_SETTING_KEY, on).catch(() => {});
      for (const id of entries.keys()) changed.add(id);
      if (entries.size) scheduleSave();
    }
    if (Array.isArray(ev.ids)) {
      const ids = ev.ids;
      for (const id of ids) if (!lib.records.has(id) && entries.delete(id)) { changed.add(id); scheduleSave(); }
      after(async () => { await probe(ids.filter(id => lib.records.has(id))); if (on) add(ids.filter(needs)); });
    } else {
      after(async () => { await probe([...lib.records.keys()]); if (on) enqueueAll(); });
    }
  });

  lib.textOf = api.textOf;
  lib.services.textIndex = api;
  return api;
}
