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
//                          "hidden": true, "tags": ["trips/goa"], "trashed": "<ISO time>",
//                          "meta": { "taken": "2019-07-03T15:26:30", "lat": 15.5, "lon": 73.8,
//                                    "caption": "Sunset", "people": ["Asha"], "source": "takeout" } }
//   },
//   "albums": [
//     { "id": "al_k3j9x2", "name": "Goa 2024", "created": "<ISO>", "cover": "<relative path>|null",
//       "items": ["<relative path>", ...] }
//   ]
// }
//
// `meta` (optional, added within version 1; older files without it still load) holds the
// date, place, caption and people that came from an import, a Google Takeout JSON or an
// iCloud export CSV, so a rebuild or full rescan restores them without that JSON or CSV.
// `taken` is the wall clock as Slate stores it (schema.wallClockToTime), with no zone.
// `source` is "takeout" or "icloud". The scanner applies each field only where the file's
// own EXIF or XMP has none (scan.applyMeta). Every field inside `meta` is optional.
//
// Change times and deletions (review S2). Every item carries `t`, the time in ms of its last
// change, so two tabs (or two deployments) that share one folder merge item by item: the newer
// item wins (mergeLibFiles). An item that was removed (emptied, moved, deleted from the trash)
// is kept for 30 days as a tombstone in `"deleted": { "<path>": t }`, so a merge does not bring
// it back. Albums carry `t` the same way, and a deleted album is kept in
// `"deletedAlbums": { "<id>": t }`. Files without `t` (older Slate) merge as time 0.
//
// Overrides (review S10): `"ratingSet": true` with no rating means the person cleared a rating
// that came from the file's XMP; `"removedTags": [...]` hides tags that came from the file.
//
// Trash (review S21): a trashed item is keyed by its path inside the trash,
// `.slate-trash/<original path>`, so a new file at the original path is a different item.
// Older files kept the original path; parseLibFile moves those items (and album entries) over.
//
// Unknown fields (review S22) on an item and at the top level are kept and written back, so
// two Slate versions do not strip each other's data.
//
// Import details (review S15): `meta` is saved apart, in `.slate-library-meta.json` beside this
// file (LIBRARY_META_FILE, format below), so a favourite does not rewrite every caption.
// persist.js joins the two files on load; in memory and in this module an item holds its `meta`.
//   { "format": "slate-library-meta", "version": 1, "items": { "<relative path>": { meta } } }
// An older file with `meta` inside its items still loads.
//
// Only non-default fields are written. `size` is written with every item so a
// file that moved inside the root can be re-matched by name plus size.
// An album spanning several roots appears in each root's file with the same id,
// listing that root's members; the files merge on load. An album with no
// members is kept in the first root's file.

import { emptyChoice, isEmptyChoice, normPath, normTag, FLAGS, TRASH_DIR } from './schema.js';

export const LIBFILE_FORMAT = 'slate-library';
export const LIBFILE_VERSION = 1;
export const LIBRARY_META_FILE = '.slate-library-meta.json';
export const META_FORMAT = 'slate-library-meta';
export const TOMBSTONE_DAYS = 30;
const TOMB_MS = TOMBSTONE_DAYS * 86400000;

// Trash paths (review S21): a trashed item lives at `.slate-trash/<original path>`.
export const TRASH_PREFIX = TRASH_DIR + '/';
export const inTrash = (path) => typeof path === 'string' && path.startsWith(TRASH_PREFIX);
export const toTrashPath = (path) => (inTrash(path) ? path : TRASH_PREFIX + path);
export const fromTrashPath = (path) => (inTrash(path) ? path.slice(TRASH_PREFIX.length) : path);

const ITEM_KEYS = new Set(['size', 'fav', 'rating', 'flag', 'hidden', 'tags', 'trashed', 'meta', 't', 'ratingSet', 'removedTags']);
const TOP_KEYS = new Set(['format', 'version', 'updated', 'items', 'albums', 'deleted', 'deletedAlbums']);

