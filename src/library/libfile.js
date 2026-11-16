// The library file: `.slate-library.json` at the top of each root folder.
// It is the record of the user's choices for the photos under that root:
// favourites, ratings, pick/reject flags, hidden, tags, trash, and albums.
// It travels with the folder, survives a cleared browser, and is plain JSON a
// person can read. Pure functions only; persist.js does the reading and writing.
//
// Format (version 1):
// {
//   "format": "slate-library",
//   "version": 1,
//   "updated": "2026-11-16T12:00:00.000Z",
//   "items": {
//     "<relative path>": { "size": 123, "fav": true, "rating": 4, "flag": "pick",
//                          "hidden": true, "tags": ["trips/goa"], "trashed": "<ISO time>" }
//   },
//   "albums": [
//     { "id": "al_k3j9x2", "name": "Goa 2024", "created": "<ISO>", "cover": "<relative path>|null",
//       "items": ["<relative path>", ...] }
//   ]
// }
//
// Only non-default fields are written. `size` is written with every item so a
// file that moved inside the root can be re-matched by name plus size.
// An album spanning several roots appears in each root's file with the same id,
// listing that root's members; the files merge on load. An album with no
// members is kept in the first root's file.

import { emptyChoice, isEmptyChoice, normPath, normTag, FLAGS } from './schema.js';

export const LIBFILE_FORMAT = 'slate-library';
export const LIBFILE_VERSION = 1;

export function emptyLibFile() {
  return { format: LIBFILE_FORMAT, version: LIBFILE_VERSION, updated: null, items: {}, albums: [] };
}

// Parse and validate. Unknown fields are dropped; bad entries are skipped and
// counted, never fatal, so a hand-edited file still loads.
export function parseLibFile(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `not JSON: ${e.message}`, file: emptyLibFile(), skipped: 0 }; }
  if (!raw || typeof raw !== 'object' || raw.format !== LIBFILE_FORMAT) {
    return { ok: false, error: 'not a Slate library file', file: emptyLibFile(), skipped: 0 };
  }
  if (typeof raw.version !== 'number' || raw.version > LIBFILE_VERSION) {
    return { ok: false, error: `library file version ${raw.version} is newer than this Slate`, file: emptyLibFile(), skipped: 0 };
  }
  const file = emptyLibFile();
  file.updated = typeof raw.updated === 'string' ? raw.updated : null;
  let skipped = 0;
  for (const [p, v] of Object.entries(raw.items && typeof raw.items === 'object' ? raw.items : {})) {
    const c = cleanChoice(v);
    if (!c) { skipped++; continue; }
    file.items[normPath(p)] = c;
  }
  for (const a of Array.isArray(raw.albums) ? raw.albums : []) {
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') { skipped++; continue; }
    file.albums.push({
      id: a.id, name: a.name.slice(0, 200),
      created: typeof a.created === 'string' ? a.created : null,
      cover: typeof a.cover === 'string' ? normPath(a.cover) : null,
      items: [...new Set((Array.isArray(a.items) ? a.items : []).filter(x => typeof x === 'string').map(normPath))],
    });
  }
  return { ok: true, file, skipped };
}

function cleanChoice(v) {
  if (!v || typeof v !== 'object') return null;
  const c = emptyChoice();
  if (typeof v.size === 'number') c.size = v.size;
  if (v.fav === true) c.fav = true;
  if (Number.isInteger(v.rating) && v.rating >= 0 && v.rating <= 5) c.rating = v.rating;
  if (FLAGS.includes(v.flag)) c.flag = v.flag;
  if (v.hidden === true) c.hidden = true;
  if (Array.isArray(v.tags)) c.tags = [...new Set(v.tags.filter(t => typeof t === 'string').map(normTag).filter(Boolean))];
  if (typeof v.trashed === 'string') c.trashed = v.trashed;
  return c;
}

// Build the file for one root from in-memory state.
//   choices: Map(path -> choice) for this root
//   sizes:   Map(path -> size) for this root (from the index)
//   albums:  [{ id, name, created, cover: path|null, items: [path] }] restricted to this root
export function buildLibFile({ choices, sizes, albums, now = new Date() }) {
  const file = emptyLibFile();
  file.updated = now.toISOString();
  const paths = [...choices.keys()].sort();
  for (const p of paths) {
    const c = choices.get(p);
    if (isEmptyChoice(c)) continue;
    const out = {};
    const size = sizes?.get(p) ?? c.size;
    if (typeof size === 'number') out.size = size;
    if (c.fav) out.fav = true;
    if (c.rating) out.rating = c.rating;
    if (c.flag) out.flag = c.flag;
    if (c.hidden) out.hidden = true;
    if (c.tags?.length) out.tags = [...c.tags].sort();
    if (c.trashed) out.trashed = c.trashed;
    file.items[p] = out;
  }
  file.albums = [...albums]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(a => ({ id: a.id, name: a.name, created: a.created ?? null, cover: a.cover ?? null, items: [...a.items].sort() }));
  return file;
}

export function serialiseLibFile(file) {
  return JSON.stringify(file, null, 2) + '\n';
}

// A file that moved inside its root: match an unknown path in the library file
// to an indexed file with the same name and size that has no entry of its own.
// Returns Map(oldPath -> newPath).
export function rematchMoved(fileItems, indexedPaths, sizeOf) {
  const byKey = new Map();
  for (const p of indexedPaths) {
    const key = `${p.slice(p.lastIndexOf('/') + 1)}\u0000${sizeOf(p)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const known = new Set(indexedPaths);
  const moves = new Map();
  for (const [p, c] of Object.entries(fileItems)) {
    if (known.has(p) || c.trashed) continue;
    const cands = (byKey.get(`${p.slice(p.lastIndexOf('/') + 1)}\u0000${c.size}`) || []).filter(q => !(q in fileItems));
    if (cands.length === 1) moves.set(p, cands[0]);
  }
  return moves;
}

export function newAlbumId() {
  return 'al_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}
