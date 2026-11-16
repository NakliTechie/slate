// Read text in photos (spec row X3). When the setting "Read text in photos" is on,
// Slate runs Tesseract.js (src/ops/ocr.js) over every photo in the library through
// lib.jobs (kind 'ocr', so the Pause button pauses it), and the search box then
// also matches the words it found. "Read text" in the action bar runs it now for
// the selection, whether the setting is on or not.
//
// The text stays in this browser: lib.store kv under 'textindex', one object of
// id -> { t: text, s: "size:mtime" }. It is never written to the library file.
// A photo whose size or modified time changes is read again.
//
// initTextIndex(lib, { recognise, loadImage, saveDelay }) -> api
//   api.ready              resolves once the setting and the text are loaded
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
export const TEXT_INDEX_KEY = 'textindex';
const SAVE_DELAY_MS = 2000;

const sigOf = (r) => `${r.size}:${r.mtime}`;

export function initTextIndex(lib, { recognise = (b) => extractText(b), loadImage = ocrImage, saveDelay = SAVE_DELAY_MS } = {}) {
  const entries = new Map();   // id -> { t, s }
  const queued = new Set();    // ids waiting or running in lib.jobs
  const changed = new Set();   // ids read since the last save
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
    lib.jobs.add('ocr', ids.map(id => ({ id })), readOne);
  }

  function enqueueAll() { add([...lib.records.keys()].filter(needs)); }

  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(() => { api.flush().catch(e => lib.emit('error', { message: `Could not save the text read from photos: ${e.message}` })); }, saveDelay);
  }

  const api = {
    ready: null,
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
      entries.clear(); changed.clear();
      await kv('deleteKv', TEXT_INDEX_KEY);
      lib.emit('text', { ids: null });
    },
    async flush() {
      clearTimeout(timer);
      const ids = [...changed]; changed.clear();
      await kv('setKv', TEXT_INDEX_KEY, Object.fromEntries(entries));
      lib.emit('text', { ids });
    },
  };

  api.ready = Promise.all([kv('getKv', TEXT_SETTING_KEY), kv('getKv', TEXT_INDEX_KEY)])
    .then(([setting, saved]) => {
      on = setting === true;
      for (const [id, e] of Object.entries(saved ?? {})) if (!entries.has(id)) entries.set(id, e);
      if (on && lib.records.size) enqueueAll();
    }).catch(() => {});

  lib.on('records', (ev = {}) => {
    // Rebuild clears every kv entry; write the setting and the text back.
    if (ev.reason === 'rebuild') {
      kv('setKv', TEXT_SETTING_KEY, on).catch(() => {});
      if (entries.size) scheduleSave();
    }
    if (Array.isArray(ev.ids)) {
      for (const id of ev.ids) if (!lib.records.has(id) && entries.delete(id)) scheduleSave();
      if (on) add(ev.ids.filter(needs));
    } else if (on) enqueueAll();
  });

  lib.textOf = api.textOf;
  lib.services.textIndex = api;
  return api;
}
