// The Library: one object that owns the in-memory state of the photo library
// and every change to it. The grid, the keyboard, the buttons and the agent
// commands all go through these methods, so there is one core and one undo log.
//
// State (all in memory; 100,000 records is roughly 30 to 50 MB):
//   roots    Map(rootId -> { id, name, handle, mode: 'fsa'|'files', added, lastScan })
//   records  Map(id -> PhotoRecord)              the index (store.js persists it)
//   choices  Map(id -> choice)                   the user's choices (libfile.js persists them)
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
import { emptyChoice, isEmptyChoice, makeId, splitId, normTag, FLAGS } from './schema.js';
import { parseLibFile, buildLibFile, rematchMoved, newAlbumId } from './libfile.js';
import { query, choiceOf, tagCounts, folderCounts, effectiveRating, allTags } from './query.js';

const UNDO_LIMIT = 200;
const SAVE_DELAY_MS = 600;

export class Library {
  constructor({ store, services = {}, saveDelay = SAVE_DELAY_MS } = {}) {
    this.store = store;
    this.services = services;
    this.roots = new Map();
    this.records = new Map();
    this.choices = new Map();
    this.albums = new Map();
    this.jobs = new JobQueue({ concurrency: 4 });
    this.listeners = new Map();
    this.undoLog = new Map();
    this.dirtyRoots = new Set();
    this.saveTimer = null;
    this.saveDelay = saveDelay;
    this.loaded = false;
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
    for (const rec of await this.store.allPhotos()) this.records.set(rec.id, rec);
    for (const root of this.roots.values()) await this.loadLibFile(root);
    this.loaded = true;
    this.emit('roots', {});
    this.emit('records', { ids: null, reason: 'load' });
  }

  async loadLibFile(root) {
    const file = await this.services.persist?.load(root).catch(e => { this.emit('error', { message: `Could not read the library file in ${root.name}: ${e.message}` }); return null; });
    if (file) this.applyLibFile(root.id, file);
  }

  // Merge a parsed library file (or its text) into choices and albums for one root.
  applyLibFile(rootId, fileOrText) {
    const file = typeof fileOrText === 'string' ? parseLibFile(fileOrText).file : fileOrText;
    for (const id of [...this.choices.keys()]) if (splitId(id).rootId === rootId) this.choices.delete(id);
    for (const a of this.albums.values()) for (const id of [...a.items]) if (splitId(id).rootId === rootId) a.items.delete(id);
    for (const [path, c] of Object.entries(file.items)) this.choices.set(makeId(rootId, path), { ...emptyChoice(), ...c });
    for (const a of file.albums) {
      let al = this.albums.get(a.id);
      if (!al) { al = { id: a.id, name: a.name, created: a.created, cover: null, items: new Set(), homeRoot: rootId }; this.albums.set(a.id, al); }
      for (const p of a.items) al.items.add(makeId(rootId, p));
      if (a.cover) al.cover = makeId(rootId, a.cover);
    }
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
    for (const id of [...this.choices.keys()]) if (splitId(id).rootId === rootId) this.choices.delete(id);
    for (const a of this.albums.values()) for (const id of [...a.items]) if (splitId(id).rootId === rootId) a.items.delete(id);
    this.roots.delete(rootId);
    await this.store.deleteRoot(rootId);
    await this.services.thumbs?.remove(ids);
    this.emit('roots', {});
    this.emit('records', { ids: null, reason: 'remove-root' });
  }

  async rescan(rootId = null, { full = false } = {}) {
    const roots = rootId ? [this.roots.get(rootId)] : [...this.roots.values()];
    for (const root of roots) {
      if (!root) throw new Error(`no root ${rootId}`);
      if (!this.services.scanRoot) throw new Error('scanning is not available');
      await this.services.scanRoot(this, root, { full });
    }
  }

