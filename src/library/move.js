// Move or rename files inside one root folder (spec row O10). The photo's XMP
// sidecar travels with it and is renamed to match, as trash.js does for the trash.
//
// createMove() -> { exists(root, path, fromPath?), move(root, fromPath, toPath, { liveVideo }) }
//
// `move` refuses to overwrite: it throws when a file (or folder) already sits at
// the target path, or at the target path of a sidecar or of the paired Live Photo MOV.
// It checks each target again straight before moving, because move() replaces a target.
// A case-only rename (IMG.JPG to img.jpg) passes only when the target is the source
// itself (isSameEntry, a case-insensitive disk), and goes through a `.slate-tmp-*` name.
// Folders on the way to the target are created. It uses FileSystemHandle.move() where the browser has it;
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

// The handle at `name` in `dir`, or null. A folder with that name counts as taken.
async function entryIn(dir, name) {
  try { return await dir.getFileHandle(name); }
  catch (e) {
    if (e?.name === 'NotFoundError') return null;
    if (e?.name === 'TypeMismatchError') return { kind: 'directory' };
    throw e;
  }
}

// True when `newName` in `toDir` is taken by another entry. A target that differs from
// the source only by letter case is free when it is the source itself (a case-insensitive
// disk); on a case-sensitive disk it is another file, so it is taken.
async function taken(fromDir, name, toDir, newName, caseOnly) {
  const dst = await entryIn(toDir, newName);
  if (!dst) return false;
  if (!caseOnly || dst.kind !== 'file') return true;
  const src = await fromDir.getFileHandle(name);
  return !(await src.isSameEntry(dst));
}

const tmpName = () => `.slate-tmp-${Math.random().toString(36).slice(2, 10)}`;

// Move one file, checking the target again straight before the move, because move()
// replaces an existing target. A case-only rename goes through a temporary name in the
// source folder, so it works on a case-insensitive disk and touches no other file.
async function moveChecked(fromDir, name, toDir, newName, caseOnly, what) {
  if (await taken(fromDir, name, toDir, newName, caseOnly)) throw new Error(what);
  if (!caseOnly) { await moveOne(fromDir, name, toDir, newName); return; }
  if (name === newName) return; // only the folder case differs and the disk ignores case
  const tmp = tmpName();
  await moveOne(fromDir, name, fromDir, tmp);
  if (await entryIn(toDir, newName)) { await moveOne(fromDir, tmp, fromDir, name); throw new Error(what); }
  await moveOne(fromDir, tmp, toDir, newName);
}

const lowerEq = (a, b) => a.toLowerCase() === b.toLowerCase();
const extPart = n => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i); };

export function createMove() {
  return {
    // exists(root, path, fromPath?): with fromPath, a target that is the source file itself
    // (a case-only rename on a case-insensitive disk) does not count.
    async exists(root, path, fromPath) {
      const { dirs, name } = split(path);
      let dir;
      try { dir = await walk(needHandle(root), dirs); }
      catch (e) { if (e?.name === 'NotFoundError') return false; if (e?.name === 'TypeMismatchError') return true; throw e; }
      const p = normPath(path), f = fromPath == null ? null : normPath(fromPath);
      if (f == null || f === p || !lowerEq(f, p)) return existsIn(dir, name);
      const a = split(f);
      let from;
      try { from = await walk(needHandle(root), a.dirs); } catch { return existsIn(dir, name); }
      return taken(from, a.name, dir, name, true);
    },

    // move(root, fromPath, toPath, { liveVideo }) -> { liveVideo }: the new path of the
    // paired Live Photo MOV (record field `liveVideo`), which moves with its still and takes
    // the still's new stem; null when there is none.
    async move(root, fromPath, toPath, { liveVideo = null } = {}) {
      const top = needHandle(root);
      const a = split(fromPath), b = split(toPath);
      if (normPath(fromPath) === normPath(toPath)) return { liveVideo };
      const from = await walk(top, a.dirs);
      const to = await walk(top, b.dirs, true);
      const dirsCase = lowerEq(a.dirs.join('/'), b.dirs.join('/'));
      const co = (o, n) => dirsCase && lowerEq(o, n);
      const exists = `${normPath(toPath)} already exists, so ${a.name} was not moved`;
      if (await taken(from, a.name, to, b.name, co(a.name, b.name))) throw new Error(exists);
      const pairs = (await sidecarPairs(from, a.name, b.name)).map(([o, n]) => [o, n, `a sidecar named ${n} already exists there, so ${a.name} was not moved`]);
      let liveTo = null;
      if (liveVideo) {
        const lv = split(liveVideo);
        if (lowerEq(lv.dirs.join('/'), a.dirs.join('/')) && await existsIn(from, lv.name)) {
          const n = stemOf(b.name) + extPart(lv.name);
          pairs.push([lv.name, n, `the Live Photo movie ${n} already exists there, so ${a.name} was not moved`]);
          liveTo = [...b.dirs, n].join('/');
        }
      }
      for (const [o, n, why] of pairs) if (await taken(from, o, to, n, co(o, n))) throw new Error(why);
      await moveChecked(from, a.name, to, b.name, co(a.name, b.name), exists);
      for (const [o, n, why] of pairs) await moveChecked(from, o, to, n, co(o, n), why);
      return { liveVideo: liveTo };
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
