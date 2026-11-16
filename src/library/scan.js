// Walks a root folder and feeds lib.applyScan. See docs/architecture.md "Scan".
//
//   scanRoot(lib, root, { full }) -> { added, changed, unchanged, missing, failed, takeout }
//
// fsa roots are walked through their FileSystemDirectoryHandle; files roots
// (browse-only) use root.files. Metadata and sidecar reads run on lib.jobs as
// kind 'scan', so the status line counts them and pausing the queue pauses the scan.
//
// Google Takeout JSON (takeout.js) is read beside each photo. It fills the time and GPS only
// where EXIF and XMP had none (timeSource 'takeout'), sets `description`, and adds each named
// person as the tag `people/<name>`. Its favourite, archived and trashed values become choices
// (favourite, hidden, and the reject flag) once: only for a photo new to the index that has no
// entry in the library file, so a later rescan never overrides what the person chose.
// When any photo has Takeout JSON, the result also holds takeout: { matched, favourites, hidden, rejected }.
//
// Import details (spec rows I2, I5): the first time a photo is read with its Takeout JSON, its
// date, place, caption and people go to lib.setMeta, which saves them in the library file
// (libfile.js `meta`). From then on the JSON is not read again: the scanner applies the saved
// `meta` instead, by the same rule (only where EXIF and XMP have none), so a rebuild or full
// rescan restores them without the JSON. iCloud CSV dates (icloud.js) are saved and applied the same way.
//
// Apple Live Photos (row M7): a HEIC or JPEG and a MOV with the same stem in the same folder
// (IMG_1234.HEIC + IMG_1234.MOV) are one photo. The MOV gets no record of its own; the photo
// record carries `liveVideo: '<relative path of the MOV>'`. A MOV with no such photo stays a video.
// A MOV pairs only when it is a Live Photo clip by size and length (review S12): at most
// LIVE_MAX_BYTES, and at most LIVE_MAX_SECONDS long when its `mvhd` header gives a length.
// A longer clip with the same name (birthday.jpg + birthday.mov) stays a video of its own.
//
// Library file (review S1): after the permission step, the root's library file is read again
// when the person was just asked for permission, or when it has not been read this session,
// so the scan and every save that follows work on the person's choices, never an empty set.
//
// Trash (reviews S2, S3): every scan of a folder handle also lists `.slate-trash/` and hands
// its photos and videos to lib.recoverTrash, which re-creates a trashed record for any file
// there that has none.

import { isSkippedDir, kindOf, extOf, makeId, newRecord, unchanged, folderOf, SIDECAR_EXT, TRASH_DIR } from './schema.js';
import { relPathOf } from './library.js';
import { readMetadata } from './metadata.js';
import { sidecarNames, parseXmp } from './xmp.js';
import { matchSidecars, readTakeoutJson } from './takeout.js';
import { metaTaken, metaTime } from './libfile.js';

export const BATCH = 500;
export const LIVE_MAX_BYTES = 10 * 1024 * 1024;
// Live Photo clips run about 3 s; the 0.25 s margin covers clips a few frames over.
export const LIVE_MAX_SECONDS = 3;
const LIVE_SLACK_SECONDS = 0.25;

