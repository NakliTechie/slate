// Library queries: filter, text search, sort and group. Pure functions over the
// in-memory records, choices and albums, so the grid, the search box and the
// agent commands all see the same answer. 100,000 records filter in one pass.

import { dayKey, monthKey, folderOf, monthName, emptyChoice, TRASH_DIR } from './schema.js';

/**
 * @typedef {object} QueryOpts
 * @property {string}  [q]          free text: name, folder, tags, albums, camera, year, month name
 * @property {number}  [from]       capture time lower bound, ms (inclusive)
 * @property {number}  [to]         capture time upper bound, ms (exclusive)
 * @property {'photo'|'video'} [kind]
 * @property {string}  [root]       root id
 * @property {string}  [folder]     folder path prefix within the root ('' = root level only when exactFolder)
 * @property {boolean} [exactFolder] only files directly in `folder`
 * @property {string}  [camera]     substring of "Make Model", case-insensitive
 * @property {number}  [minRating]  1..5
 * @property {'pick'|'reject'|'none'} [flag]
 * @property {string}  [tag]        tag, or a parent of tags ('trips' matches 'trips/goa')
 * @property {boolean} [fav]
 * @property {string}  [album]      album id
 * @property {'exclude'|'only'|'include'} [hidden='exclude']
 * @property {'exclude'|'only'|'include'} [trashed='exclude']
 * @property {boolean} [missing]    true = only missing files; default excludes nothing
 * @property {'time-desc'|'time-asc'|'name'|'size'} [sort='time-desc']
 * @property {(id: string) => string|undefined} [textOf]  text read from the photo (textindex.js, row X3); free-text words also match it
 * @property {boolean} [lockHidden]  the hidden photos are locked (locked.js, row O9): no hidden photo matches, whatever `hidden` says
 */

const MONTH_WORDS = new Map();
for (let i = 0; i < 12; i++) {
  const n = monthName(i).toLowerCase();
  MONTH_WORDS.set(n, i);
  MONTH_WORDS.set(n.slice(0, 3), i);
}

export function choiceOf(choices, id) { return choices.get(id) ?? EMPTY; }
const EMPTY = Object.freeze({ ...emptyChoice(), tags: Object.freeze([]) });

function tagMatches(tags, want) {
  const w = want.toLowerCase();
  return tags.some(t => { const l = t.toLowerCase(); return l === w || l.startsWith(w + '/'); });
}

// Each free-text token must match somewhere (AND across tokens).
function tokenMatcher(token, albumNamesOf, textOf) {
  const t = token.toLowerCase();
  const inText = textOf ? (r) => (textOf(r.id) || '').toLowerCase().includes(t) : () => false;
  if (/^\d{4}$/.test(t)) {
    const y = Number(t);
    return (r, c) => new Date(r.time).getUTCFullYear() === y || r.name.toLowerCase().includes(t) || r.path.toLowerCase().includes(t);
  }
  if (MONTH_WORDS.has(t)) {
    const m = MONTH_WORDS.get(t);
    return (r, c) => new Date(r.time).getUTCMonth() === m || hay(r, c, albumNamesOf).includes(t) || inText(r);
  }
  return (r, c) => hay(r, c, albumNamesOf).includes(t) || inText(r);
}

function hay(r, c, albumNamesOf) {
  return [r.path, r.camera, r.lens, r.description || '', ...(r.xmpTags || []), ...(c.tags || []), ...albumNamesOf(r.id)].join('\u0001').toLowerCase();
}

/**
 * @param {Iterable<object>} records
 * @param {Map<string, object>} choices  id -> choice
 * @param {Map<string, {id,name,items:Set<string>}>} albums  albumId -> album (items are record ids)
 * @param {QueryOpts} opts
 * @returns {object[]} matching records, sorted
 */