export function emptyLibFile() {
  return { format: LIBFILE_FORMAT, version: LIBFILE_VERSION, updated: null, items: {}, albums: [], deleted: {}, deletedAlbums: {} };
}

// A choice with nothing to keep: no choice, no override and no unknown fields.
export function isBlankChoice(c) {
  return isEmptyChoice(c) && !c?.ratingSet && !c?.removedTags?.length && !(c?.x && Object.keys(c.x).length);
}

const okTime = (t) => Number.isFinite(t) && t >= 0;
const extraOf = (raw, known) => {
  const x = {};
  for (const [k, v] of Object.entries(raw)) if (!known.has(k)) x[k] = v;
  return Object.keys(x).length ? x : null;
};

// Parse and validate. Unknown fields are kept (in `x`); bad entries are skipped and
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
  const x = extraOf(raw, TOP_KEYS);
  if (x) file.x = x;
  let skipped = 0;
  const renamed = new Map(); // an older file's trashed item: original path -> trash path
  for (const [p0, v] of Object.entries(raw.items && typeof raw.items === 'object' ? raw.items : {})) {
    const c = cleanChoice(v);
    if (!c) { skipped++; continue; }
    const meta = cleanMeta(v.meta);
    if (meta) c.meta = meta;
    let p = normPath(p0);
    if (c.trashed && !inTrash(p)) { renamed.set(p, toTrashPath(p)); p = toTrashPath(p); }
    file.items[p] = c;
  }
  for (const [p, t] of Object.entries(raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {})) if (okTime(t)) file.deleted[normPath(p)] = t;
  for (const [id, t] of Object.entries(raw.deletedAlbums && typeof raw.deletedAlbums === 'object' ? raw.deletedAlbums : {})) if (okTime(t)) file.deletedAlbums[id] = t;
  const re = (p) => renamed.get(p) ?? p;
  for (const a of Array.isArray(raw.albums) ? raw.albums : []) {
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') { skipped++; continue; }
    const al = {
      id: a.id, name: a.name.slice(0, 200),
      created: typeof a.created === 'string' ? a.created : null,
      cover: typeof a.cover === 'string' ? re(normPath(a.cover)) : null,
      items: [...new Set((Array.isArray(a.items) ? a.items : []).filter(x => typeof x === 'string').map(p => re(normPath(p))))],
    };
    if (okTime(a.t)) al.t = a.t;
    file.albums.push(al);
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
  if (v.ratingSet === true) c.ratingSet = true;
  if (Array.isArray(v.removedTags)) {
    const r = [...new Set(v.removedTags.filter(t => typeof t === 'string').map(normTag).filter(Boolean))];
    if (r.length) c.removedTags = r;
  }
  if (okTime(v.t)) c.t = v.t;
  const x = extraOf(v, ITEM_KEYS);
  if (x) c.x = x;
  return c;
}

// ── the import-details file (.slate-library-meta.json) ──────────────────────
// The text of the meta file for a library file's items (sorted, so equal content gives equal text).
export function metaFileText(file) {
  const items = {};
  for (const p of Object.keys(file.items).sort()) if (file.items[p].meta) items[p] = file.items[p].meta;
  return JSON.stringify({ format: META_FORMAT, version: 1, items }, null, 2) + '\n';
}
export const EMPTY_META_TEXT = metaFileText({ items: {} });

// Parse the meta file: Map(path -> meta), or null when it is not a meta file.
export function parseMetaFile(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || raw.format !== META_FORMAT || !raw.items || typeof raw.items !== 'object') return null;
  const out = new Map();
  for (const [p, v] of Object.entries(raw.items)) { const m = cleanMeta(v); if (m) out.set(normPath(p), m); }
  return out;
}

