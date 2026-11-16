// Trash: a trashed photo moves to `<root>/.slate-trash/<path>`, keeping its
// folders, and its XMP sidecar moves with it. Restore moves it back and refuses
// to overwrite a file that now sits at the original path. Purge deletes it from
// the trash; that is the only permanent delete in the library.
//
// createTrash() -> { move(root, path), restore(root, path), purge(root, path) }
//
// Moves use FileSystemHandle.move() where the browser has it; otherwise the
// file is copied, then the original removed.
//
// Sidecars: the full-name form (`IMG_1.jpg.xmp`) always travels with its photo.
// The stem form (`IMG_1.xmp`) travels only when no other photo in that folder
// shares the stem, because `IMG_1.jpg` and `IMG_1.dng` may both use it.

import { TRASH_DIR, normPath, kindOf } from './schema.js';
import { sidecarNames } from './xmp.js';

function split(path) {
  const parts = normPath(path).split('/');
  const name = parts.pop();
  return { dirs: parts, name };
}

async function walk(dir, parts, create = false) {
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (e) {
    if (e?.name === 'NotFoundError') return false;
    if (e?.name === 'TypeMismatchError') return true; // a folder with that name
    throw e;
  }
}

async function moveFile(fromDir, name, toDir) {
  const fh = await fromDir.getFileHandle(name);
  if (typeof fh.move === 'function') { await fh.move(toDir, name); return; }
  const file = await fh.getFile();
  const out = await toDir.getFileHandle(name, { create: true });
  const w = await out.createWritable();
  await w.write(file);
  await w.close();
  await fromDir.removeEntry(name);
}

// Sidecar names in `dir` that belong to `name` (see the stem rule above).
async function sidecarsOf(dir, name) {
  const [full, stem] = sidecarNames(name);
  const out = [];
  if (await exists(dir, full)) out.push(full);
  if (stem && await exists(dir, stem)) {
    const s = stem.slice(0, -4);
    let shared = false;
    for await (const [n, h] of dir.entries()) {
      if (n === name || h.kind !== 'file' || !kindOf(n)) continue;
      if (n.slice(0, n.lastIndexOf('.')) === s) { shared = true; break; }
    }
    if (!shared) out.push(stem);
  }
  return out;
}

function needHandle(root) {
  if (!root?.handle) throw new Error('this folder is browse-only, so Slate cannot move its files');
  return root.handle;
}

export function createTrash() {
  return {
    async move(root, path) {
      const top = needHandle(root);
      const { dirs, name } = split(path);
      const from = await walk(top, dirs);
      const to = await walk(top, [TRASH_DIR, ...dirs], true);
      if (await exists(to, name)) throw new Error(`a file named ${name} is already in the trash for this folder`);
      const sidecars = await sidecarsOf(from, name);
      await moveFile(from, name, to);
      for (const s of sidecars) if (!(await exists(to, s))) await moveFile(from, s, to);
    },

    async restore(root, path) {
      const top = needHandle(root);
      const { dirs, name } = split(path);
      const from = await walk(top, [TRASH_DIR, ...dirs]);
      const to = await walk(top, dirs, true);
      if (await exists(to, name)) throw new Error(`${normPath(path)} already exists, so the trashed copy was left in the trash`);
      const sidecars = await sidecarsOf(from, name);
      await moveFile(from, name, to);
      for (const s of sidecars) if (!(await exists(to, s))) await moveFile(from, s, to);
    },

    async purge(root, path) {
      const top = needHandle(root);
      const { dirs, name } = split(path);
      const dir = await walk(top, [TRASH_DIR, ...dirs]);
      const sidecars = await sidecarsOf(dir, name);
      await dir.removeEntry(name);
      for (const s of sidecars) await dir.removeEntry(s);
    },
  };
}