export function query(records, choices, albums, opts = {}) {
  const hidden = opts.hidden ?? 'exclude';
  const trashed = opts.trashed ?? 'exclude';
  const album = opts.album ? albums.get(opts.album) : null;
  if (opts.album && !album) return [];

  let albumIndex = null;
  const albumNamesOf = (id) => {
    if (!albumIndex) {
      albumIndex = new Map();
      for (const a of albums.values()) for (const rid of a.items) {
        if (!albumIndex.has(rid)) albumIndex.set(rid, []);
        albumIndex.get(rid).push(a.name);
      }
    }
    return albumIndex.get(id) || [];
  };
  const tokens = (opts.q || '').trim().split(/\s+/).filter(Boolean).map(t => tokenMatcher(t, albumNamesOf, opts.textOf));
  const cam = opts.camera ? opts.camera.toLowerCase() : null;
  const folder = opts.folder != null ? opts.folder.replace(/\/+$/, '') : null;

  const out = [];
  for (const r of records) {
    const c = choiceOf(choices, r.id);
    if (opts.lockHidden && c.hidden) continue;
    if (hidden === 'exclude' && c.hidden) continue;
    if (hidden === 'only' && !c.hidden) continue;
    if (trashed === 'exclude' && c.trashed) continue;
    if (trashed === 'only' && !c.trashed) continue;
    if (opts.missing === true && !r.missing) continue;
    if (album && !album.items.has(r.id)) continue;
    if (opts.kind && r.kind !== opts.kind) continue;
    if (opts.root && r.rootId !== opts.root) continue;
    if (folder != null) {
      const f = folderOf(r.path);
      if (opts.exactFolder ? f !== folder : !(folder === '' || f === folder || f.startsWith(folder + '/'))) continue;
    }
    if (opts.from != null && r.time < opts.from) continue;
    if (opts.to != null && r.time >= opts.to) continue;
    if (cam && !r.camera.toLowerCase().includes(cam)) continue;
    if (opts.minRating && effectiveRating(r, c) < opts.minRating) continue;
    if (opts.flag === 'none' ? c.flag : (opts.flag && c.flag !== opts.flag)) continue;
    if (opts.fav && !c.fav) continue;
    if (opts.tag && !tagMatches(allTags(r, c), opts.tag)) continue;
    if (tokens.length && !tokens.every(m => m(r, c))) continue;
    out.push(r);
  }
  return sortRecords(out, opts.sort ?? 'time-desc');
}

// The user's rating wins; an XMP rating read from disk shows until they set one. A rating the
// person cleared (`ratingSet` with rating 0) hides the XMP rating (review S10).
export function effectiveRating(r, c) { return c.rating || (c.ratingSet ? 0 : r.xmpRating) || 0; }
// Tags from the file and from Slate, without the file tags the person removed (`removedTags`).
export function allTags(r, c) {
  let file = r.xmpTags || [];
  if (file.length && c.removedTags?.length) {
    const gone = new Set(c.removedTags.map(t => t.toLowerCase()));
    file = file.filter(t => !gone.has(t.toLowerCase()));
  }
  if (!file.length) return c.tags || [];
  if (!c.tags?.length) return file;
  return [...new Set([...file, ...c.tags])];
}

export function sortRecords(list, sort) {
  const cmp = {
    'time-desc': (a, b) => b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    'time-asc': (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1),
    size: (a, b) => b.size - a.size || (a.id < b.id ? -1 : 1),
  }[sort];
  if (!cmp) throw new Error(`unknown sort: ${sort}`);
  return list.sort(cmp);
}

// Group an already-sorted list into runs by day or month.
// Returns [{ key, start, count }] with `start` the index of the first record.
export function groupBy(list, unit = 'day') {
  const keyOf = unit === 'month' ? monthKey : dayKey;
  const groups = [];
  let prev = null;
  for (let i = 0; i < list.length; i++) {
    const k = keyOf(list[i].time);
    if (k !== prev) { groups.push({ key: k, start: i, count: 0 }); prev = k; }
    groups[groups.length - 1].count++;
  }
  return groups;
}

// Folder tree for the Folders view: Map(rootId -> Map(folderPath -> count of files directly inside)).
export function folderCounts(records) {
  const out = new Map();
  for (const r of records) {
    if (r.path.startsWith(TRASH_DIR + '/')) continue; // trashed files live under .slate-trash (review S21)
    if (!out.has(r.rootId)) out.set(r.rootId, new Map());
    const m = out.get(r.rootId);
    const f = folderOf(r.path);
    m.set(f, (m.get(f) || 0) + 1);
  }
  return out;
}

// Tag counts across the library (for the tag list and agent `tag.list`).
export function tagCounts(records, choices) {
  const out = new Map();
  for (const r of records) {
    const c = choiceOf(choices, r.id);
    if (c.trashed) continue;
    for (const t of allTags(r, c)) out.set(t, (out.get(t) || 0) + 1);
  }
  return out;
}