// Put the meta file's details into a parsed library file's items (in place).
export function joinMeta(file, metaMap) {
  for (const [p0, m] of metaMap) {
    const p = file.items[p0] ? p0 : (file.items[toTrashPath(p0)] ? toTrashPath(p0) : p0);
    if (file.deleted[p] && !file.items[p]) continue;
    if (!file.items[p]) file.items[p] = emptyChoice();
    file.items[p].meta = m;
  }
  return file;
}

// The library file without `meta` (that goes to the meta file).
export function withoutMeta(file) {
  const items = {};
  for (const [p, it] of Object.entries(file.items)) { const { meta, ...rest } = it; items[p] = rest; }
  return { ...file, items };
}

// ── merge (review S2) ───────────────────────────────────────────────────────
// Merge two parsed library files for one root, item by item: the newer `t` wins, a tombstone
// newer than an item removes it, and on equal times `a` wins unless `b.updated` is newer.
// Returns { file, changed }: `changed` counts entries where `b` replaced what `a` had.
export function mergeLibFiles(a, b) {
  const bFirst = (b.updated ?? '') > (a.updated ?? '');
  const out = emptyLibFile();
  out.updated = [a.updated, b.updated].filter(Boolean).sort().pop() ?? null;
  const x = { ...(a.x || {}), ...(b.x || {}) };
  if (Object.keys(x).length) out.x = x;
  let changed = 0;
  const pick = (ea, eb) => {
    if (!eb) return ea;
    if (!ea) return eb;
    if (eb.t !== ea.t) return eb.t > ea.t ? eb : ea;
    return bFirst ? eb : ea;
  };
  const entry = (f, p) => {
    const it = f.items[p], d = f.deleted?.[p];
    if (it && !(d > (it.t ?? 0))) return { t: it.t ?? 0, item: it };
    return d != null ? { t: d, del: true } : null;
  };
  const same = (e1, e2) => !!e1 && !!e2 && (e1.del ? e2.del && e1.t === e2.t : !e2.del && canon(e1.item) === canon(e2.item));
  const paths = new Set([...Object.keys(a.items), ...Object.keys(a.deleted || {}), ...Object.keys(b.items), ...Object.keys(b.deleted || {})]);
  for (const p of paths) {
    const ea = entry(a, p), eb = entry(b, p), win = pick(ea, eb);
    if (win === eb && !same(ea, eb)) changed++;
    if (win.del) out.deleted[p] = win.t; else out.items[p] = win.item;
  }
  const albums = new Map();
  const tombs = { ...(a.deletedAlbums || {}) };
  for (const [id, t] of Object.entries(b.deletedAlbums || {})) tombs[id] = Math.max(tombs[id] ?? 0, t);
  const aAl = new Map(a.albums.map(al => [al.id, al]));
  for (const al of b.albums) {
    const mine = aAl.get(al.id);
    const win = pick(mine && { t: mine.t ?? 0, al: mine }, { t: al.t ?? 0, al });
    if (win.al === al && JSON.stringify(mine) !== JSON.stringify(al)) changed++;
    albums.set(al.id, win.al);
  }
  for (const al of a.albums) if (!albums.has(al.id)) albums.set(al.id, al);
  for (const [id, t] of Object.entries(tombs)) {
    const al = albums.get(id);
    if (al && (al.t ?? 0) <= t) {
      albums.delete(id);
      if (aAl.has(id)) changed++;
    }
    out.deletedAlbums[id] = t;
  }
  for (const id of Object.keys(b.deletedAlbums || {})) if (!(id in (a.deletedAlbums || {})) && !aAl.has(id)) changed++;
  out.albums = [...albums.values()].sort((p, q) => p.id.localeCompare(q.id));
  return { file: out, changed };
}

export const META_SOURCES = ['takeout', 'icloud'];

