// Thumbnails: 256 px (long edge) WebP files in OPFS under slate-thumbs/.
// See docs/architecture.md "Thumbnails".
//
//   createThumbs(lib) -> { enqueue(records), url(id), dataUrl(id), remove(ids), clear(), sizeBytes(), rehash(records) }
//
// Order of sources for a photo: the embedded EXIF thumbnail (JPEG, TIFF, RAW),
// then createImageBitmap in a worker for formats the browser opens natively,
// then Slate's decoder registry on the main thread with the bitmap transferred
// to the worker (as batch.js does). Videos: seek to 10% and draw a frame.
// The worker scales, encodes and writes the file into OPFS. All work runs on
// lib.jobs as kind 'thumbs', so it pauses with the queue and is counted.
//
// The worker also takes a 64-bit dHash (dupes.js) of the picture it drew and
// the record gets it as `dhash`. rehash(records) fills `dhash` for records
// thumbnailed before that, from the stored thumbnail (kind 'dupes').

import { thumbnail } from '../vendor/exifr.mjs';
import { decode, isSupportedFile } from '../decode/registry.js';
import { dhashRGBA, runOnJobs } from './dupes.js';

export const THUMB_DIR = 'slate-thumbs';
export const EDGE = 256;
export const URL_CACHE_MAX = 600;
const WORKERS = 2;
const PATCH_DELAY_MS = 250;
const VIDEO_TIMEOUT_MS = 20000;

const EMBEDDED_EXTS = new Set(['jpg', 'jpeg', 'tif', 'tiff', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2']);
const WORKER_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'heic', 'heif']);

// File name for a record id: a 64-bit cyrb53 hash, so ids with any characters map to a safe name.
export function thumbName(id) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + '.webp';
}

// Bounded object-URL cache, least recently used first out; evicted URLs are revoked.
export function createUrlCache(max = URL_CACHE_MAX, revoke = u => URL.revokeObjectURL(u)) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (v !== undefined) { m.delete(k); m.set(k, v); }
      return v;
    },
    set(k, v) {
      if (m.has(k)) { const old = m.get(k); m.delete(k); if (old !== v) revoke(old); }
      m.set(k, v);
      while (m.size > max) { const [ok, ov] = m.entries().next().value; m.delete(ok); revoke(ov); }
    },
    delete(k) { if (m.has(k)) { revoke(m.get(k)); m.delete(k); } },
    clear() { for (const v of m.values()) revoke(v); m.clear(); },
    get size() { return m.size; },
  };
}