export async function scanRoot(lib, root, { full = false } = {}) {
  if (root.handle) {
    const asked = await ensurePermission(root.handle);
    if ((asked || !lib.libLoaded?.has(root.id)) && lib.loadLibFile) await lib.loadLibFile(root);
  }

  // 1. Walk: every photo and video, and every sidecar by folder.
  const found = [];               // [{ path, open: () => Promise<File> }]
  const sidecars = new Map();     // folder -> Map(lower-case name -> open)
  const jsons = new Map();        // folder -> Map(name -> open), Takeout candidates
  const walk = { failed: 0 };
  const add = (path, open) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const ext = extOf(name);
    if (ext === SIDECAR_EXT || (ext === 'json' && !name.startsWith('.'))) {
      const dir = folderOf(path), into = ext === 'json' ? jsons : sidecars;
      if (!into.has(dir)) into.set(dir, new Map());
      into.get(dir).set(ext === 'json' ? name : name.toLowerCase(), open);
    } else if (kindOf(name)) found.push({ path, open });
  };
  if (root.handle) await walkDir(root.handle, '', add, walk);
  else for (const f of root.files || []) {
    const path = relPathOf(f);
    if (folderOf(path).split('/').some(s => s && isSkippedDir(s))) continue;
    add(path, async () => f);
  }

  const { live, movs } = await checkLivePairs(lib, root, pairLivePhotos(found.map(e => e.path)), new Map(found.map(e => [e.path, e.open])));
  if (movs.size) found.splice(0, found.length, ...found.filter(e => !movs.has(e.path)));

  const seen = new Set(found.map(e => makeId(root.id, e.path)));
  const takeout = { matched: 0, favourites: 0, hidden: 0, rejected: 0 };
  const res = { added: 0, changed: 0, unchanged: 0, missing: 0, failed: walk.failed };
  const takeoutFor = matchTakeout(found, jsons); // media path -> open
  if (takeoutFor.size) res.takeout = takeout;
  const fromTakeout = { fav: [], hidden: [], reject: [] };

  // 2. Read each new or changed file on the job queue, flushing every BATCH records.
  let buf = [], thumbless = [], chain = Promise.resolve();
  const flush = (opts = {}) => {
    const upserts = buf; buf = [];
    const forThumbs = [...upserts, ...thumbless]; thumbless = [];
    chain = chain.then(async () => {
      await lib.applyScan(root.id, { upserts, ...opts });
      if (forThumbs.length) lib.services.thumbs?.enqueue(forThumbs);
    });
    return chain;
  };

  const sidecarFor = (path) => {
    const dir = sidecars.get(folderOf(path));
    if (!dir) return null;
    for (const n of sidecarNames(path.slice(path.lastIndexOf('/') + 1))) {
      const open = dir.get(n.toLowerCase());
      if (open) return open;
    }
    return null;
  };

  const work = async (entry) => {
    const id = makeId(root.id, entry.path);
    const file = await entry.open();
    const old = lib.get(id);
    const sideOpen = sidecarFor(entry.path);
    const side = sideOpen ? await sideOpen() : null;
    const meta = lib.meta?.get(id) ?? null;
    const tjOpen = takeoutFor.get(entry.path);
    const tj = tjOpen ? await tjOpen() : null;
    const liveVideo = live.get(entry.path) ?? null;
    const sideChanged = old && ((old.liveVideo ?? null) !== liveVideo || !!side !== !!old.sidecar || (side && side.lastModified > old.indexed)
      || !!tj !== !!old.takeout || (tj && !meta && tj.lastModified > old.indexed));
    if (!full && old && unchanged(old, file) && !sideChanged) {
      res.unchanged++;
      if (old.thumb == null) thumbless.push(old);
      return;
    }
    const rec = newRecord(root.id, entry.path, file);
    Object.assign(rec, await readMetadata(file, rec));
    if (liveVideo) rec.liveVideo = liveVideo;
    if (side) applySidecar(rec, parseXmp(await side.text()));
    if (meta) {
      applyMeta(rec, meta);
      if (tj) { rec.takeout = true; takeout.matched++; }
    } else if (tj) {
      const t = readTakeoutJson(await tj.text());
      applyTakeout(rec, t);
      const m = takeoutMeta(t);
      if (m) lib.setMeta?.(id, m);
      takeout.matched++;
      if (t && !old && !lib.choices.has(id)) {
        if (t.favorited) fromTakeout.fav.push(id);
        if (t.archived) fromTakeout.hidden.push(id);
        if (t.trashed) fromTakeout.reject.push(id);
      }
    }
    if (old) res.changed++; else res.added++;
    buf.push(rec);
    if (buf.length >= BATCH) await flush();
  };

  await runJobs(lib.jobs, 'scan', found, async (entry) => {
    try { await work(entry); }
    catch (e) { res.failed++; throw e; }
  });

  // 3. Final call with `seen`, unless part of the folder could not be read.
  await flush(walk.failed ? {} : { seen });
  await applyTakeoutChoices(lib, fromTakeout, takeout);
  if (root.handle && lib.recoverTrash) await recoverTrash(lib, root, walk.failed ? null : seen);
  for (const r of lib.records.values()) if (r.rootId === root.id && r.missing) res.missing++;
  return res;
}

// Live Photo pairs (row M7) among relative paths: photo path -> MOV path, and the set of paired MOVs.
const LIVE_STILLS = ['heic', 'heif', 'jpg', 'jpeg'];
export function pairLivePhotos(paths) {
  const stills = new Map(); // folder/stem (lower case) -> photo path, preferring HEIC over JPEG
  const stemKey = (p) => { const n = p.slice(p.lastIndexOf('/') + 1); const i = n.lastIndexOf('.'); return `${folderOf(p)}/${(i < 0 ? n : n.slice(0, i)).toLowerCase()}`; };
  for (const p of paths) {
    const rank = LIVE_STILLS.indexOf(extOf(p));
    if (rank < 0) continue;
    const k = stemKey(p), had = stills.get(k);
    if (!had || rank < LIVE_STILLS.indexOf(extOf(had))) stills.set(k, p);
  }
  const live = new Map(), movs = new Set();
  for (const p of paths) {
    if (extOf(p) !== 'mov') continue;
    const still = stills.get(stemKey(p));
    if (still && !live.has(still)) { live.set(still, p); movs.add(p); }
  }
  return { live, movs };
}