// Clean an item's `meta` object; null when nothing usable is left.
export function cleanMeta(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = {};
  if (typeof v.taken === 'string' && metaTime(v.taken) != null) m.taken = v.taken;
  if (Number.isFinite(v.lat) && Number.isFinite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180) { m.lat = v.lat; m.lon = v.lon; }
  if (typeof v.caption === 'string' && v.caption) m.caption = v.caption;
  if (Array.isArray(v.people)) { const p = [...new Set(v.people.filter(x => typeof x === 'string' && x))]; if (p.length) m.people = p; }
  if (!Object.keys(m).length) return null;
  m.source = META_SOURCES.includes(v.source) ? v.source : 'takeout';
  return m;
}

// Stored time (ms, wall clock read as UTC) <-> the `taken` string.
export function metaTaken(time) { return new Date(time).toISOString().slice(0, 19); }
export function metaTime(taken) {
  const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(taken) ? taken : taken + 'Z');
  return Number.isFinite(t) ? t : null;
}

// One item as it is written: only non-default fields; unknown fields stay in `x`.
function itemOut(c, m, size, t) {
  const out = {};
  if (typeof size === 'number') out.size = size;
  if (c.fav) out.fav = true;
  if (c.rating) out.rating = c.rating;
  if (c.ratingSet && !c.rating) out.ratingSet = true;
  if (c.flag) out.flag = c.flag;
  if (c.hidden) out.hidden = true;
  if (c.tags?.length) out.tags = [...c.tags].sort();
  if (c.removedTags?.length) out.removedTags = [...c.removedTags].sort();
  if (c.trashed) out.trashed = c.trashed;
  if (okTime(t)) out.t = t;
  if (m) out.meta = m;
  if (c.x && Object.keys(c.x).length) out.x = { ...c.x };
  return out;
}
const canon = (it) => JSON.stringify(itemOut(it, it.meta, it.size, it.t));

// Build the file for one root from in-memory state.
//   choices: Map(path -> choice) for this root
//   meta:    Map(path -> meta) for this root (import details; see the header)
//   sizes:   Map(path -> size) for this root (from the index)
//   times:   Map(path -> ms) last change of each item; a path with no choice and no meta is a tombstone
//   albums:  [{ id, name, created, cover: path|null, items: [path], t }] restricted to this root
//   albumTombs: Map(albumId -> ms) deleted albums
//   extra:   unknown top-level fields to write back
// Tombstones older than TOMBSTONE_DAYS are left out.
export function buildLibFile({ choices, meta = new Map(), sizes, albums, times = new Map(), albumTombs = new Map(), extra = null, now = new Date() }) {
  const file = emptyLibFile();
  file.updated = now.toISOString();
  const cutoff = now.getTime() - TOMB_MS;
  const paths = [...new Set([...choices.keys(), ...meta.keys()])].sort();
  for (const p of paths) {
    const c = choices.get(p) ?? emptyChoice(), m = meta.get(p);
    if (isBlankChoice(c) && !m) continue;
    file.items[p] = itemOut(c, m, sizes?.get(p) ?? c.size, times.get(p) ?? c.t);
  }
  for (const [p, t] of [...times].sort()) if (!(p in file.items) && t >= cutoff) file.deleted[p] = t;
  for (const [id, t] of [...albumTombs].sort()) if (t >= cutoff) file.deletedAlbums[id] = t;
  file.albums = [...albums]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(a => {
      const out = { id: a.id, name: a.name, created: a.created ?? null, cover: a.cover ?? null, items: [...a.items].sort() };
      if (okTime(a.t)) out.t = a.t;
      return out;
    });
  if (extra && Object.keys(extra).length) file.x = { ...extra };
  return file;
}

// Unknown fields (`x`, on the file and on each item) are written back in place.
export function serialiseLibFile(file) {
  const flat = (o, known) => { const { x, ...rest } = o; if (x) for (const [k, v] of Object.entries(x)) if (!known.has(k)) rest[k] = v; return rest; };
  const items = {};
  for (const [p, it] of Object.entries(file.items)) items[p] = flat(it, ITEM_KEYS);
  return JSON.stringify(flat({ ...file, items }, TOP_KEYS), null, 2) + '\n';
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
