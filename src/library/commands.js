// The library's command table: one list that backs the buttons, the keys and
// the agent face (NakliOS `naklios.experimental_commands`). `manifest()` is the
// source of commands.json; scripts/gen-commands.mjs writes it and a test keeps
// the two equal.
//
// Rules from the NakliOS rail (sys/host/catalog.mjs):
//   - names match /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/ and carry no app
//     prefix (the host shows `slate.library.search`);
//   - scope is read, write or destructive; destructive calls are staged for the person;
//   - input is an object JSON Schema; the rail checks required and typed properties;
//   - results over 256 KB are refused, so results carry ids and short fields.
// Slate's own rules:
//   - write commands take at most MAX_WRITE_IDS ids; `photo.bulk` (destructive) takes more;
//   - every write takes `dryRun` and returns an `undo` token where the change can be undone.

export const MAX_WRITE_IDS = 200;
export const MAX_RESULTS = 500;

const ids = (max = MAX_WRITE_IDS) => ({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: max, description: `photo ids from library.search (at most ${max})` });
const dryRun = { type: 'boolean', description: 'report what would change and change nothing' };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

const SEARCH_PROPS = {
  q: { type: 'string', description: 'words to match in file name, folder, tags, album names, camera; a year (2024) or month name (March) matches capture dates' },
  from: { type: 'string', description: 'capture date on or after, YYYY-MM-DD' },
  to: { type: 'string', description: 'capture date before, YYYY-MM-DD' },
  kind: { type: 'string', enum: ['photo', 'video'] },
  album: { type: 'string', description: 'album id from album.list' },
  folder: { type: 'string', description: 'folder path inside its root, e.g. "2024/Goa"' },
  root: { type: 'string', description: 'root id from library.roots' },
  camera: { type: 'string' },
  tag: { type: 'string', description: 'a tag; a parent tag matches its children' },
  fav: { type: 'boolean', description: 'only favourites' },
  minRating: { type: 'integer', minimum: 1, maximum: 5 },
  flag: { type: 'string', enum: ['pick', 'reject', 'none'] },
  hidden: { type: 'string', enum: ['exclude', 'only', 'include'], description: 'default exclude' },
  trashed: { type: 'string', enum: ['exclude', 'only', 'include'], description: 'default exclude' },
  sort: { type: 'string', enum: ['time-desc', 'time-asc', 'name', 'size'] },
  limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `default 50, at most ${MAX_RESULTS}` },
  cursor: { type: 'string', description: 'from a previous result, to get the next page' },
};