// Keep only the candidate pairs whose MOV is a Live Photo clip (see the header). A pair the
// index already holds for an unchanged still is kept without reading the MOV again.
async function checkLivePairs(lib, root, cand, openOf) {
  const live = new Map(), movs = new Set();
  for (const [still, mov] of cand.live) {
    const old = lib.get(makeId(root.id, still));
    let ok = old?.liveVideo === mov;
    if (!ok) {
      try {
        const f = await openOf.get(mov)();
        const dur = f.size <= LIVE_MAX_BYTES ? await movDuration(f) : null;
        ok = f.size <= LIVE_MAX_BYTES && (dur == null || dur <= LIVE_MAX_SECONDS + LIVE_SLACK_SECONDS);
      } catch { ok = false; }
    }
    if (ok) { live.set(still, mov); movs.add(mov); }
  }
  return { live, movs };
}

// Length in seconds of a QuickTime or MP4 file from its moov/mvhd header, or null.
// Reads only box headers and the mvhd body.
export async function movDuration(file) {
  if (typeof file?.slice !== 'function') return null;
  const read = async (at, len) => new Uint8Array(await file.slice(at, Math.min(file.size, at + len)).arrayBuffer());
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const boxes = async (start, end) => {
    const out = [];
    for (let at = start, n = 0; at + 8 <= end && n < 512; n++) {
      const h = await read(at, 16);
      if (h.length < 8) break;
      let size = u32(h, 0), head = 8;
      if (size === 1) { if (h.length < 16) break; size = u32(h, 8) * 4294967296 + u32(h, 12); head = 16; }
      else if (size === 0) size = end - at;
      if (size < head || at + size > end) break;
      out.push({ type: String.fromCharCode(h[4], h[5], h[6], h[7]), start: at + head, end: at + size });
      at += size;
    }
    return out;
  };
  try {
    const moov = (await boxes(0, file.size)).find(b => b.type === 'moov');
    const mvhd = moov && (await boxes(moov.start, moov.end)).find(b => b.type === 'mvhd');
    if (!mvhd) return null;
    const b = await read(mvhd.start, 32);
    const v1 = b[0] === 1;
    const scale = u32(b, v1 ? 20 : 12);
    const dur = v1 ? u32(b, 24) * 4294967296 + u32(b, 28) : u32(b, 16);
    return scale ? dur / scale : null;
  } catch { return null; }
}

// List .slate-trash and hand its files to lib.recoverTrash (see the header).
async function recoverTrash(lib, root, seen) {
  let dir;
  try { dir = await root.handle.getDirectoryHandle(TRASH_DIR); }
  catch (e) { if (e?.name !== 'NotFoundError') return; dir = null; }
  const files = [], walk = { failed: 0 };
  if (dir) await walkDir(dir, TRASH_DIR, (path, open) => { if (kindOf(path.slice(path.lastIndexOf('/') + 1))) files.push({ path, open }); }, walk);
  if (walk.failed) return;
  const { live, movs } = pairLivePhotos(files.map(f => f.path));
  const entries = [];
  for (const f of files) {
    if (movs.has(f.path)) continue;
    try { entries.push({ path: f.path, file: await f.open(), liveVideo: live.get(f.path) ?? null }); }
    catch { return; }
  }
  await lib.recoverTrash(root.id, entries, { seen });
}

// The sidecar wins over embedded metadata for tags, rating, time and GPS.
export function applySidecar(rec, x) {
  rec.sidecar = true;
  if (!x) return rec;
  if (x.tags?.length) rec.xmpTags = [...x.tags];
  if (x.rating) rec.xmpRating = x.rating;
  if (x.time != null) { rec.time = x.time; rec.timeSource = 'xmp'; }
  if (x.lat != null && x.lon != null) { rec.lat = x.lat; rec.lon = x.lon; }
  return rec;
}

// Takeout fills in only what EXIF and XMP left empty; see the header.
export function applyTakeout(rec, t) {
  rec.takeout = true;
  const m = takeoutMeta(t);
  return m ? applyMeta(rec, m) : rec;
}

