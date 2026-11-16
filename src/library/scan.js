// Walks a root folder and feeds lib.applyScan. See docs/architecture.md "Scan".
//
//   scanRoot(lib, root, { full }) -> { added, changed, unchanged, missing, failed }
//
// fsa roots are walked through their FileSystemDirectoryHandle; files roots
// (browse-only) use root.files. Metadata and sidecar reads run on lib.jobs as
// kind 'scan', so the status line counts them and pausing the queue pauses the scan.

import { isSkippedDir, kindOf, extOf, makeId, newRecord, unchanged, folderOf, SIDECAR_EXT } from './schema.js';
import { relPathOf } from './library.js';
import { readMetadata } from './metadata.js';
import { sidecarNames, parseXmp } from './xmp.js';

export const BATCH = 500;

export async function scanRoot(lib, root, { full = false } = {}) {
  if (root.handle) await ensurePermission(root.handle);

  // 1. Walk: every photo and video, and every sidecar by folder.
  const found = [];               // [{ path, open: () => Promise<File> }]
  const sidecars = new Map();     // folder -> Map(lower-case name -> open)
  const walk = { failed: 0 };
  const add = (path, open) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (extOf(name) === SIDECAR_EXT) {
      const dir = folderOf(path);
      if (!sidecars.has(dir)) sidecars.set(dir, new Map());
      sidecars.get(dir).set(name.toLowerCase(), open);
    } else if (kindOf(name)) found.push({ path, open });
  };
  if (root.handle) await walkDir(root.handle, '', add, walk);
  else for (const f of root.files || []) {
    const path = relPathOf(f);
    if (folderOf(path).split('/').some(s => s && isSkippedDir(s))) continue;
    add(path, async () => f);
  }

  const seen = new Set(found.map(e => makeId(root.id, e.path)));
  const res = { added: 0, changed: 0, unchanged: 0, missing: 0, failed: walk.failed };

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
    const sideChanged = old && (!!side !== !!old.sidecar || (side && side.lastModified > old.indexed));
    if (!full && old && unchanged(old, file) && !sideChanged) {
      res.unchanged++;
      if (old.thumb == null) thumbless.push(old);
      return;
    }
    const rec = newRecord(root.id, entry.path, file);
    Object.assign(rec, await readMetadata(file, rec));
    if (side) applySidecar(rec, parseXmp(await side.text()));
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
  for (const r of lib.records.values()) if (r.rootId === root.id && r.missing) res.missing++;
  return res;
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

async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if (!handle.queryPermission || await handle.queryPermission(opts) === 'granted') return;
  let state = 'denied';
  try { state = await handle.requestPermission(opts); } catch { /* needs a user gesture */ }
  if (state !== 'granted') {
    const err = new Error(`Slate needs permission to read ${handle.name}. Choose Reconnect to grant it.`);
    err.code = 'permission';
    throw err;
  }
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
    const finish = () => { off(); resolve(); };
    // A cancel drops pending items without running them; stop waiting for those.
    const off = jobs.onProgress(() => {
      if (left > 0 && !inFlight && !jobs.pending.some(j => mine.has(j.item))) finish();
    });
    jobs.add(kind, tagged, async (item, signal) => {
      inFlight++;
      try { await fn(item, signal); }
      finally { inFlight--; if (--left === 0) finish(); }
    });
  });
}
