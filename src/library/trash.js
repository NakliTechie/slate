// Trash: a trashed photo moves to `<root>/.slate-trash/<path>`, keeping its
// folders, and its XMP sidecar moves with it. Restore moves it back and refuses
// to overwrite a file that now sits at the original path. Purge deletes it from
// the trash; that is the only permanent delete in the library.
//
// createTrash() -> { move(root, path), restore(root, path), purge(root, path) }
//   move and restore return { renamed: [{ from, to }] }: a sidecar whose name was already taken
//   in the target folder is moved under a free name, `IMG_1.jpg (2).xmp`, so both are kept
//   (review S27).
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

async function moveFile(fromDir, name, toDir, newName = name) {
  const fh = await fromDir.getFileHandle(name);
  if (typeof fh.move === 'function') { await fh.move(toDir, newName); return; }
  const file = await fh.getFile();
  const out = await toDir.getFileHandle(newName, { create: true });
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

// `name`, or `stem (2).ext`, `stem (3).ext` ... whichever is free in `dir`.
async function freeName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const i = name.lastIndexOf('.');
  const stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : '';
  for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!(await exists(dir, c))) return c; }
}

// Move the sidecars after their photo, keeping both copies when a name is taken.
async function moveSidecars(from, to, sidecars) {
  const renamed = [];
  for (const s of sidecars) {
    const n = await freeName(to, s);
    await moveFile(from, s, to, n);
    if (n !== s) renamed.push({ from: s, to: n });
  }
  return { renamed };
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
      return moveSidecars(from, to, sidecars);
    },

    async restore(root, path) {
      const top = needHandle(root);
      const { dirs, name } = split(path);
      const from = await walk(top, [TRASH_DIR, ...dirs]);
      const to = await walk(top, dirs, true);
      if (await exists(to, name)) throw new Error(`${normPath(path)} already exists, so the trashed copy was left in the trash`);
      const sidecars = await sidecarsOf(from, name);
      await moveFile(from, name, to);
      return moveSidecars(from, to, sidecars);
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
