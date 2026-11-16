// Reads and writes the library file, `.slate-library.json`, at the top of each
// root folder (format in libfile.js).
//
// createPersist(store) -> { load(root), save(root, libfile), canWrite(root) }
//   fsa roots with write permission: the file on disk, written with createWritable().
//   files roots (browse-only), or fsa roots without write permission: the text is
//   kept in store kv under `libfile:<rootId>`, and the person can download it
//   (downloadLibFile) to put it in the folder by hand.
// load() returns null when there is no file yet. A file on disk that does not
// parse is never overwritten: saves for that root go to kv until a reload.

import { LIBRARY_FILE } from './schema.js';
import { parseLibFile, serialiseLibFile } from './libfile.js';

export const kvKey = (rootId) => `libfile:${rootId}`;

export function createPersist(store) {
  const noWrite = new Set();   // roots whose last write permission check or write failed
  const broken = new Set();    // roots whose file on disk did not parse

  const isFsa = (root) => root?.mode === 'fsa' && !!root.handle;

  async function hasWrite(root) {
    if (!isFsa(root) || broken.has(root.id)) return false;
    const p = root.handle.queryPermission ? await root.handle.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (p === 'granted') noWrite.delete(root.id); else noWrite.add(root.id);
    return p === 'granted';
  }

  async function readDisk(root) {
    let fh;
    try { fh = await root.handle.getFileHandle(LIBRARY_FILE); }
    catch (e) { if (e?.name === 'NotFoundError') return null; throw e; }
    return (await fh.getFile()).text();
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
      const diskText = await readDisk(root);
      if (diskText == null) return kvFile?.ok ? kvFile.file : null;
      const disk = parseLibFile(diskText);
      if (!disk.ok) {
        broken.add(root.id);
        if (kvFile?.ok) return kvFile.file;
        throw new Error(`${LIBRARY_FILE} could not be read (${disk.error}); Slate will not overwrite it`);
      }
      // A kv copy is newer when choices were made while the folder was read-only.
      if (kvFile?.ok && (kvFile.file.updated ?? '') > (disk.file.updated ?? '')) return kvFile.file;
      return disk.file;
    },

    async save(root, libfile) {
      const text = serialiseLibFile(libfile);
      if (await hasWrite(root)) {
        try {
          const fh = await root.handle.getFileHandle(LIBRARY_FILE, { create: true });
          const w = await fh.createWritable();
          await w.write(text);
          await w.close();
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
