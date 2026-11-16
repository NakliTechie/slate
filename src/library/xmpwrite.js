// Writing XMP sidecars (spec row M5): when the setting "Write XMP sidecars" is
// on, Slate writes `<photo name>.xmp` (the full-name form, `IMG_1.jpg.xmp`)
// beside each photo whose choices change, so Lightroom, digiKam and darktable
// see the same rating, reject and tags. The original photo is never opened for
// writing. Browse-only folders and folders without write permission are skipped.
//
// initXmpWrite(lib, { delay }) -> { enabled(), setEnabled(on), flush(), ready }
//   Also sets lib.services.xmpWrite to that object, so the storage panel can
//   show and change the setting. The setting lives in lib.store kv under
//   'setting:xmpWrite' (default off).
//
// What is written: buildXmp() from xmp.js with the photo's rating as the
// library shows it, reject as -1, and every tag (from the files and from
// Slate). An existing sidecar is merged: only those properties change. When
// only the stem form (`IMG_1.xmp`) exists, its text seeds the new full-name file.

import { buildXmp, sidecarNames } from './xmp.js';

export const XMP_SETTING_KEY = 'setting:xmpWrite';
const DELAY_MS = 1500;

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch (e) { if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') return null; throw e; }
}

export function initXmpWrite(lib, { delay = DELAY_MS } = {}) {
  let on = false;
  const pending = new Set();
  let timer = null;

  const ready = Promise.resolve(lib.store?.getKv?.(XMP_SETTING_KEY)).then(v => { on = v === true; }).catch(() => {});

  lib.on('choices', ({ ids } = {}) => {
    // ids is null for a library-file load or a moved-file rematch; those are not edits.
    if (!on || !Array.isArray(ids) || !ids.length) return;
    for (const id of ids) pending.add(id);
    clearTimeout(timer);
    timer = setTimeout(() => { api.flush().catch(e => lib.emit('error', { message: `Could not write XMP sidecars: ${e.message}` })); }, delay);
  });

  async function writeOne(id, perms) {
    const r = lib.get(id);
    if (!r || r.missing) return false;
    const c = lib.choice(id);
    if (c.trashed) return false;
    const root = lib.roots.get(r.rootId);
    if (!root || root.mode !== 'fsa' || !root.handle) return false;
    if (!perms.has(root.id)) {
      const p = root.handle.queryPermission ? await root.handle.queryPermission({ mode: 'readwrite' }) : 'granted';
      perms.set(root.id, p === 'granted');
    }
    if (!perms.get(root.id)) return false;
    const dir = await lib.getHandle(id, { parent: true });
    const [full, stem] = sidecarNames(r.name);
    const existing = (await readText(dir, full)) ?? (stem ? await readText(dir, stem) : null);
    const text = buildXmp({ rating: lib.rating(id), flag: c.flag, tags: lib.tagsOf(id), existing });
    if (text === existing) return false;
    const fh = await dir.getFileHandle(full, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }

  const api = {
    ready,
    enabled: () => on,
    async setEnabled(v) {
      on = !!v;
      if (!on) { clearTimeout(timer); pending.clear(); }
      await lib.store?.setKv?.(XMP_SETTING_KEY, on);
    },
    // Write every pending sidecar now. Returns the number of files written.
    async flush() {
      clearTimeout(timer);
      timer = null;
      const ids = [...pending];
      pending.clear();
      const perms = new Map();
      let written = 0;
      for (const id of ids) {
        try { if (await writeOne(id, perms)) written++; }
        catch (e) { lib.emit('error', { message: `Could not write the XMP sidecar for ${lib.get(id)?.path ?? id}: ${e.message}` }); }
      }
      return written;
    },
  };
  lib.services.xmpWrite = api;
  return api;
}