// Output size for a source of sw x sh drawn with EXIF orientation `orient`, long edge at most `edge`.
export function fitSize(sw, sh, orient = 1, edge = EDGE) {
  const [w, h] = orient >= 5 ? [sh, sw] : [sw, sh];
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

export function bytesToDataUrl(bytes) {
  const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : 'image/webp';
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

export function createThumbs(lib) {
  const cache = createUrlCache();
  const loading = new Map();   // id -> Promise<url|null>
  const queued = new Set();    // ids waiting or running
  let patches = [], patchTimer = null;
  let pool = null, next = 0;

  const thumbDir = async (create = false) => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(THUMB_DIR, { create });
  };
  const readThumb = async (id) => {
    try { return await (await (await thumbDir()).getFileHandle(thumbName(id))).getFile(); }
    catch { return null; }
  };

  const flush = () => {
    clearTimeout(patchTimer); patchTimer = null;
    const list = patches; patches = [];
    if (!list.length) return Promise.resolve();
    return lib.patchRecords(list, 'thumb').catch(e => console.warn('[slate library] thumbnail state not saved', e));
  };
  const patch = (p) => {
    patches.push(p);
    if (!patchTimer) patchTimer = setTimeout(flush, PATCH_DELAY_MS);
  };

  // Records left 'pending' by a session that ended during a main-thread decode.
  const failStale = () => {
    const stale = [];
    for (const r of lib.records?.values?.() ?? []) if (r.thumb === 'pending' && !queued.has(r.id)) stale.push({ id: r.id, thumb: 'fail' });
    if (stale.length) lib.patchRecords(stale, 'thumb').catch(e => console.warn('[slate library] thumbnail state not saved', e));
  };
  lib.on?.('records', (ev) => { if (ev?.reason === 'load') failStale(); });
  if (lib.loaded) failStale();

  const toWorker = (msg, transfer = []) => {
    if (!pool) pool = makePool(WORKERS);
    const w = pool[next++ % pool.length];
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      w._pending.set(id, { resolve, reject });
      w.postMessage({ id, edge: EDGE, ...msg }, transfer);
    });
  };

  async function render(rec, file) {
    const name = thumbName(rec.id);
    if (rec.kind === 'video') {
      const v = await videoFrame(file);
      const r = await toWorker({ name, src: v.bitmap }, [v.bitmap]);
      return { w: v.w, h: v.h, dur: v.dur, dhash: r?.dhash };
    }
    // The embedded thumbnail says nothing about the photo's size, so use it only when EXIF gave w and h.
    if (EMBEDDED_EXTS.has(rec.ext) && rec.w && rec.h) {
      const t = await thumbnail(file).catch(() => null);
      if (t) {
        try { return await toWorker({ name, src: new Blob([t], { type: 'image/jpeg' }), orient: rec.orient || 1 }); }
        catch { /* a broken embedded thumbnail: decode the photo instead */ }
      }
    }
    if (WORKER_EXTS.has(rec.ext)) {
      try { return await toWorker({ name, src: file, w: rec.w, h: rec.h }); }
      catch { /* not decodable in a worker here (HEIC off Safari, for one): try the registry */ }
    }
    if (!isSupportedFile(file)) return null;
    // A main-thread decode that kills the tab must not run again on every visit (S16): the
    // record is saved as 'pending' first, and a 'pending' found when the library loads becomes 'fail'.
    await lib.patchRecords([{ id: rec.id, thumb: 'pending' }], 'thumb');
    const bmp = await decode(file);
    return toWorker({ name, src: bmp }, [bmp]);
  }

  async function make(item, signal) {
    const rec = lib.get(item.id) ?? item;
    try {
      if (rec.missing) return;
      const file = await lib.getFile(rec.id);
      const r = await render(rec, file);
      if (signal.aborted) return;
      const p = { id: rec.id, thumb: r ? 'ok' : 'none' };
      if (r && (!rec.w || !rec.h) && r.w && r.h) { p.w = r.w; p.h = r.h; }
      if (r?.dur) p.dur = r.dur;
      if (r?.dhash) p.dhash = r.dhash;
      cache.delete(rec.id); // the next url() reads the new file
      patch(p);
    } catch (e) {
      if (!signal.aborted) patch({ id: rec.id, thumb: 'fail' });
      throw e;
    } finally {
      queued.delete(rec.id);
    }
  }

  return {
    enqueue(records) {
      const list = records.filter(r => r && !queued.has(r.id));
      if (!list.length) return;
      for (const r of list) queued.add(r.id);
      lib.jobs.add('thumbs', list, make);
    },

    url(id) {
      const hit = cache.get(id);
      if (hit) return Promise.resolve(hit);
      if (loading.has(id)) return loading.get(id);
      const p = (async () => {
        const rec = lib.get(id);
        if (rec && rec.thumb !== 'ok') return null;
        const f = await readThumb(id);
        if (!f) return null;
        const u = URL.createObjectURL(f);
        cache.set(id, u);
        return u;
      })().finally(() => loading.delete(id));
      loading.set(id, p);
      return p;
    },

    async dataUrl(id) {
      const f = await readThumb(id);
      return f ? bytesToDataUrl(new Uint8Array(await f.arrayBuffer())) : null;
    },

    async remove(ids) {
      let dir;
      try { dir = await thumbDir(); } catch { dir = null; }
      for (const id of ids) {
        cache.delete(id);
        if (dir) await dir.removeEntry(thumbName(id)).catch(() => {});
      }
    },

    async clear() {
      lib.jobs.cancel('thumbs');
      queued.clear();
      cache.clear();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(THUMB_DIR, { recursive: true }).catch(() => {});
    },

    // dHash for records that have a thumbnail but no hash, read from OPFS
    // (the original is not decoded again). Resolves when all are done.
    async rehash(records) {
      const list = records.filter(r => r && r.thumb === 'ok' && !r.dhash);
      await runOnJobs(lib.jobs, 'dupes', list, async (rec, signal) => {
        const f = await readThumb(rec.id);
        if (!f || signal.aborted) return;
        const r = await toWorker({ op: 'hash', src: f });
        if (r?.dhash && !signal.aborted) patch({ id: rec.id, dhash: r.dhash });
      });
      await flush();
    },

    async sizeBytes() {
      let total = 0;
      try {
        for await (const h of (await thumbDir()).values()) if (h.kind === 'file') total += (await h.getFile()).size;
      } catch { /* no thumbnails yet */ }
      return total;
    },
  };
}