function dateMs(s, field) {
  if (s == null) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`${field} must be YYYY-MM-DD`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

// A short, stable view of one photo for agents and lists.
export function summary(lib, r) {
  const c = lib.choice(r.id);
  const out = { id: r.id, name: r.name, folder: r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '', kind: r.kind, taken: new Date(r.time).toISOString().slice(0, 19) };
  if (r.w) { out.w = r.w; out.h = r.h; }
  if (c.fav) out.fav = true;
  const rating = lib.rating(r.id); if (rating) out.rating = rating;
  if (c.flag) out.flag = c.flag;
  const tags = lib.tagsOf(r.id); if (tags.length) out.tags = tags;
  if (c.hidden) out.hidden = true;
  if (c.trashed) out.trashed = true;
  if (r.missing) out.missing = true;
  return out;
}

function searchOpts(a) {
  return {
    q: a.q, from: dateMs(a.from, 'from'), to: dateMs(a.to, 'to'), kind: a.kind, album: a.album,
    folder: a.folder, root: a.root, camera: a.camera, tag: a.tag, fav: a.fav, minRating: a.minRating,
    flag: a.flag, hidden: a.hidden, trashed: a.trashed, sort: a.sort,
  };
}

function page(lib, list, a) {
  const limit = Math.min(a.limit ?? 50, MAX_RESULTS);
  const start = a.cursor ? Number(a.cursor) : 0;
  if (!Number.isInteger(start) || start < 0) throw new Error('bad cursor');
  const slice = list.slice(start, start + limit);
  const out = { total: list.length, items: slice.map(r => summary(lib, r)) };
  if (start + limit < list.length) out.cursor = String(start + limit);
  return out;
}

function capIds(list, max = MAX_WRITE_IDS) {
  if (!Array.isArray(list) || !list.length) throw new Error('give at least one photo id');
  if (list.length > max) throw new Error(`at most ${max} ids per call; use photo.bulk for more (it asks the person first)`);
  return list;
}

/**
 * Each command: { name, label, description, scope, input, shortcut?, shows?, run(lib, args, ctx) }.
 * `run` may be async. `ctx.ui` is the library view (for commands that show something).
 */
export const COMMANDS = [
  // ── library ──────────────────────────────────────────────────────────────
  { name: 'library.open', label: 'Open Library', description: 'Show the photo library (the grid of every photo in the added folders).', scope: 'read', input: obj(), shortcut: 'Ctrl+L', shows: true,
    run: (lib, a, ctx) => { ctx?.ui?.showLibrary?.(); return { shown: true, ...lib.counts() }; } },
  { name: 'library.stats', label: 'Library stats', description: 'Count photos, videos, favourites, hidden, trashed, albums and folders in the library, and report background job progress.', scope: 'read', input: obj(),
    run: (lib) => ({ ...lib.counts(), jobs: lib.jobs.status() }) },
  { name: 'library.roots', label: 'Library folders', description: 'List the folders added to the library, with their ids and photo counts.', scope: 'read', input: obj(),
    run: (lib) => ({ roots: [...lib.roots.values()].map(r => ({ id: r.id, name: r.name, mode: r.mode, lastScan: r.lastScan ? new Date(r.lastScan).toISOString() : null, photos: [...lib.records.values()].filter(x => x.rootId === r.id).length })) }) },
  { name: 'library.search', label: 'Search photos', description: 'Find photos by words, date range, album, folder, camera, tag, favourite, rating or flag. Returns ids and short details, a page at a time.', scope: 'read', input: obj(SEARCH_PROPS), shortcut: '/',
    run: (lib, a) => page(lib, lib.search(searchOpts(a)), a) },
  { name: 'library.rescan', label: 'Rescan folders', description: 'Look for new, changed and missing files in one added folder, or all of them.', scope: 'write', input: obj({ root: { type: 'string', description: 'root id; omit for all' } }),
    run: async (lib, a) => { await lib.rescan(a.root ?? null); return { ok: true, ...lib.counts() }; } },
  { name: 'library.undo', label: 'Undo', description: 'Undo one earlier library change, by the undo token that change returned.', scope: 'write', input: obj({ token: { type: 'string' } }, ['token']),
    run: (lib, a) => lib.undo(a.token) },
  { name: 'library.tags', label: 'List tags', description: 'List every tag in the library with how many photos carry it.', scope: 'read', input: obj(),
    run: (lib) => ({ tags: [...lib.tags()].sort((x, y) => y[1] - x[1]).map(([tag, count]) => ({ tag, count })) }) },

  // ── one photo ────────────────────────────────────────────────────────────
  { name: 'photo.get', label: 'Photo details', description: 'Full details of one photo: dates, size, camera, place, tags, albums, rating and flag.', scope: 'read', input: obj({ id: { type: 'string' } }, ['id']),
    run: (lib, a) => {
      const r = lib.get(a.id); if (!r) throw new Error(`unknown photo id: ${a.id}`);
      return { ...summary(lib, r), path: r.path, root: r.rootId, size: r.size, camera: r.camera || null, lens: r.lens || null, lat: r.lat, lon: r.lon, duration: r.dur || null, dateSource: r.timeSource, albums: lib.albumsOf(r.id).map(al => ({ id: al.id, name: al.name })) };
    } },
  { name: 'photo.thumb', label: 'Thumbnail', description: 'A small JPEG or WebP data URL of one photo, for looking at it. About 20 KB.', scope: 'read', input: obj({ id: { type: 'string' } }, ['id']),
    run: async (lib, a) => {
      if (!lib.get(a.id)) throw new Error(`unknown photo id: ${a.id}`);
      const dataUrl = await lib.services.thumbs?.dataUrl?.(a.id);
      if (!dataUrl) throw new Error('no thumbnail yet; try again when the library has finished indexing');
      return { id: a.id, dataUrl };
    } },
  { name: 'photo.open', label: 'Open in editor', description: 'Open one photo in Slate\'s editor.', scope: 'read', input: obj({ id: { type: 'string' } }, ['id']), shortcut: 'E', shows: true,
    run: async (lib, a, ctx) => { if (!lib.get(a.id)) throw new Error(`unknown photo id: ${a.id}`); await ctx?.ui?.openInEditor?.(a.id); return { opened: a.id }; } },

  // ── choices (write, at most 200 ids) ─────────────────────────────────────
  { name: 'photo.favourite', label: 'Favourite', description: 'Mark photos as favourites, or unmark them.', scope: 'write', input: obj({ ids: ids(), value: { type: 'boolean', description: 'default true' }, dryRun }, ['ids']), shortcut: 'F',
    run: (lib, a) => lib.setFavourite(capIds(a.ids), a.value ?? true, a) },
  { name: 'photo.rate', label: 'Rate', description: 'Give photos a star rating from 0 (none) to 5.', scope: 'write', input: obj({ ids: ids(), rating: { type: 'integer', minimum: 0, maximum: 5 }, dryRun }, ['ids', 'rating']), shortcut: ['0', '1', '2', '3', '4', '5'],
    run: (lib, a) => lib.setRating(capIds(a.ids), a.rating, a) },
  { name: 'photo.flag', label: 'Pick or reject', description: 'Flag photos as pick or reject, or clear the flag (none).', scope: 'write', input: obj({ ids: ids(), flag: { type: 'string', enum: ['pick', 'reject', 'none'] }, dryRun }, ['ids', 'flag']), shortcut: ['P', 'X', 'U'],
    run: (lib, a) => lib.setFlag(capIds(a.ids), a.flag, a) },
  { name: 'photo.tag', label: 'Tag', description: 'Add or remove tags on photos. Use "/" for nested tags, e.g. "trips/goa".', scope: 'write', input: obj({ ids: ids(), add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } }, dryRun }, ['ids']), shortcut: 'T',
    run: (lib, a) => lib.tag(capIds(a.ids), { add: a.add ?? [], remove: a.remove ?? [] }, a) },
  { name: 'photo.hide', label: 'Hide', description: 'Hide photos from the timeline and search, or show them again. Hidden photos stay in the Hidden view.', scope: 'write', input: obj({ ids: ids(), value: { type: 'boolean', description: 'default true' }, dryRun }, ['ids']), shortcut: 'H',
    run: (lib, a) => lib.setHidden(capIds(a.ids), a.value ?? true, a) },
  { name: 'photo.restore', label: 'Restore from trash', description: 'Move trashed photos back to where they were.', scope: 'write', input: obj({ ids: ids(), dryRun }, ['ids']),
    run: (lib, a) => lib.restore(capIds(a.ids), a) },

  // ── destructive (staged for the person in NakliOS) ───────────────────────
  { name: 'photo.trash', label: 'Move to trash', description: 'Move photos into the trash folder (.slate-trash) inside their library folder. They can be restored until the trash is emptied.', scope: 'destructive', input: obj({ ids: ids(5000), dryRun }, ['ids']), shortcut: 'Delete',
    run: (lib, a) => lib.trash(capIds(a.ids, 5000), a) },
  { name: 'photo.bulk', label: 'Change many photos', description: 'Apply one change (favourite, rate, flag, tag, hide, album add or remove) to more than 200 photos at once.', scope: 'destructive',
    input: obj({ op: { type: 'string', enum: ['favourite', 'rate', 'flag', 'tag', 'hide', 'album_add', 'album_remove'] }, ids: ids(100000), value: { type: 'boolean' }, rating: { type: 'integer', minimum: 0, maximum: 5 }, flag: { type: 'string', enum: ['pick', 'reject', 'none'] }, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } }, album: { type: 'string' }, dryRun }, ['op', 'ids']),
    run: (lib, a) => {
      const list = capIds(a.ids, 100000);
      switch (a.op) {
        case 'favourite': return lib.setFavourite(list, a.value ?? true, a);
        case 'rate': return lib.setRating(list, a.rating, a);
        case 'flag': return lib.setFlag(list, a.flag, a);
        case 'tag': return lib.tag(list, { add: a.add ?? [], remove: a.remove ?? [] }, a);
        case 'hide': return lib.setHidden(list, a.value ?? true, a);
        case 'album_add': return lib.albumAdd(a.album, list, a);
        case 'album_remove': return lib.albumRemove(a.album, list, a);
        default: throw new Error(`unknown op: ${a.op}`);
      }
    } },
  { name: 'trash.empty', label: 'Empty trash', description: 'Permanently delete the files in the trash (all of them, or the given ids). This cannot be undone.', scope: 'destructive', input: obj({ ids: ids(100000), dryRun }),
    run: (lib, a) => lib.emptyTrash({ ids: a.ids ?? null, dryRun: a.dryRun }) },

  // ── albums ───────────────────────────────────────────────────────────────
  { name: 'album.list', label: 'List albums', description: 'List albums with their ids, names and photo counts.', scope: 'read', input: obj(),
    run: (lib) => ({ albums: [...lib.albums.values()].map(al => ({ id: al.id, name: al.name, count: [...al.items].filter(id => lib.get(id) && !lib.choice(id).trashed).length, cover: lib.albumCover(al) })).sort((x, y) => x.name.localeCompare(y.name)) }) },
  { name: 'album.create', label: 'New album', description: 'Create an album, optionally with photos in it. Albums hold references; no file moves.', scope: 'write', input: obj({ name: { type: 'string' }, ids: { ...ids(), minItems: 0 }, dryRun }, ['name']),
    run: (lib, a) => lib.albumCreate(a.name, { ids: a.ids ? capIds(a.ids) : [], dryRun: a.dryRun }) },
  { name: 'album.rename', label: 'Rename album', description: 'Rename an album.', scope: 'write', input: obj({ album: { type: 'string' }, name: { type: 'string' }, dryRun }, ['album', 'name']),
    run: (lib, a) => lib.albumRename(a.album, a.name, a) },
  { name: 'album.add', label: 'Add to album', description: 'Add photos to an album.', scope: 'write', input: obj({ album: { type: 'string' }, ids: ids(), dryRun }, ['album', 'ids']),
    run: (lib, a) => lib.albumAdd(a.album, capIds(a.ids), a) },
  { name: 'album.remove', label: 'Remove from album', description: 'Take photos out of an album. The photos themselves stay.', scope: 'write', input: obj({ album: { type: 'string' }, ids: ids(), dryRun }, ['album', 'ids']),
    run: (lib, a) => lib.albumRemove(a.album, capIds(a.ids), a) },
  { name: 'album.cover', label: 'Set album cover', description: 'Choose which photo in an album shows as its cover.', scope: 'write', input: obj({ album: { type: 'string' }, id: { type: 'string' }, dryRun }, ['album', 'id']),
    run: (lib, a) => lib.albumSetCover(a.album, a.id, a) },
  { name: 'album.delete', label: 'Delete album', description: 'Delete an album. Its photos stay in the library.', scope: 'destructive', input: obj({ album: { type: 'string' }, dryRun }, ['album']),
    run: (lib, a) => lib.albumDelete(a.album, a) },
];

const BY_NAME = new Map(COMMANDS.map(c => [c.name, c]));
export function command(name) { return BY_NAME.get(name) ?? null; }

// Run a command by name: validates required fields, then calls it.
export async function runCommand(lib, name, args = {}, ctx = {}) {
  const c = BY_NAME.get(name);
  if (!c) throw new Error(`unknown command: ${name}`);
  for (const k of c.input.required ?? []) if (args[k] == null) throw new Error(`${name}: ${k} is required`);
  return await c.run(lib, args ?? {}, ctx);
}

// The commands.json content (also what NakliOS reads before the app opens).
export function manifest() {
  return {
    commands: COMMANDS.map(c => {
      const out = { name: c.name, label: c.label, description: c.description, scope: c.scope, input: c.input };
      if (c.shortcut) out.shortcut = c.shortcut;
      if (c.shows) out.shows = true;
      return out;
    }),
  };
}
