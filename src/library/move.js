// Move or rename files inside one root folder (spec row O10). The photo's XMP
// sidecar travels with it and is renamed to match, as trash.js does for the trash.
//
// createMove() -> { exists(root, path), move(root, fromPath, toPath) }
//
// `move` refuses to overwrite: it throws when a file (or folder) already sits at
// the target path, or at the target path of a sidecar. Folders on the way to the
// target are created. It uses FileSystemHandle.move() where the browser has it;
// otherwise it copies the file, then removes the original.
//
// Sidecars: the full-name form (`IMG_1.jpg.xmp`) always travels and becomes
// `<new name>.xmp`. The stem form (`IMG_1.xmp`) travels and becomes `<new stem>.xmp`
// only when no other photo in the folder shares the stem (`IMG_1.jpg` beside
// `IMG_1.dng`); a shared stem sidecar stays with the other photo.

import { normPath, kindOf } from './schema.js';
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

async function existsIn(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (e) {
    if (e?.name === 'NotFoundError') return false;
    if (e?.name === 'TypeMismatchError') return true; // a folder with that name
    throw e;
  }
}

async function moveOne(fromDir, name, toDir, newName) {
  const fh = await fromDir.getFileHandle(name);
  if (typeof fh.move === 'function') { await fh.move(toDir, newName); return; }
  const file = await fh.getFile();
  const out = await toDir.getFileHandle(newName, { create: true });
  const w = await out.createWritable();
  await w.write(file);
  await w.close();
  await fromDir.removeEntry(name);
}

const stemOf = n => { const i = n.lastIndexOf('.'); return i < 0 ? n : n.slice(0, i); };

// [[oldSidecarName, newSidecarName]] for the photo `name` in `dir` moving to `newName`.
async function sidecarPairs(dir, name, newName) {
  const [full, stem] = sidecarNames(name);
  const out = [];
  if (await existsIn(dir, full)) out.push([full, newName + '.xmp']);
  if (stem && await existsIn(dir, stem)) {
    const s = stemOf(name);
    let shared = false;
    for await (const [n, h] of dir.entries()) {
      if (n === name || h.kind !== 'file' || !kindOf(n)) continue;
      if (stemOf(n) === s) { shared = true; break; }
    }
    if (!shared) out.push([stem, stemOf(newName) + '.xmp']);
  }
  return out;
}

function needHandle(root) {
  if (!root?.handle) throw new Error('this folder is browse-only, so Slate cannot move its files');
  return root.handle;
}

// Only a change of letter case: on a case-insensitive disk the target "exists"
// because it is the same file.
const sameIgnoringCase = (a, b) => a !== b && a.toLowerCase() === b.toLowerCase();

export function createMove() {
  return {
    async exists(root, path) {
      const { dirs, name } = split(path);
      let dir;
      try { dir = await walk(needHandle(root), dirs); }
      catch (e) { if (e?.name === 'NotFoundError') return false; if (e?.name === 'TypeMismatchError') return true; throw e; }
      return existsIn(dir, name);
    },

    async move(root, fromPath, toPath) {
      const top = needHandle(root);
      const a = split(fromPath), b = split(toPath);
      if (normPath(fromPath) === normPath(toPath)) return;
      const from = await walk(top, a.dirs);
      const to = await walk(top, b.dirs, true);
      const caseOnly = sameIgnoringCase(normPath(fromPath), normPath(toPath));
      if (!caseOnly && await existsIn(to, b.name)) throw new Error(`${normPath(toPath)} already exists, so ${a.name} was not moved`);
      const pairs = await sidecarPairs(from, a.name, b.name);
      for (const [, n] of pairs) {
        if (!caseOnly && await existsIn(to, n)) throw new Error(`a sidecar named ${n} already exists there, so ${a.name} was not moved`);
      }
      await moveOne(from, a.name, to, b.name);
      for (const [o, n] of pairs) await moveOne(from, o, to, n);
    },
  };
}

// ── rename templates ─────────────────────────────────────────────────────────
// renderName(template, record, n, width) -> the new file name, keeping the
// record's extension. Fields:
//   {name}    the current name without its extension
//   {date}    capture date YYYY-MM-DD ("undated" when the record has no time)
//   {time}    capture time HHmmss (empty when the record has no time)
//   {n}       the counter, zero-padded to `width` digits
//   {camera}  "Make Model" (empty when unknown)
// Characters a file name cannot hold become "_"; a separator doubled by an empty
// field is collapsed ("{date}_{time}_{n}" with no time gives "undated_001").
export const RENAME_FIELDS = ['name', 'date', 'time', 'n', 'camera'];

export function renderName(template, rec, n = 1, width = 3) {
  const t = String(template ?? '');
  if (!t.trim()) throw new Error('give a name template, such as {date}_{n}');
  if (/[/\\]/.test(t)) throw new Error('a name template cannot contain / or \; use Move to folder for folders');
  const dot = rec.name.lastIndexOf('.');
  const stem = dot > 0 ? rec.name.slice(0, dot) : rec.name, ext = dot > 0 ? rec.name.slice(dot) : '';
  const d = Number.isFinite(rec.time) && rec.time > 0 ? new Date(rec.time) : null;
  const p = (v, k = 2) => String(v).padStart(k, '0');
  // Capture times are wall clocks stored as UTC (schema.js), so UTC getters.
  const fields = {
    name: stem,
    date: d ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` : 'undated',
    time: d ? `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` : '',
    n: p(n, width),
    camera: (rec.camera || '').trim(),
  };
  let out = t.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in fields)) throw new Error(`unknown field {${k}}; use ${RENAME_FIELDS.map(f => `{${f}}`).join(', ')}`);
    return fields[k];
  });
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ')
    .replace(/([-_ ])\1+/g, '$1').replace(/^[-_ .]+|[-_ .]+$/g, '');
  if (!out) throw new Error('the template gives an empty name');
  return out + ext;
}