// A frame at about 10% of the video, as an ImageBitmap, with the video's size and duration.
function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const end = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => end(new Error('the video did not load in time')), VIDEO_TIMEOUT_MS);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onerror = () => end(new Error('this browser cannot play the video'));
    v.onloadedmetadata = () => {
      const d = v.duration;
      v.currentTime = Number.isFinite(d) && d > 0 ? d * 0.1 : 0.1;
    };
    v.onseeked = async () => {
      try {
        if (!v.videoWidth || !v.videoHeight) throw new Error('the video has no picture');
        const bitmap = await createImageBitmap(v);
        end(null, { bitmap, w: v.videoWidth, h: v.videoHeight, dur: Number.isFinite(v.duration) ? v.duration : 0 });
      } catch (e) { end(e); }
    };
    v.src = url;
  });
}

function makePool(size) {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
  const pool = Array.from({ length: size }, () => {
    const w = new Worker(url);
    w._pending = new Map();
    w.addEventListener('message', (e) => {
      const { id, error, ...res } = e.data;
      const p = w._pending.get(id);
      if (!p) return;
      w._pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(res);
    });
    w.addEventListener('error', (e) => {
      console.error('[slate library] thumbnail worker error:', e.message);
      for (const p of w._pending.values()) p.reject(new Error(e.message || 'thumbnail worker failed'));
      w._pending.clear();
    });
    return w;
  });
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return pool;
}

// Worker: decode (or take a transferred bitmap), apply EXIF orientation when asked,
// scale to the long edge, encode WebP and write it into OPFS slate-thumbs/<name>.
// Replies { id, w, h, dhash } with the oriented size of what it decoded, or { id, error }.
// With op 'hash' it only draws the picture and replies { id, dhash }.
const WORKER_SRC = `
const DIR = ${JSON.stringify(THUMB_DIR)};
${dhashRGBA.toString()}
function hashOf(ctx, W, H) { return dhashRGBA(ctx.getImageData(0, 0, W, H).data, W, H); }
function orient(ctx, o, W, H) {
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, W, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, W, H); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, H); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, W, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, W, H); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, H); break;
  }
}
async function write(name, blob) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(DIR, { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  if (fh.createWritable) {
    const ws = await fh.createWritable();
    await ws.write(blob); await ws.close();
    return;
  }
  const ah = await fh.createSyncAccessHandle();
  try { ah.truncate(0); ah.write(new Uint8Array(await blob.arrayBuffer()), { at: 0 }); ah.flush(); }
  finally { ah.close(); }
}
self.onmessage = async (e) => {
  const { id, op, name, src, orient: o = 1, w = 0, h = 0, edge } = e.data;
  let bmp = null;
  try {
    if (op === 'hash') {
      bmp = await createImageBitmap(src);
      const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
      c.drawImage(bmp, 0, 0);
      self.postMessage({ id, dhash: hashOf(c, bmp.width, bmp.height) });
      return;
    }
    if (src instanceof ImageBitmap) bmp = src;
    else if (o !== 1) bmp = await createImageBitmap(src, { imageOrientation: 'none' });
    else if (w && h) bmp = await createImageBitmap(src, w >= h ? { resizeWidth: Math.min(edge, w), resizeQuality: 'medium' } : { resizeHeight: Math.min(edge, h), resizeQuality: 'medium' });
    else bmp = await createImageBitmap(src);
    const sw = bmp.width, sh = bmp.height;
    const ow = o >= 5 ? sh : sw, oh = o >= 5 ? sw : sh;
    const s = Math.min(1, edge / Math.max(ow, oh));
    const W = Math.max(1, Math.round(ow * s)), H = Math.max(1, Math.round(oh * s));
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    orient(ctx, o, W, H);
    ctx.drawImage(bmp, 0, 0, o >= 5 ? H : W, o >= 5 ? W : H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dhash = hashOf(ctx, W, H);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    await write(name, blob);
    self.postMessage({ id, w: ow, h: oh, dhash });
  } catch (err) {
    self.postMessage({ id, error: err && err.message || String(err) });
  } finally {
    if (bmp && bmp.close) bmp.close();
  }
};
`;
