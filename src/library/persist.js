// Reads and writes the library file, `.slate-library.json`, at the top of each
// root folder (format in libfile.js), and the import-details file beside it,
// `.slate-library-meta.json`, which is written only when import details change (review S15).
//
// createPersist(store) -> { load(root), save(root, libfile, { disk }), canWrite(root) }
//   fsa roots with write permission: the files on disk, written with createWritable().
//   files roots (browse-only), or fsa roots without write permission: the text is
//   kept in store kv under `libfile:<rootId>`, and the person can download it
//   (downloadLibFile) to put it in the folder by hand.
// load() returns null when there is no file yet (a NotFoundError: the folder has no library
// file), and throws when the file cannot be read (no permission yet), so the caller can tell
// "empty" from "not read". It merges the kv copy with the disk copy item by item (review S1),
// so choices kept in kv while the folder was not readable come back without losing the disk's.
// save(root, file, { disk: false }) keeps the file in kv only: Library uses it for a root whose
// file on disk it has not read, so it never replaces a file it has not seen (review S1).
// A file on disk that does not parse is never overwritten: saves for that root go to kv until a reload.

import { LIBRARY_FILE } from './schema.js';
import { parseLibFile, serialiseLibFile, mergeLibFiles, emptyLibFile, LIBRARY_META_FILE, metaFileText, EMPTY_META_TEXT, parseMetaFile, joinMeta, withoutMeta } from './libfile.js';

export const kvKey = (rootId) => `libfile:${rootId}`;

export function createPersist(store) {
  const noWrite = new Set();   // roots whose last write permission check or write failed
  const broken = new Set();    // roots whose file on disk did not parse
  const metaOnDisk = new Map(); // rootId -> the meta file text as last read or written
  const metaCache = new Map();  // rootId -> { stamp, map } so an unchanged meta file is not parsed again

  const isFsa = (root) => root?.mode === 'fsa' && !!root.handle;

  async function hasWrite(root) {
    if (!isFsa(root) || broken.has(root.id)) return false;
    const p = root.handle.queryPermission ? await root.handle.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (p === 'granted') noWrite.delete(root.id); else noWrite.add(root.id);
    return p === 'granted';
  }

  async function readFile(root, name) {
    let fh;
    try { fh = await root.handle.getFileHandle(name); }
    catch (e) { if (e?.name === 'NotFoundError') return null; throw e; }
    return fh.getFile();
  }

  async function writeFile(root, name, text) {
    const fh = await root.handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  async function readMeta(root) {
    const f = await readFile(root, LIBRARY_META_FILE);
    if (!f) { metaCache.delete(root.id); return new Map(); }
    const stamp = `${f.size}:${f.lastModified}`;
    const hit = metaCache.get(root.id);
    if (hit?.stamp === stamp) return hit.map;
    const map = parseMetaFile(await f.text()) ?? new Map();
    metaCache.set(root.id, { stamp, map });
    return map;
  }

  async function readKv(root) {
    const v = await store.getKv(kvKey(root.id));
    return typeof v === 'string' ? v : null;
  }

  return {
    async load(root) {
      const kvText = await readKv(root);
      const kvFile = kvText ? parseLibFile(kvText) : null;
      if (!isFsa(root)) return kvFile?.ok ? kvFile.file : null;
      broken.delete(root.id);
      const diskFile = await readFile(root, LIBRARY_FILE);
      const meta = await readMeta(root);
      let disk = null;
      if (diskFile) {
        const parsed = parseLibFile(await diskFile.text());
        if (!parsed.ok) {
          broken.add(root.id);
          if (kvFile?.ok) return kvFile.file;
          throw new Error(`${LIBRARY_FILE} could not be read (${parsed.error}); Slate will not overwrite it`);
        }
        disk = joinMeta(parsed.file, meta);
      } else if (meta.size) disk = joinMeta(emptyLibFile(), meta);
      // What the meta file itself holds (details still inside an older library file are not in it).
      metaOnDisk.set(root.id, metaFileText({ items: Object.fromEntries([...meta].map(([p, m]) => [p, { meta: m }])) }));
      if (!disk) return kvFile?.ok ? kvFile.file : null;
      // A kv copy holds choices made while the folder could not be written or read.
      return kvFile?.ok ? mergeLibFiles(disk, kvFile.file).file : disk;
    },

    async save(root, libfile, { disk = true } = {}) {
      const text = serialiseLibFile(libfile);
      if (disk && await hasWrite(root)) {
        try {
          // The import details first, and only when they changed, so a crash between the two
          // writes never leaves a library file that points at details that were not written.
          const metaText = metaFileText(libfile);
          const known = metaOnDisk.get(root.id);
          if (known !== undefined ? metaText !== known : metaText !== EMPTY_META_TEXT) {
            await writeFile(root, LIBRARY_META_FILE, metaText);
            metaOnDisk.set(root.id, metaText);
            metaCache.delete(root.id);
          }
          await writeFile(root, LIBRARY_FILE, serialiseLibFile(withoutMeta(libfile)));
          await store.deleteKv(kvKey(root.id));
          return { where: 'disk' };
        } catch (e) {
          if (e?.name !== 'NotAllowedError' && e?.name !== 'SecurityError') throw e;
          noWrite.add(root.id);
        }
      }
      await store.setKv(kvKey(root.id), text);
      return { where: 'kv' };
    },

    // Synchronous best guess from the last check; save() checks again each time.
    canWrite(root) {
      return isFsa(root) && !noWrite.has(root.id) && !broken.has(root.id);
    },
  };
}

// Download the current library file for one root as `.slate-library.json`
// (browse-only folders, or a folder Slate may not write to).
export function downloadLibFile(lib, rootId) {
  const text = serialiseLibFile(lib.libFileFor(rootId));
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = LIBRARY_FILE;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