  // Called by scan.js with the result of walking one root.
  //   upserts: PhotoRecord[]  new or changed rows
  //   seen:    Set<id>        every id found on disk this scan (null for a partial scan)
  async applyScan(rootId, { upserts = [], seen = null } = {}) {
    for (const r of upserts) this.records.set(r.id, r);
    if (upserts.length) await this.store.putPhotos(upserts);
    let missing = [];
    if (seen) {
      for (const r of this.records.values()) {
        if (r.rootId !== rootId) continue;
        const gone = !seen.has(r.id) && !this.choices.get(r.id)?.trashed;
        if (gone !== !!r.missing) { r.missing = gone; missing.push(r); }
      }
      if (missing.length) await this.store.putPhotos(missing);
      const root = this.roots.get(rootId);
      if (root) { root.lastScan = Date.now(); await this.store.putRoot(stripRoot(root)); }
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

  // After a full scan: carry choices and album membership over to files that
  // moved within the root (same name and size), then drop missing rows that
  // have no choices attached.
  reconcile(rootId) {
    const items = {};
    for (const [id, c] of this.choices) {
      const { rootId: rid, path } = splitId(id);
      if (rid === rootId) items[path] = { ...c, size: c.size ?? this.records.get(id)?.size };
    }
    const present = [...this.records.values()].filter(r => r.rootId === rootId && !r.missing);
    const sizeOf = new Map(present.map(r => [r.path, r.size]));
    const moves = rematchMoved(items, present.map(r => r.path), p => sizeOf.get(p));
    for (const [from, to] of moves) {
      const fromId = makeId(rootId, from), toId = makeId(rootId, to);
      this.choices.set(toId, this.choices.get(fromId));
      this.choices.delete(fromId);
      for (const a of this.albums.values()) {
        if (a.items.delete(fromId)) a.items.add(toId);
        if (a.cover === fromId) a.cover = toId;
      }
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
  search(opts = {}) { return query(this.records.values(), this.choices, this.albums, opts); }
  tags() { return tagCounts(this.records.values(), this.choices); }
  folders() { return folderCounts(this.records.values()); }
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
  setRating(ids, rating, opts) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('rating must be a whole number from 0 to 5');
    return this.#editChoices(ids, c => { c.rating = rating; }, 'rate', opts);
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
    return this.#editChoices(ids, c => {
      const next = (c.tags || []).filter(t => !rm.has(t.toLowerCase()));
      for (const t of a) if (!next.some(x => x.toLowerCase() === t.toLowerCase())) next.push(t);
      c.tags = next;
    }, 'tag', opts);
  }

  #editChoices(ids, mutate, reason, { dryRun = false } = {}) {
    const list = this.#checkIds(ids);
    const before = new Map();
    let changed = 0;
    for (const id of list) {
      const prev = this.choices.get(id);
      const next = prev ? { ...prev, tags: [...(prev.tags || [])] } : emptyChoice();
      mutate(next);
      if (sameChoice(prev, next)) continue;
      changed++;
      if (dryRun) continue;
      before.set(id, prev ? { ...prev, tags: [...(prev.tags || [])] } : null);
      if (isEmptyChoice(next)) this.choices.delete(id); else this.choices.set(id, next);
      this.markDirty(splitId(id).rootId);
    }
    if (dryRun) return { changed, dryRun: true };
    if (!changed) return { changed: 0, undo: null };
    this.emit('choices', { ids: [...before.keys()], reason });
    const undo = this.#remember(reason, () => {
      for (const [id, prev] of before) {
        if (prev && !isEmptyChoice(prev)) this.choices.set(id, prev); else this.choices.delete(id);
        this.markDirty(splitId(id).rootId);
      }
      this.emit('choices', { ids: [...before.keys()], reason: 'undo' });
    });
    return { changed, undo };
  }

  // ── trash ───────────────────────────────────────────────────────────────
  // Trash moves the file into `.slate-trash/<path>` under its root (trash.js)
  // and records the time in the library file. Restore moves it back.
  // Emptying the trash is the only permanent delete.
  async trash(ids, { dryRun = false } = {}) {
    const list = this.#checkIds(ids).filter(id => !this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const done = [];
    for (const id of list) {
      const { rootId, path } = splitId(id);
      const root = this.roots.get(rootId);
      try {
        if (this.records.get(id)?.missing) { /* nothing on disk to move */ }
        else await this.services.trash?.move(root, path);
        const c = { ...this.choice(id), tags: [...this.choice(id).tags], trashed: new Date().toISOString() };
        this.choices.set(id, c);
        this.markDirty(rootId);
        done.push(id);
      } catch (e) {
        this.emit('error', { message: `Could not move ${path} to the trash: ${e.message}` });
      }
    }
    if (done.length) this.emit('choices', { ids: done, reason: 'trash' });
    const undo = done.length ? this.#remember('trash', () => this.restore(done)) : null;
    return { changed: done.length, undo };
  }

  async restore(ids, { dryRun = false } = {}) {
    const list = this.#checkIds(ids).filter(id => this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const done = [];
    for (const id of list) {
      const { rootId, path } = splitId(id);
      try {
        if (!this.records.get(id)?.missing) await this.services.trash?.restore(this.roots.get(rootId), path);
        const c = { ...this.choice(id), tags: [...this.choice(id).tags], trashed: null };
        if (isEmptyChoice(c)) this.choices.delete(id); else this.choices.set(id, c);
        this.markDirty(rootId);
        done.push(id);
      } catch (e) {
        this.emit('error', { message: `Could not restore ${path}: ${e.message}` });
      }
    }
    if (done.length) this.emit('choices', { ids: done, reason: 'restore' });
    const undo = done.length ? this.#remember('restore', () => this.trash(done)) : null;
    return { changed: done.length, undo };
  }

  // Permanent: deletes the trashed files from disk and forgets them.
  async emptyTrash({ ids = null, dryRun = false } = {}) {
    const list = (ids ? this.#checkIds(ids) : [...this.records.keys()]).filter(id => this.choice(id).trashed);
    if (dryRun) return { changed: list.length, dryRun: true };
    const gone = [];
    for (const id of list) {
      const { rootId, path } = splitId(id);
      try {
        if (!this.records.get(id)?.missing) await this.services.trash?.purge(this.roots.get(rootId), path);
        this.records.delete(id);
        this.choices.delete(id);
        for (const a of this.albums.values()) { a.items.delete(id); if (a.cover === id) a.cover = null; }
        this.markDirty(rootId);
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

  // Write every dirty root's library file now.
  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const roots = [...this.dirtyRoots];
    this.dirtyRoots.clear();
    for (const rootId of roots) {
      const root = this.roots.get(rootId);
      if (!root || !this.services.persist) continue;
      await this.services.persist.save(root, this.libFileFor(rootId));
      this.emit('saved', { rootId });
    }
  }

  // The library file content for one root, from current state.
  libFileFor(rootId) {
    const choices = new Map(), sizes = new Map();
    for (const [id, c] of this.choices) {
      const { rootId: rid, path } = splitId(id);
      if (rid !== rootId) continue;
      choices.set(path, c);
      const rec = this.records.get(id);
      if (rec) sizes.set(path, rec.size);
    }
    const albums = [];
    for (const a of this.albums.values()) {
      const items = [...a.items].filter(id => splitId(id).rootId === rootId).map(id => splitId(id).path);
      if (!items.length && a.homeRoot !== rootId) continue;
      const cover = a.cover && splitId(a.cover).rootId === rootId ? splitId(a.cover).path : null;
      albums.push({ id: a.id, name: a.name, created: a.created, cover, items });
    }
    return buildLibFile({ choices, sizes, albums });
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
    && JSON.stringify(x.tags || []) === JSON.stringify(y.tags || []);
}