// The library-file `meta` for what a Takeout JSON says (null when it says nothing to keep).
export function takeoutMeta(t) {
  if (!t) return null;
  const m = {};
  if (t.time != null) m.taken = metaTaken(t.time);
  if (t.lat != null && t.lon != null) { m.lat = t.lat; m.lon = t.lon; }
  if (t.description) m.caption = t.description;
  if (t.people?.length) m.people = [...t.people];
  return Object.keys(m).length ? { ...m, source: 'takeout' } : null;
}

// Saved import details (libfile.js `meta`) fill in only what EXIF and XMP left empty.
export function applyMeta(rec, m) {
  const time = m.taken != null ? metaTime(m.taken) : null;
  if (time != null && rec.timeSource === 'file') { rec.time = time; rec.timeSource = m.source; }
  if (rec.lat == null && m.lat != null && m.lon != null) { rec.lat = m.lat; rec.lon = m.lon; }
  if (m.caption) rec.description = m.caption;
  if (m.people?.length) {
    const tags = m.people.map(p => `people/${p.replace(/\//g, '-')}`);
    rec.xmpTags = [...new Set([...(rec.xmpTags || []), ...tags])];
  }
  return rec;
}

// Media path -> open() of its Takeout JSON, folder by folder.
function matchTakeout(found, jsons) {
  const out = new Map();
  if (!jsons.size) return out;
  const byDir = new Map();
  for (const e of found) {
    const dir = folderOf(e.path);
    if (!jsons.has(dir)) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(e.path.slice(e.path.lastIndexOf('/') + 1));
  }
  for (const [dir, media] of byDir) {
    const js = jsons.get(dir);
    for (const [m, j] of matchSidecars([...media, ...js.keys()])) out.set(dir ? `${dir}/${m}` : m, js.get(j));
  }
  return out;
}

async function applyTakeoutChoices(lib, ids, counts) {
  const ok = list => list.filter(id => lib.records.has(id) && !lib.choices.has(id));
  const fav = ok(ids.fav), hidden = ok(ids.hidden), reject = ok(ids.reject);
  try {
    if (fav.length) counts.favourites = (await lib.setFavourite(fav, true)).changed;
    if (hidden.length) counts.hidden = (await lib.setHidden(hidden, true)).changed;
    if (reject.length) counts.rejected = (await lib.setFlag(reject, 'reject')).changed;
  } catch (e) { console.warn('[slate library] could not apply Takeout choices', e); }
}

// Returns true when it had to ask (so the library file must be read again).
async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if (!handle.queryPermission || await handle.queryPermission(opts) === 'granted') return false;
  let state = 'denied';
  try { state = await handle.requestPermission(opts); } catch { /* needs a user gesture */ }
  if (state !== 'granted') {
    const err = new Error(`Slate needs permission to read ${handle.name}. Choose Reconnect to grant it.`);
    err.code = 'permission';
    throw err;
  }
  return true;
}

async function walkDir(dir, prefix, add, walk) {
  try {
    for await (const [name, h] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') { if (!isSkippedDir(name)) await walkDir(h, path, add, walk); }
      else add(path, () => h.getFile());
    }
  } catch (e) {
    console.warn('[slate library] could not read folder', prefix || dir.name, e);
    walk.failed++;
  }
}

// Run fn over items on the shared queue and resolve when this batch is finished,
// without waiting for other kinds of work (thumbnails) on the same queue.
function runJobs(jobs, kind, items, fn) {
  if (!items.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = items.length, inFlight = 0;
    const tagged = items.map(item => ({ ...item, id: item.path }));
    const mine = new Set(tagged);
    let finished = false, cancelled = false;
    const finish = () => { if (finished) return; finished = true; off(); resolve(); };
    // A cancel drops pending items without running them; stop waiting for those. Only after a
    // cancel: a job the queue has started but whose function has not run yet is neither pending
    // nor in flight, so without the cancel test the scan ended before its last files were read.
    const off = jobs.onProgress(() => {
      if (cancelled && left > 0 && !inFlight && !jobs.pending.some(j => mine.has(j.item))) finish();
    });
    jobs.add(kind, tagged, async (item, signal) => {
      if (signal?.aborted) cancelled = true;
      inFlight++;
      try { await fn(item, signal); }
      finally { inFlight--; if (--left === 0) finish(); }
    });
    const ctl = jobs.controllers?.get(kind);
    ctl?.signal?.addEventListener?.('abort', () => { cancelled = true; jobs._emit?.(kind); });
  });
}
