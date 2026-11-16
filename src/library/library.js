// The Library: one object that owns the in-memory state of the photo library
// and every change to it. The grid, the keyboard, the buttons and the agent
// commands all go through these methods, so there is one core and one undo log.
//
// State (all in memory; 100,000 records is roughly 30 to 50 MB):
//   roots    Map(rootId -> { id, name, handle, mode: 'fsa'|'files', added, lastScan })
//   records  Map(id -> PhotoRecord)              the index (store.js persists it)
//   choices  Map(id -> choice)                   the user's choices (libfile.js persists them)
//   meta     Map(id -> meta)                     date, place and caption from a Takeout or iCloud import
//                                                (libfile.js persists them; scan.js applies them)
//   albums   Map(albumId -> { id, name, created, cover: id|null, items: Set<id> })
//
// Services are injected so the core runs in Node tests with fakes:
//   services.scanRoot(lib, root, { signal, full })    scan.js: walks the folder, calls lib.applyScan
//   services.thumbs   { url(id): Promise<string|null>, remove(ids), clear(), enqueue(records) }   thumbs.js
//   services.persist  { load(root): Promise<libfile|null>, save(root, libfile), canWrite(root) }  persist.js
//   services.trash    { move(root, path), restore(root, path), purge(root, path) }                trash.js
//   services.ui       { openInEditor(id), showLibrary(), select(ids) }                            ui/library/view.js
//
// Events (lib.on(type, fn)):
//   'records'  { ids: string[]|null, reason }   records added, changed or removed (null = many)
//   'choices'  { ids: string[], reason }        favourites, ratings, flags, tags, hidden, trash
//   'albums'   { albumId|null, reason }
//   'roots'    {}
//   'saved'    { rootId }                       library file written
//   'error'    { message }

import { JobQueue } from './jobs.js';
import { LIBRARY_FILE, emptyChoice, makeId, splitId, normTag, FLAGS, normPath, kindOf, extOf, folderOf, newRecord, instantToWallClock } from './schema.js';
import { createMove, renderName } from './move.js';
import { LIBRARY_META_FILE, parseLibFile, buildLibFile, rematchMoved, newAlbumId, isBlankChoice, mergeLibFiles, inTrash, toTrashPath, fromTrashPath } from './libfile.js';
import { query, choiceOf, tagCounts, folderCounts, effectiveRating, allTags } from './query.js';

const UNDO_LIMIT = 200;
const SAVE_DELAY_MS = 600;
// Trash saves the trashed flags before it moves the files, in batches of this many (review S3).
export const TRASH_BATCH = 50;
// How long a path Slate itself wrote, moved or renamed stays on the self-write list (watch.js).
export const SELF_WRITE_MS = 5000;

// The key a path is matched by on the self-write list: its folder and its name up to the first
// dot, lower-cased, so a photo's sidecars (IMG_1.jpg.xmp, IMG_1.xmp, its Takeout JSON) and its
// Live Photo movie match the photo. A file another program adds under the same stem within
// SELF_WRITE_MS is missed by the watcher; the next rescan finds it.
export function selfWriteKey(rootId, path) {
  const i = path.lastIndexOf('/');
  const name = path.slice(i + 1), dot = name.indexOf('.');
  return `${rootId}\u0000${path.slice(0, i + 1)}${dot > 0 ? name.slice(0, dot) : name}`.toLowerCase();
}

// Run fn while holding a Web Lock, where the browser has them, so two tabs on one folder never
// read and write its library file at the same time (review S2).
function withLock(name, fn) {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.request === 'function' ? locks.request(name, fn) : fn();
}

export class Library {
  constructor({ store, services = {}, saveDelay = SAVE_DELAY_MS } = {}) {
    this.store = store;
    this.services = services;
    this.roots = new Map();
    this.records = new Map();
    this.choices = new Map();
    this.meta = new Map();
    this.albums = new Map();
    this.jobs = new JobQueue({ concurrency: 4 });
    this.listeners = new Map();
    this.undoLog = new Map();
    this.dirtyRoots = new Set();
    this.saveTimer = null;
    this.saveDelay = saveDelay;
    this.loaded = false;
    // Saving the library file safely (reviews S1, S2):
    this.times = new Map();       // id -> ms of the last change to its choices or import details
    this.albumTombs = new Map();  // albumId -> ms it was deleted
    this.libLoaded = new Set();   // roots whose library file was read (or found absent) this session
    this.libExtra = new Map();    // rootId -> unknown top-level fields of its library file
    this.again = new Map();       // rootId -> { full, paths } a rescan asked for while that root was scanning
    this.selfWrites = new Map();  // selfWriteKey -> ms: files Slate itself wrote, moved or renamed
    this.flushing = Promise.resolve();
    // A closing or hidden page writes what is pending (review S3).
    if (typeof globalThis.addEventListener === 'function') {
      const now = () => { if (this.dirtyRoots.size) this.flush().catch(() => {}); };
      globalThis.addEventListener('pagehide', now);
      globalThis.addEventListener('visibilitychange', () => { if (globalThis.document?.visibilityState === 'hidden') now(); });
    }
  }

  // ── events ──────────────────────────────────────────────────────────────
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) { try { fn(data); } catch (e) { console.error('[slate library]', type, e); } }
  }

  // ── load ────────────────────────────────────────────────────────────────
  async load() {
    for (const r of await this.store.allRoots()) this.roots.set(r.id, r);
    const fixed = [];
    for (const rec of await this.store.allPhotos()) {
      // Indexes from before review S9 stored a file date as a true instant; convert once to the local wall clock.
      if (rec.timeSource === 'file' && rec.mtime && rec.time === rec.mtime) { rec.time = instantToWallClock(rec.mtime); fixed.push(rec); }
      this.records.set(rec.id, rec);
    }
    if (fixed.length) await this.store.putPhotos(fixed);
    for (const root of this.roots.values()) await this.loadLibFile(root);
    this.loaded = true;
    this.emit('roots', {});
    this.emit('records', { ids: null, reason: 'load' });
  }

  // Read one root's library file and merge it into memory. Returns true when the file was read
  // or is absent (NotFoundError counts as an empty file), false when it could not be read, as
  // when the folder's permission is still "prompt" after a browser restart (review S1). Until a
  // read succeeds, that root's file on disk is never written (see #saveRoot).
  async loadLibFile(root) {
    if (!this.services.persist) { this.libLoaded.add(root.id); return true; }
    let file;
    try { file = await this.services.persist.load(root); }
    catch (e) {
      // No permission yet is expected after a restart; the scan asks for it and reads again.
      if (e?.name !== 'NotAllowedError' && e?.name !== 'SecurityError') this.emit('error', { message: `Could not read the library file in ${root.name}: ${e.message}` });
      return false;
    }
    this.libLoaded.add(root.id);
    if (file) this.mergeIn(root.id, file);
    return true;
  }

  // Merge a parsed library file into memory for one root, item by item: the newer change wins
  // (libfile.mergeLibFiles), so nothing chosen in memory is lost. Returns the number of entries
  // the file changed.
  mergeIn(rootId, file) {
    const { file: merged, changed } = mergeLibFiles(this.libFileFor(rootId), file);
    if (merged.x) this.libExtra.set(rootId, merged.x);
    if (changed) this.applyLibFile(rootId, merged);
    return changed;
  }

  // Replace choices, import details, change times and albums for one root with a parsed library
  // file (or its text).
  applyLibFile(rootId, fileOrText) {
    const file = typeof fileOrText === 'string' ? parseLibFile(fileOrText).file : fileOrText;
    for (const map of [this.choices, this.meta, this.times]) for (const id of [...map.keys()]) if (splitId(id).rootId === rootId) map.delete(id);
    for (const a of this.albums.values()) for (const id of [...a.items]) if (splitId(id).rootId === rootId) a.items.delete(id);
    for (const [path, { meta, t, ...c }] of Object.entries(file.items)) {
      const id = makeId(rootId, path);
      this.choices.set(id, { ...emptyChoice(), ...c });
      if (meta) this.meta.set(id, meta);
      if (t != null) this.times.set(id, t);
      // An older file kept a trashed item at its original path; move its index row to the trash id.
      if (inTrash(path) && c.trashed && !this.records.has(id)) {
        const oldId = makeId(rootId, fromTrashPath(path)), old = this.records.get(oldId);
        if (old && !this.choices.has(oldId)) {
          this.records.delete(oldId);
          this.records.set(id, { ...old, id, path, thumb: null });
          this.store.deletePhotos?.([oldId]);
          this.store.putPhotos?.([this.records.get(id)]);
        }
      }
    }
    for (const [path, t] of Object.entries(file.deleted || {})) this.times.set(makeId(rootId, path), t);
    for (const a of file.albums) {
      let al = this.albums.get(a.id);
      if (!al) { al = { id: a.id, name: a.name, created: a.created, cover: null, items: new Set(), homeRoot: rootId }; this.albums.set(a.id, al); }
      if ((a.t ?? 0) >= (al.t ?? 0)) { al.name = a.name; if (a.t != null) al.t = a.t; }
      for (const p of a.items) al.items.add(makeId(rootId, p));
      if (a.cover) al.cover = makeId(rootId, a.cover);
    }
    for (const [aid, t] of Object.entries(file.deletedAlbums || {})) {
      this.albumTombs.set(aid, Math.max(this.albumTombs.get(aid) ?? 0, t));
      const al = this.albums.get(aid);
      if (al && (al.t ?? 0) <= t) this.albums.delete(aid);
    }
    if (file.x) this.libExtra.set(rootId, file.x);
    this.emit('choices', { ids: null, reason: 'libfile' });
    this.emit('albums', { albumId: null, reason: 'libfile' });
  }

  // ── roots ───────────────────────────────────────────────────────────────
  // `handle` is a FileSystemDirectoryHandle (mode 'fsa') or null with `files`
  // (browse-only mode: a webkitdirectory pick on Firefox and Safari).
  async addRoot({ handle = null, name, files = null }) {
    for (const r of this.roots.values()) {
      if (handle && r.handle && await r.handle.isSameEntry?.(handle)) return r;
    }
    const root = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name ?? handle?.name ?? 'Photos', handle, mode: handle ? 'fsa' : 'files',
      added: Date.now(), lastScan: 0,
    };
    if (files) root.files = files; // in memory only; not persisted (a File list cannot be stored)
    this.roots.set(root.id, root);
    await this.store.putRoot(stripRoot(root));
    await this.loadLibFile(root);
    this.emit('roots', {});
    await this.rescan(root.id);
    return root;
  }

  async removeRoot(rootId) {
    const root = this.roots.get(rootId);
    if (!root) throw new Error(`no root ${rootId}`);
    await this.flush();
    const ids = [...this.records.values()].filter(r => r.rootId === rootId).map(r => r.id);
    for (const id of ids) this.records.delete(id);
    for (const map of [this.choices, this.meta, this.times]) for (const id of [...map.keys()]) if (splitId(id).rootId === rootId) map.delete(id);
    for (const a of this.albums.values()) for (const id of [...a.items]) if (splitId(id).rootId === rootId) a.items.delete(id);
    this.roots.delete(rootId);
    this.libLoaded.delete(rootId);
    this.libExtra.delete(rootId);
    await this.store.deleteRoot(rootId);
    await this.services.thumbs?.remove(ids);
    this.emit('roots', {});
    this.emit('records', { ids: null, reason: 'remove-root' });
  }

  // A rescan of a root that is already being scanned does not start a second scan beside it
  // (found on the real photo set: opening the Library while a new folder was scanning read every
  // file twice). It asks for one more scan when the running one ends, because the running walk
  // may have passed files that changed after it started (review S14); any number of such
  // requests give one more scan. The caller waits for both.
  //
  // paths (with a rootId): rescan only those relative paths (files, folders, or paths now gone),
  // as the folder watcher asks; null rescans the whole root. A whole-root request waiting beside
  // path requests wins.
  async rescan(rootId = null, { full = false, paths = null } = {}) {
    const roots = rootId ? [this.roots.get(rootId)] : [...this.roots.values()];
    if (!rootId) paths = null;
    this.scanning ??= new Map();
    for (const root of roots) {
      if (!root) throw new Error(`no root ${rootId}`);
      if (!this.services.scanRoot) throw new Error('scanning is not available');
      const running = this.scanning.get(root.id);
      if (running) {
        const prev = this.again.get(root.id);
        const merged = (prev && !prev.paths) || !paths ? null : new Set([...(prev?.paths ?? []), ...paths]);
        this.again.set(root.id, { full: full || !!prev?.full, paths: merged });
        await running;
        continue;
      }
      const p = this.#scanLoop(root, full, paths ? new Set(paths) : null);
      this.scanning.set(root.id, p);
      try { await p; } finally { if (this.scanning.get(root.id) === p) this.scanning.delete(root.id); }
    }
  }

  async #scanLoop(root, full, paths) {
    try {
      for (;;) {
        await Promise.resolve().then(() => this.services.scanRoot(this, root, paths ? { full, paths: [...paths] } : { full }));
        // A scanner that does not read the library file itself (scan.js does, after its
        // permission step) still gets it read once the folder could be walked.
        if (!this.libLoaded.has(root.id)) await this.loadLibFile(root);
        const next = this.again.get(root.id);
        if (!next) return;
        this.again.delete(root.id);
        full = next.full;
        paths = next.paths;
      }
    } finally { this.again.delete(root.id); }
  }

  // Called by scan.js with the result of walking one root.
  //   upserts: PhotoRecord[]  new or changed rows
  //   seen:    Set<id>        every id found on disk this scan (null when part of the walk failed)
  //   scope:   path => bool   a scan of some paths only: `seen` covers just the records whose
  //                           path it accepts, so only those can turn missing or found again
  async applyScan(rootId, { upserts = [], seen = null, scope = null } = {}) {
    for (const r of upserts) this.records.set(r.id, r);
    if (upserts.length) await this.store.putPhotos(upserts);
    let missing = [];
    if (seen) {
      // A MOV now paired with a Live Photo has no record of its own: drop it rather than mark it missing.
      const paired = new Set();
      for (const r of this.records.values()) if (r.rootId === rootId && r.liveVideo) paired.add(makeId(rootId, r.liveVideo));
      const inScope = (id) => !scope || scope(splitId(id).path);
      const dropped = [...paired].filter(id => this.records.has(id) && inScope(id) && !seen.has(id) && !this.choices.get(id)?.trashed);
      if (dropped.length) {
        for (const id of dropped) this.records.delete(id);
        await this.store.deletePhotos(dropped);
        await this.services.thumbs?.remove(dropped);
        missing.push(...dropped.map(id => ({ id })));
      }
      for (const r of this.records.values()) {
        if (r.rootId !== rootId || (scope && !scope(r.path))) continue;
        const gone = !seen.has(r.id) && !this.choices.get(r.id)?.trashed;
        if (gone !== !!r.missing) { r.missing = gone; missing.push(r); }
      }
      if (missing.length) await this.store.putPhotos(missing);
      const root = this.roots.get(rootId);
      if (root && !scope) { root.lastScan = Date.now(); await this.store.putRoot(stripRoot(root)); }
      this.reconcile(rootId);
    }
    if (upserts.length || missing.length) this.emit('records', { ids: [...upserts, ...missing].map(r => r.id), reason: 'scan' });
  }

  // Fill in fields of existing records (thumbnail state, video duration and size,
  // late metadata). `patches` is [{ id, ...fields }]; unknown ids are ignored.
  async patchRecords(patches, reason = 'patch') {
    const changed = [];
    for (const p of patches) {
      const r = this.records.get(p.id);
      if (!r) continue;
      Object.assign(r, p);
      changed.push(r);
    }
    if (changed.length) {
      await this.store.putPhotos(changed);
      this.emit('records', { ids: changed.map(r => r.id), reason });
    }
    return changed.length;
  }

  // Import details (date, place, caption) for one record, from scan.js (Takeout) or
  // icloud.js. Saved in the library file so a rebuild restores them; null removes them.
  setMeta(id, meta) {
    if (meta) this.meta.set(id, meta); else this.meta.delete(id);
    this.#stamp(id);
  }

  // After a full scan: carry choices, import details and album membership over to files that
  // moved within the root (same name and size), then drop missing rows that
  // have no choices attached.
  reconcile(rootId) {
    const items = {};
    for (const [id, c] of this.choices) {
      const { rootId: rid, path } = splitId(id);
      if (rid === rootId) items[path] = { ...c, size: c.size ?? this.records.get(id)?.size };
    }
    for (const id of this.meta.keys()) {
      const { rootId: rid, path } = splitId(id);
      if (rid === rootId && !items[path]) items[path] = { size: this.records.get(id)?.size };
    }
    const present = [...this.records.values()].filter(r => r.rootId === rootId && !r.missing && !inTrash(r.path));
    const sizeOf = new Map(present.map(r => [r.path, r.size]));
    const moves = rematchMoved(items, present.map(r => r.path), p => sizeOf.get(p));
    for (const [from, to] of moves) {
      const fromId = makeId(rootId, from), toId = makeId(rootId, to);
      this.#moveChoices(fromId, toId);
      const old = this.records.get(fromId);
      if (old?.missing) { this.records.delete(fromId); this.store.deletePhotos([fromId]); }
    }
    if (moves.size) { this.markDirty(rootId); this.emit('choices', { ids: null, reason: 'moved' }); }
  }

  // Rebuild: forget the index and thumbnails, keep roots and choices, scan again.
  async rebuild() {
    await this.flush();
    const roots = [...this.roots.values()];
    await this.services.thumbs?.clear();
    await this.store.clear();
    this.records.clear();
    for (const r of roots) { r.lastScan = 0; await this.store.putRoot(stripRoot(r)); }
    this.emit('records', { ids: null, reason: 'rebuild' });
    for (const r of roots) await this.rescan(r.id, { full: true });
  }

  // ── files on disk ───────────────────────────────────────────────────────
  // The FileSystemFileHandle for a record (fsa roots), walking from the root.
  // `parent: true` returns the containing FileSystemDirectoryHandle instead.
  async getHandle(id, { parent = false } = {}) {
    const { rootId, path } = splitId(id);
    const root = this.roots.get(rootId);
    if (!root?.handle) return null;
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root.handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    return parent ? dir : dir.getFileHandle(name);
  }

  // Slate's own writes (the library and meta files, XMP sidecars, moves into and out of the
  // trash, moves and renames): watch.js ignores a change to a path noted here in the last
  // SELF_WRITE_MS, so Slate's writes never start a rescan.
  noteSelfWrite(rootId, ...paths) {
    const now = Date.now();
    for (const p of paths) if (p) this.selfWrites.set(selfWriteKey(rootId, p), now);
  }
  isSelfWrite(rootId, path, now = Date.now()) {
    for (const [k, t] of this.selfWrites) if (now - t > SELF_WRITE_MS) this.selfWrites.delete(k);
    return this.selfWrites.has(selfWriteKey(rootId, path));
  }

  // The File for a record, from either kind of root. Throws when it is gone.
  async getFile(id) {
    const { rootId, path } = splitId(id);
    const root = this.roots.get(rootId);
    if (!root) throw new Error(`no root for ${id}`);
    if (root.handle) return (await this.getHandle(id)).getFile();
    const f = (root.files || []).find(x => relPathOf(x) === path);
    if (!f) throw new Error(`${path} is not in this browse-only folder; add the folder again`);
    return f;
  }

  // ── reads ───────────────────────────────────────────────────────────────
  get(id) { return this.records.get(id) ?? null; }
  choice(id) { return choiceOf(this.choices, id); }
  // textOf (set by textindex.js) lets words match text read from photos; hiddenLocked (locked.js)
  // keeps hidden photos out of every result until the passphrase is given this session.
  search(opts = {}) { return query(this.records.values(), this.choices, this.albums, { textOf: this.textOf, ...opts, lockHidden: !!this.hiddenLocked?.() }); }
  tags() { return tagCounts(this.records.values(), this.choices); }
  // Counts leave out trashed photos, and hidden ones while the lock is set (review S6).
  folders() { return folderCounts([...this.records.values()].filter(r => !this.choice(r.id).trashed && this.visible?.(r.id) !== false)); }
  rating(id) { const r = this.records.get(id); return r ? effectiveRating(r, this.choice(id)) : 0; }
  tagsOf(id) { const r = this.records.get(id); return r ? allTags(r, this.choice(id)) : []; }
  albumsOf(id) { return [...this.albums.values()].filter(a => a.items.has(id)); }
  counts() {
    let photos = 0, videos = 0, missing = 0, fav = 0, hidden = 0, trashed = 0;
    for (const r of this.records.values()) {
      const c = this.choice(r.id);
      if (c.trashed) { trashed++; continue; }
      if (r.missing) missing++;
      if (c.hidden) { hidden++; continue; }
      if (r.kind === 'video') videos++; else photos++;
      if (c.fav) fav++;
    }
    return { photos, videos, missing, favourites: fav, hidden, trashed, albums: this.albums.size, roots: this.roots.size };
  }

  // ── choice writes ───────────────────────────────────────────────────────
  // Every write takes ids, returns { changed, undo } and records an undo entry.
  // With { dryRun: true } it returns { changed, dryRun: true } and changes nothing.

  setFavourite(ids, value, opts) { return this.#editChoices(ids, c => { c.fav = !!value; }, 'favourite', opts); }
  // Rating 0 on a photo whose XMP has a rating records the clearing (`ratingSet`), so the
  // file's rating no longer shows (review S10).
  setRating(ids, rating, opts) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('rating must be a whole number from 0 to 5');
    return this.#editChoices(ids, (c, id) => {
      c.rating = rating;
      if (rating === 0 && this.records.get(id)?.xmpRating) c.ratingSet = true; else delete c.ratingSet;
    }, 'rate', opts);
  }
  setFlag(ids, flag, opts) {
    const f = flag === 'none' || flag == null ? null : flag;
    if (f && !FLAGS.includes(f)) throw new Error('flag must be pick, reject or none');
    return this.#editChoices(ids, c => { c.flag = f; }, 'flag', opts);
  }
  setHidden(ids, value, opts) { return this.#editChoices(ids, c => { c.hidden = !!value; }, 'hide', opts); }
  tag(ids, { add = [], remove = [] } = {}, opts) {
    const a = add.map(normTag).filter(Boolean), rm = new Set(remove.map(t => normTag(t).toLowerCase()));
    if (!a.length && !rm.size) throw new Error('give tags to add or remove');
    // A tag that came from the file (XMP or an import) is hidden by `removedTags` (review S10).
    return this.#editChoices(ids, (c, id) => {
      const next = (c.tags || []).filter(t => !rm.has(t.toLowerCase()));
      for (const t of a) if (!next.some(x => x.toLowerCase() === t.toLowerCase())) next.push(t);
      c.tags = next;
      const fileTags = this.records.get(id)?.xmpTags || [];
      const added = new Set(a.map(t => t.toLowerCase()));
      const removed = (c.removedTags || []).filter(t => !added.has(t.toLowerCase()));
      for (const t of fileTags) if (rm.has(t.toLowerCase()) && !removed.some(x => x.toLowerCase() === t.toLowerCase())) removed.push(t);
      if (removed.length) c.removedTags = removed; else delete c.removedTags;
    }, 'tag', opts);
  }

  #editChoices(ids, mutate, reason, { dryRun = false } = {}) {
    const list = this.#checkIds(ids);
    const before = new Map();
    let changed = 0;
    for (const id of list) {
      const prev = this.choices.get(id);
      const next = prev ? { ...prev, tags: [...(prev.tags || [])] } : emptyChoice();
      mutate(next, id);
      if (sameChoice(prev, next)) continue;
      changed++;
      if (dryRun) continue;
      before.set(id, prev ? { ...prev, tags: [...(prev.tags || [])] } : null);
      if (isBlankChoice(next)) this.choices.delete(id); else this.choices.set(id, next);
      this.#stamp(id);
    }
    if (dryRun) return { changed, dryRun: true };
    if (!changed) return { changed: 0, undo: null };
    this.emit('choices', { ids: [...before.keys()], reason });
    const undo = this.#remember(reason, () => {
      for (const [id, prev] of before) {
        if (prev && !isBlankChoice(prev)) this.choices.set(id, prev); else this.choices.delete(id);
        this.#stamp(id);
      }
      this.emit('choices', { ids: [...before.keys()], reason: 'undo' });
    });
    return { changed, undo };
  }

  // ── trash ───────────────────────────────────────────────────────────────
  // Trash moves the file into `.slate-trash/<path>` under its root (trash.js), with its
  // sidecars and its Live Photo movie, and re-keys the record to its trash id
  // `<rootId>/.slate-trash/<path>`, so a new file at the old path is a separate, live photo
  // (review S21). Restore moves it back. Emptying the trash is the only permanent delete.
  //
  // The trashed flags are saved before the files move, in batches of TRASH_BATCH, so a closed
  // tab never leaves a file in .slate-trash with no record (review S3). A file that then fails to
  // move is put back. Each scan also lists .slate-trash and repairs what is left (recoverTrash).
  async trash(ids, { dryRun = false } = {}) {
    const list = this.#checkIds(ids).filter(id => !this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const done = [];
    for (let i = 0; i < list.length; i += TRASH_BATCH) {
      const planned = [];
      for (const id of list.slice(i, i + TRASH_BATCH)) {
        const { rootId, path } = splitId(id);
        const tpath = toTrashPath(path), tid = makeId(rootId, tpath);
        if (this.records.has(tid)) { this.emit('error', { message: `Could not move ${path} to the trash: a file named ${path} is already in the trash for this folder` }); continue; }
        const rec = this.records.get(id);
        const live = rec.liveVideo ?? null, missing = !!rec.missing;
        const next = this.#rekey(id, tid, tpath);
        if (live) next.liveVideo = toTrashPath(live);
        this.choices.set(tid, { ...this.choice(tid), tags: [...this.choice(tid).tags], trashed: new Date().toISOString() });
        this.#stamp(tid);
        planned.push({ id, tid, rootId, path, live, missing, next });
      }
      if (!planned.length) continue;
      await this.#storeRekeys(planned.map(p => [p.id, p.tid]));
      await this.flush();
      const back = [];
      for (const p of planned) {
        const root = this.roots.get(p.rootId);
        try {
          this.noteSelfWrite(p.rootId, p.path, p.live);
          if (!p.missing) this.#noteRenamed(await this.services.trash?.move(root, p.path), p.path);
        } catch (e) {
          this.emit('error', { message: `Could not move ${p.path} to the trash: ${e.message}` });
          const c = { ...this.choice(p.tid), tags: [...this.choice(p.tid).tags], trashed: null };
          const r = this.#rekey(p.tid, p.id, p.path);
          if (p.live) r.liveVideo = p.live;
          if (isBlankChoice(c)) this.choices.delete(p.id); else this.choices.set(p.id, c);
          this.#stamp(p.id);
          back.push([p.tid, p.id]);
          continue;
        }
        if (p.live && !p.missing) {
          try { this.#noteRenamed(await this.services.trash?.move(root, p.live), p.live); }
          catch (e) {
            p.next.liveVideo = p.live;
            this.emit('error', { message: `Moved ${p.path} to the trash, but its Live Photo movie ${p.live} stayed: ${e.message}` });
          }
        }
        done.push(p.tid);
      }
      if (back.length) await this.#storeRekeys(back);
      this.#thumbRekeys(planned.filter(p => !p.missing).map(p => done.includes(p.tid) ? [p.id, p.tid] : [p.tid, p.id]));
    }
    if (done.length) {
      this.emit('records', { ids: null, reason: 'trash' });
      this.emit('choices', { ids: done, reason: 'trash' });
      this.emit('albums', { albumId: null, reason: 'trash' });
    }
    const undo = done.length ? this.#remember('trash', () => this.restore(done)) : null;
    return { changed: done.length, undo };
  }

  async restore(ids, { dryRun = false } = {}) {
    const list = this.#checkIds(this.#trashIds(ids)).filter(id => this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const done = [], moved = [];
    for (const id of list) {
      const { rootId, path } = splitId(id);
      const orig = fromTrashPath(path), oid = makeId(rootId, orig);
      const rec = this.records.get(id), root = this.roots.get(rootId);
      try {
        if (oid !== id && this.records.get(oid) && !this.records.get(oid).missing) throw new Error(`${orig} already exists, so the trashed copy was left in the trash`);
        this.noteSelfWrite(rootId, orig, rec?.liveVideo ? fromTrashPath(rec.liveVideo) : null);
        if (!rec?.missing) this.#noteRenamed(await this.services.trash?.restore(root, orig), orig);
      } catch (e) {
        this.emit('error', { message: `Could not restore ${orig}: ${e.message}` });
        continue;
      }
      if (inTrash(rec.liveVideo) && !rec.missing) {
        try { this.#noteRenamed(await this.services.trash?.restore(root, fromTrashPath(rec.liveVideo)), fromTrashPath(rec.liveVideo)); rec.liveVideo = fromTrashPath(rec.liveVideo); }
        catch (e) { this.emit('error', { message: `Restored ${orig}, but its Live Photo movie stayed in the trash: ${e.message}` }); }
      }
      if (oid !== id) {
        if (this.records.has(oid)) { this.records.delete(oid); await this.store.deletePhotos([oid]); }
        this.#rekey(id, oid, orig);
        moved.push([id, oid]);
      }
      const c = { ...this.choice(oid), tags: [...this.choice(oid).tags], trashed: null };
      if (isBlankChoice(c)) this.choices.delete(oid); else this.choices.set(oid, c);
      this.#stamp(oid);
      done.push(oid);
    }
    if (moved.length) { await this.#storeRekeys(moved); this.#thumbRekeys(moved); }
    if (done.length) {
      this.emit('records', { ids: null, reason: 'restore' });
      this.emit('choices', { ids: done, reason: 'restore' });
      this.emit('albums', { albumId: null, reason: 'restore' });
    }
    const undo = done.length ? this.#remember('restore', () => this.trash(done)) : null;
    return { changed: done.length, undo };
  }

  // Permanent: deletes the trashed files (and their Live Photo movies) from disk and forgets them.
  async emptyTrash({ ids = null, dryRun = false } = {}) {
    const list = (ids ? this.#checkIds(this.#trashIds(ids)) : [...this.records.keys()]).filter(id => this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const gone = [];
    for (const id of list) {
      const { rootId, path } = splitId(id);
      const rec = this.records.get(id), root = this.roots.get(rootId);
      try {
        if (!rec?.missing) {
          await this.services.trash?.purge(root, fromTrashPath(path));
          if (inTrash(rec.liveVideo)) {
            try { await this.services.trash?.purge(root, fromTrashPath(rec.liveVideo)); }
            catch (e) { if (e?.name !== 'NotFoundError') this.emit('error', { message: `Could not delete the Live Photo movie of ${path}: ${e.message}` }); }
          }
        }
        this.records.delete(id);
        this.choices.delete(id);
        this.meta.delete(id);
        for (const a of this.albums.values()) { a.items.delete(id); if (a.cover === id) a.cover = null; }
        this.#stamp(id);
        gone.push(id);
      } catch (e) {
        this.emit('error', { message: `Could not delete ${path}: ${e.message}` });
      }
    }
    if (gone.length) {
      await this.store.deletePhotos(gone);
      await this.services.thumbs?.remove(gone);
      this.emit('records', { ids: gone, reason: 'empty-trash' });
      this.emit('albums', { albumId: null, reason: 'empty-trash' });
    }
    return { changed: gone.length, undo: null };
  }

  // Repair the trash after a scan (reviews S2, S3), from scan.js:
  //   entries  [{ path, file, liveVideo? }] every photo and video under .slate-trash (path inside the root)
  //   seen     Set of live ids from the same scan, or null when the walk was incomplete
  // A file in the trash with no trashed record gets one, taking any choices left at its original
  // path. A trashed record whose file is back at its original path (a tab closed between the save
  // and the move) becomes that live photo again. A trashed record with no file anywhere is marked
  // missing. Returns the number of records changed.
  async recoverTrash(rootId, entries, { seen = null } = {}) {
    const found = new Map(entries.map(e => [makeId(rootId, e.path), e]));
    const put = [], drop = [], changed = [];
    for (const [tid, e] of found) {
      let rec = this.records.get(tid);
      const c = this.choices.get(tid);
      if (rec && c?.trashed && !rec.missing) continue;
      if (!rec) { rec = newRecord(rootId, e.path, e.file); this.records.set(tid, rec); }
      if (e.liveVideo) rec.liveVideo = e.liveVideo;
      rec.missing = false;
      put.push(rec);
      const oid = makeId(rootId, fromTrashPath(e.path));
      if (!c && this.choices.has(oid) && !(seen?.has(oid))) {
        this.#moveChoices(oid, tid);
        if (this.records.get(oid)?.missing) { this.records.delete(oid); drop.push(oid); }
      }
      const cur = this.choices.get(tid) ?? emptyChoice();
      if (!cur.trashed) {
        this.choices.set(tid, { ...cur, tags: [...(cur.tags || [])], trashed: new Date(e.file?.lastModified || Date.now()).toISOString() });
        this.#stamp(tid);
      }
      changed.push(tid);
    }
    if (seen) {
      for (const r of [...this.records.values()]) {
        if (r.rootId !== rootId || !inTrash(r.path) || found.has(r.id)) continue;
        const oid = makeId(rootId, fromTrashPath(r.path));
        if (seen.has(oid)) {
          // The move never happened: the photo is live at its own path.
          const c = this.choices.get(r.id);
          this.records.delete(r.id); drop.push(r.id);
          this.#moveChoices(r.id, oid);
          if (c) {
            const back = { ...c, tags: [...(c.tags || [])], trashed: null };
            if (isBlankChoice(back)) this.choices.delete(oid); else this.choices.set(oid, back);
          }
          changed.push(oid);
        } else if (!this.choices.get(r.id)?.trashed) {
          this.records.delete(r.id); drop.push(r.id); changed.push(r.id);
        } else if (!r.missing) { r.missing = true; put.push(r); changed.push(r.id); }
      }
    }
    if (drop.length) { await this.store.deletePhotos(drop); await this.services.thumbs?.remove?.(drop); }
    if (put.length) { await this.store.putPhotos(put); this.services.thumbs?.enqueue?.(put.filter(r => r.thumb == null)); }
    if (changed.length) {
      this.markDirty(rootId);
      this.emit('records', { ids: changed, reason: 'trash-recovery' });
      this.emit('choices', { ids: changed, reason: 'trash-recovery' });
    }
    return changed.length;
  }

  // Ids given for a trashed photo by its original id map to its trash id.
  #trashIds(ids) {
    if (!Array.isArray(ids)) return ids;
    return ids.map(id => {
      if (this.records.has(id)) return id;
      const { rootId, path } = splitId(id);
      const tid = makeId(rootId, toTrashPath(path));
      return this.records.has(tid) ? tid : id;
    });
  }

  // A sidecar that had to take a new name to keep both copies (review S27).
  #noteRenamed(res, path) {
    for (const r of res?.renamed || []) {
      this.emit('error', { message: `A sidecar named ${r.from} was already there, so the one for ${path} was kept as ${r.to}.` });
    }
  }

  // Thumbnails are stored by id: drop the old ones and make new ones for the files' new places.
  #thumbRekeys(pairs) {
    if (!pairs.length) return;
    Promise.resolve(this.services.thumbs?.remove?.(pairs.map(([from]) => from))).catch(() => {});
    this.services.thumbs?.enqueue?.(pairs.map(([, to]) => this.records.get(to)).filter(r => r && !r.missing));
  }

  async #storeRekeys(pairs) {
    if (!pairs.length) return;
    await this.store.deletePhotos(pairs.map(([from]) => from));
    await this.store.putPhotos(pairs.map(([, to]) => this.records.get(to)).filter(Boolean));
  }

  // ── albums ──────────────────────────────────────────────────────────────
  albumCreate(name, { ids = [], dryRun = false } = {}) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('an album needs a name');
    const list = ids.length ? this.#checkIds(ids) : [];
    if (dryRun) return { changed: 1, dryRun: true };
    const al = { id: newAlbumId(), name: n.slice(0, 200), created: new Date().toISOString(), cover: null, items: new Set(list),
      homeRoot: list.length ? splitId(list[0]).rootId : [...this.roots.keys()][0] ?? null };
    this.albums.set(al.id, al);
    this.#dirtyAlbum(al);
    this.emit('albums', { albumId: al.id, reason: 'create' });
    const undo = this.#remember('album-create', () => { this.albums.delete(al.id); this.#dirtyAlbum(al); this.emit('albums', { albumId: al.id, reason: 'undo' }); });
    return { changed: 1, albumId: al.id, undo };
  }

  albumRename(albumId, name, { dryRun = false } = {}) {
    const al = this.#album(albumId);
    const n = String(name ?? '').trim();
    if (!n) throw new Error('an album needs a name');
    if (dryRun) return { changed: al.name === n ? 0 : 1, dryRun: true };
    const prev = al.name;
    al.name = n.slice(0, 200);
    this.#dirtyAlbum(al);
    this.emit('albums', { albumId, reason: 'rename' });
    return { changed: 1, undo: this.#remember('album-rename', () => { al.name = prev; this.#dirtyAlbum(al); this.emit('albums', { albumId, reason: 'undo' }); }) };
  }

  // Deleting an album never touches photos.
  albumDelete(albumId, { dryRun = false } = {}) {
    const al = this.#album(albumId);
    if (dryRun) return { changed: 1, dryRun: true };
    this.albums.delete(albumId);
    this.#dirtyAlbum(al);
    this.emit('albums', { albumId, reason: 'delete' });
    return { changed: 1, undo: this.#remember('album-delete', () => { this.albums.set(albumId, al); this.#dirtyAlbum(al); this.emit('albums', { albumId, reason: 'undo' }); }) };
  }

  albumAdd(albumId, ids, { dryRun = false } = {}) {
    const al = this.#album(albumId);
    const list = this.#checkIds(ids).filter(id => !al.items.has(id));
    if (dryRun) return { changed: list.length, dryRun: true };
    for (const id of list) al.items.add(id);
    if (!list.length) return { changed: 0, undo: null };
    this.#dirtyAlbum(al, list);
    this.emit('albums', { albumId, reason: 'add' });
    return { changed: list.length, undo: this.#remember('album-add', () => { for (const id of list) al.items.delete(id); this.#dirtyAlbum(al, list); this.emit('albums', { albumId, reason: 'undo' }); }) };
  }

  albumRemove(albumId, ids, { dryRun = false } = {}) {
    const al = this.#album(albumId);
    const list = ids.filter(id => al.items.has(id));
    if (dryRun) return { changed: list.length, dryRun: true };
    const prevCover = al.cover;
    for (const id of list) { al.items.delete(id); if (al.cover === id) al.cover = null; }
    if (!list.length) return { changed: 0, undo: null };
    this.#dirtyAlbum(al, list);
    this.emit('albums', { albumId, reason: 'remove' });
    return { changed: list.length, undo: this.#remember('album-remove', () => { for (const id of list) al.items.add(id); al.cover = prevCover; this.#dirtyAlbum(al, list); this.emit('albums', { albumId, reason: 'undo' }); }) };
  }

  albumSetCover(albumId, id, { dryRun = false } = {}) {
    const al = this.#album(albumId);
    if (!al.items.has(id)) throw new Error('the cover must be a photo in the album');
    if (dryRun) return { changed: al.cover === id ? 0 : 1, dryRun: true };
    const prev = al.cover;
    al.cover = id;
    this.#dirtyAlbum(al, [id]);
    this.emit('albums', { albumId, reason: 'cover' });
    return { changed: 1, undo: this.#remember('album-cover', () => { al.cover = prev; this.#dirtyAlbum(al); this.emit('albums', { albumId, reason: 'undo' }); }) };
  }

  albumCover(al) {
    if (al.cover && this.records.has(al.cover)) return al.cover;
    let best = null;
    for (const id of al.items) { const r = this.records.get(id); if (r && !this.choice(id).trashed && (!best || r.time > best.time)) best = r; }
    return best?.id ?? null;
  }

  // ── move and rename (spec row O10) ─────────────────────────────────────
  // moveFiles([{ id, toPath }]) moves each file inside its own root (toPath is
  // relative to the root), with its XMP sidecar, and re-keys the record, its
  // choices, album memberships and album covers to the new id. It never
  // overwrites: any conflict refuses the whole call before a file moves.
  // { dryRun: true } returns { changed, dryRun, moves: [{ id, from, to }], conflicts: [{ id, to, reason }] }.
  // Otherwise { changed, undo, moved: [{ from, to }], failed: [{ id, reason }] }.
  async moveFiles(moves, { dryRun = false } = {}) {
    if (!Array.isArray(moves) || !moves.length) throw new Error('give at least one file to move');
    this.#checkIds(moves.map(m => m?.id));
    const mover = this.services.move ?? (this._mover ??= createMove());
    const plan = [], conflicts = [], seenIds = new Set(), targets = new Set();
    for (const { id, toPath } of moves) {
      const { rootId, path } = splitId(id);
      const to = normPath(String(toPath ?? '').trim()).replace(/\/+$/, '');
      const root = this.roots.get(rootId), rec = this.records.get(id);
      const no = (reason) => conflicts.push({ id, to, reason });
      if (seenIds.has(id)) { no('the same file is listed twice'); continue; }
      seenIds.add(id);
      const segs = to.split('/');
      if (!to || segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.') || /[\\:*?"<>|\u0000-\u001f]/.test(s))) { no('not a valid path'); continue; }
      if (to === path) continue;
      if (!kindOf(segs[segs.length - 1])) { no('the new name needs a photo or video extension'); continue; }
      if (!root?.handle) { no('the folder is browse-only'); continue; }
      if (this.choice(id).trashed) { no('the file is in the trash'); continue; }
      if (rec.missing) { no('the file is missing from disk'); continue; }
      const key = to.toLowerCase();
      if (targets.has(`${rootId}/${key}`)) { no('two files would get the same name'); continue; }
      targets.add(`${rootId}/${key}`);
      const caseOnly = key === path.toLowerCase();
      if ((!caseOnly && this.records.has(makeId(rootId, to))) || await mover.exists(root, to, path)) { no('a file with that name already exists'); continue; }
      plan.push({ id, from: path, to, rootId });
    }
    if (dryRun) return { changed: plan.length, dryRun: true, moves: plan.map(({ id, from, to }) => ({ id, from, to })), conflicts };
    if (conflicts.length) {
      const c = conflicts[0];
      throw Object.assign(new Error(`${conflicts.length} of ${moves.length} files cannot be moved (${c.to || c.id}: ${c.reason}); nothing was moved`), { conflicts });
    }
    const moved = [], failed = [], oldIds = [], newRecs = [], roots = new Set();
    for (const m of plan) {
      let res;
      try {
        const live = this.records.get(m.id).liveVideo ?? null;
        // The movie and sidecars move with the photo and keep its stem, so m.to's key covers them.
        this.noteSelfWrite(m.rootId, m.from, m.to, live);
        res = await mover.move(this.roots.get(m.rootId), m.from, m.to, { liveVideo: live });
      } catch (e) {
        failed.push({ id: m.id, reason: e.message });
        this.emit('error', { message: `Could not move ${m.from}: ${e.message}` });
        continue;
      }
      const toId = makeId(m.rootId, m.to);
      const next = this.#rekey(m.id, toId, m.to);
      if (res?.liveVideo) next.liveVideo = res.liveVideo; else delete next.liveVideo;
      newRecs.push(next);
      oldIds.push(m.id);
      roots.add(m.rootId);
      moved.push({ from: m.id, to: toId, fromPath: m.from });
    }
    if (!moved.length) return { changed: 0, undo: null, moved, failed };
    await this.store.deletePhotos(oldIds);
    await this.store.putPhotos(newRecs);
    await this.services.thumbs?.remove?.(oldIds);
    this.services.thumbs?.enqueue?.(newRecs);
    for (const r of roots) this.markDirty(r);
    this.emit('records', { ids: [...oldIds, ...newRecs.map(r => r.id)], reason: 'move' });
    this.emit('choices', { ids: newRecs.map(r => r.id), reason: 'move' });
    this.emit('albums', { albumId: null, reason: 'move' });
    const undo = this.#remember('move', () => this.moveFiles(moved.map(d => ({ id: d.to, toPath: d.fromPath }))));
    return { changed: moved.length, undo, moved: moved.map(({ from, to }) => ({ from, to })), failed };
  }

  // The new names renameFiles would give, without touching anything: [{ id, toPath }].
  // Files are numbered in capture order (then path) for {n}, from `start`.
  renamePlan(ids, template, { start = 1 } = {}) {
    const list = this.#checkIds(ids).map(id => this.records.get(id))
      .sort((a, b) => (a.time || 0) - (b.time || 0) || a.path.localeCompare(b.path));
    const width = Math.max(3, String(start + list.length - 1).length);
    return list.map((r, i) => {
      const name = renderName(template, r, start + i, width);
      const folder = folderOf(r.path);
      return { id: r.id, toPath: folder ? `${folder}/${name}` : name };
    });
  }

  // Rename files in place from a template: {name} {date} {time} {n} {camera}.
  renameFiles(ids, template, { dryRun = false, start = 1 } = {}) {
    return this.moveFiles(this.renamePlan(ids, template, { start }), { dryRun });
  }

  #rekey(fromId, toId, toPath) {
    const rec = this.records.get(fromId);
    const name = toPath.slice(toPath.lastIndexOf('/') + 1);
    const next = { ...rec, id: toId, path: toPath, name, ext: extOf(name), thumb: null, indexed: Date.now() };
    this.records.delete(fromId);
    this.records.set(toId, next);
    this.#moveChoices(fromId, toId);
    return next;
  }

  // Carry choices, import details and album places from one id to another, recording both
  // changes so a merge sees the old path as removed (review S2).
  #moveChoices(fromId, toId) {
    let any = false;
    for (const map of [this.choices, this.meta]) if (map.has(fromId)) { map.set(toId, map.get(fromId)); map.delete(fromId); any = true; }
    for (const a of this.albums.values()) {
      if (a.items.delete(fromId)) { a.items.add(toId); a.t = Date.now(); any = true; }
      if (a.cover === fromId) a.cover = toId;
    }
    if (any) { this.#stamp(fromId); this.#stamp(toId); }
  }

  // Record a change to one item's choices or import details, and schedule a save.
  #stamp(id) {
    const prev = this.times.get(id) ?? 0;
    this.times.set(id, Math.max(Date.now(), prev + 1));
    this.markDirty(splitId(id).rootId);
  }

  // An undo token for a change made outside these methods (icloud.js), so it
  // shares the one undo log.
  rememberUndo(reason, fn) { return this.#remember(reason, fn); }

  // ── undo ────────────────────────────────────────────────────────────────
  undo(token) {
    const entry = this.undoLog.get(token);
    if (!entry) throw new Error('that change can no longer be undone');
    this.undoLog.delete(token);
    return Promise.resolve(entry.fn()).then(() => ({ undone: entry.reason }));
  }
  lastUndoToken() { return [...this.undoLog.keys()].pop() ?? null; }

  #remember(reason, fn) {
    const token = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.undoLog.set(token, { reason, fn });
    while (this.undoLog.size > UNDO_LIMIT) this.undoLog.delete(this.undoLog.keys().next().value);
    return token;
  }

  // ── persistence of choices ──────────────────────────────────────────────
  markDirty(rootId) {
    if (!rootId || !this.roots.has(rootId)) return;
    this.dirtyRoots.add(rootId);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush().catch(e => this.emit('error', { message: e.message })), this.saveDelay);
  }

  // Write every dirty root's library file now. Saves run one at a time.
  flush() {
    const run = this.flushing.then(() => this.#flushNow());
    this.flushing = run.catch(() => {});
    return run;
  }

  async #flushNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const roots = [...this.dirtyRoots];
    this.dirtyRoots.clear();
    for (const rootId of roots) {
      const root = this.roots.get(rootId);
      if (!root || !this.services.persist) continue;
      await withLock(`slate-libfile:${root.name ?? root.id}`, () => this.#saveRoot(root));
      this.emit('saved', { rootId });
    }
  }

  // Read the file again, merge it item by item (another tab or deployment may have written it),
  // then write. When it cannot be read, as before the folder's permission is granted, the file
  // on disk is left as it is and the choices go to kv (persist.js) until a read succeeds (S1, S2).
  async #saveRoot(root) {
    let read = false;
    try {
      const file = await this.services.persist.load(root);
      read = true;
      this.libLoaded.add(root.id);
      if (file) this.mergeIn(root.id, file);
    } catch { /* not readable now: kv only */ }
    this.noteSelfWrite(root.id, LIBRARY_FILE, LIBRARY_META_FILE);
    await this.services.persist.save(root, this.libFileFor(root.id), { disk: read && this.libLoaded.has(root.id) });
  }

  // The library file content for one root, from current state.
  libFileFor(rootId) {
    const choices = new Map(), meta = new Map(), sizes = new Map(), times = new Map();
    for (const [id, t] of this.times) {
      const { rootId: rid, path } = splitId(id);
      if (rid === rootId) times.set(path, t);
    }
    for (const [map, into] of [[this.choices, choices], [this.meta, meta]]) {
      for (const [id, v] of map) {
        const { rootId: rid, path } = splitId(id);
        if (rid !== rootId) continue;
        into.set(path, v);
        const rec = this.records.get(id);
        if (rec) sizes.set(path, rec.size);
      }
    }
    const albums = [];
    for (const a of this.albums.values()) {
      const items = [...a.items].filter(id => splitId(id).rootId === rootId).map(id => splitId(id).path);
      if (!items.length && a.homeRoot !== rootId) continue;
      const cover = a.cover && splitId(a.cover).rootId === rootId ? splitId(a.cover).path : null;
      albums.push({ id: a.id, name: a.name, created: a.created, cover, items, t: a.t });
    }
    return buildLibFile({ choices, meta, sizes, albums, times, albumTombs: this.albumTombs, extra: this.libExtra.get(rootId) ?? null });
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  #checkIds(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('give at least one photo id');
    const unknown = ids.filter(id => !this.records.has(id));
    if (unknown.length) throw new Error(`unknown photo id: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ` and ${unknown.length - 3} more` : ''}`);
    return [...new Set(ids)];
  }
  #album(albumId) {
    const al = this.albums.get(albumId);
    if (!al) throw new Error(`no album ${albumId}`);
    return al;
  }
  #dirtyAlbum(al, ids = null) {
    al.t = Math.max(Date.now(), (al.t ?? 0) + 1);
    if (this.albums.has(al.id)) this.albumTombs.delete(al.id); else this.albumTombs.set(al.id, al.t);
    const roots = new Set([al.homeRoot, ...[...(ids ?? al.items)].map(id => splitId(id).rootId)]);
    for (const r of roots) this.markDirty(r);
  }
}

// A browse-only File's path inside its root: webkitRelativePath without the
// picked folder's own name; a plain File (or test fake) uses `path` or its name.
export function relPathOf(f) {
  const rel = f.webkitRelativePath || f.path || f.name;
  const i = rel.indexOf('/');
  return f.webkitRelativePath && i >= 0 ? rel.slice(i + 1) : rel;
}

function stripRoot(root) {
  const { files, ...rest } = root;
  return rest;
}

function sameChoice(a, b) {
  const x = a ?? emptyChoice(), y = b ?? emptyChoice();
  return !!x.fav === !!y.fav && (x.rating || 0) === (y.rating || 0) && (x.flag || null) === (y.flag || null)
    && !!x.hidden === !!y.hidden && (x.trashed || null) === (y.trashed || null)
    && JSON.stringify(x.tags || []) === JSON.stringify(y.tags || [])
    && !!x.ratingSet === !!y.ratingSet && JSON.stringify(x.removedTags || []) === JSON.stringify(y.removedTags || []);
}
