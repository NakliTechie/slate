// Search by meaning (rows Q2, Q3, D4): CLIP image and text embeddings, kept on
// this device. Opt-in: nothing downloads until the person turns on "Search by
// meaning", which stores { on, dtype } in lib.store kv under SETTING_KEY.
//
// The model is Xenova/clip-vit-base-patch32 (OpenAI CLIP ViT-B/32, MIT) through
// Transformers.js (Apache-2.0), both pinned, in a blob-URL module worker: fp16
// weights on WebGPU, q8 weights on WASM. Image vectors come from the stored
// 256 px thumbnails (thumbs.js), never the originals, and run on lib.jobs as
// kind 'clip', so they pause with the queue.
//
// Vectors are unit length, quantised to Int8 with a per-vector inverse norm, and
// stored one packed blob per root in lib.store kv (`clip:vectors:<rootId>`),
// with the id list and the model key in its header. A different model key
// discards the blob. Search is brute-force cosine over every vector with a
// typed-array loop on the main thread (51 million multiply-adds at 100,000
// photos; tests/test-library-clip.mjs prints the time).
//
//   createClip(lib, { embedder?, readThumb? }) -> service (see the return value)
//   VectorSet, packVectors, unpackVectors, topK, quantise   pure, for the tests

import { runOnJobs } from './dupes.js';

export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const MODEL_REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523';
export const TJS_VERSION = '4.3.2';
export const TJS_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/+esm`;
export const DIM = 512;
export const SETTING_KEY = 'clip:setting';
export const VECTORS_PREFIX = 'clip:vectors:';
export const SEARCH_TOP = 200;
export const SEARCH_MIN = 0.2;     // text to image cosine; CLIP ViT-B/32 matches sit near 0.25 to 0.35
export const SIMILAR_TOP = 100;
export const SIMILAR_MIN = 0.5;    // image to image cosine
const TOKENIZER_BYTES = 3_620_000; // tokenizer.json, vocab.json, merges.txt and configs at MODEL_REVISION
// Download size per weight type, from the model repository's file list at MODEL_REVISION.
export const WEIGHTS = {
  fp16: { device: 'webgpu', bytes: 176_080_659 + 127_339_794 + TOKENIZER_BYTES },
  q8: { device: 'wasm', bytes: 89_117_001 + 64_504_507 + TOKENIZER_BYTES },
};
export const modelKey = (dtype) => `${MODEL_ID}@${MODEL_REVISION.slice(0, 7)}:${dtype}`;

const SAVE_DELAY_MS = 15000;
const ENQUEUE_DELAY_MS = 1500;
const MAGIC = 0x56434c53; // 'SLCV' little-endian

// ── pure parts ────────────────────────────────────────────────────────────

// Quantise `vec` into out[offset .. offset + dim) as Int8 scaled so the largest
// component is 127. Returns 1 / |q|, so cosine against the stored Int8 values is
// exact for the quantised vector: cos = inv * dot(query_unit, q).
export function quantise(vec, out, offset = 0) {
  const dim = vec.length;
  let max = 0;
  for (let i = 0; i < dim; i++) { const a = Math.abs(vec[i]); if (a > max) max = a; }
  if (!(max > 0)) { out.fill(0, offset, offset + dim); return 0; }
  const s = 127 / max;
  let sq = 0;
  for (let i = 0; i < dim; i++) { const q = Math.round(vec[i] * s); out[offset + i] = q; sq += q * q; }
  return 1 / Math.sqrt(sq);
}

export function normalise(vec) {
  let sq = 0;
  for (let i = 0; i < vec.length; i++) sq += vec[i] * vec[i];
  const out = new Float32Array(vec.length);
  if (!(sq > 0)) return out;
  const k = 1 / Math.sqrt(sq);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * k;
  return out;
}

// One root's vectors: Int8 rows in one buffer, a Float32 inverse norm per row.
export class VectorSet {
  constructor(dim = DIM, capacity = 64) {
    this.dim = dim;
    this.ids = [];                 // slot -> id, or null for a freed slot
    this.slot = new Map();         // id -> slot
    this.free = [];
    this.data = new Int8Array(dim * capacity);
    this.inv = new Float32Array(capacity);
  }
  get size() { return this.slot.size; }
  has(id) { return this.slot.has(id); }
  set(id, vec) {
    if (vec.length !== this.dim) throw new Error(`a vector has ${vec.length} values, expected ${this.dim}`);
    let s = this.slot.get(id);
    if (s == null) {
      s = this.free.length ? this.free.pop() : this.ids.length;
      if (s >= this.inv.length) this._grow(Math.max(64, this.inv.length * 2));
      this.ids[s] = id;
      this.slot.set(id, s);
    }
    this.inv[s] = quantise(vec, this.data, s * this.dim);
  }
  delete(id) {
    const s = this.slot.get(id);
    if (s == null) return false;
    this.slot.delete(id);
    this.ids[s] = null;
    this.inv[s] = 0;
    this.free.push(s);
    return true;
  }
  // { q: Int8Array view, inv } for one id, or null.
  view(id) {
    const s = this.slot.get(id);
    return s == null ? null : { q: this.data.subarray(s * this.dim, (s + 1) * this.dim), inv: this.inv[s] };
  }
  // The stored vector as unit Float32, for a "find similar" query.
  vector(id) {
    const v = this.view(id);
    if (!v) return null;
    const out = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = v.q[i] * v.inv;
    return out;
  }
  _grow(cap) {
    const d = new Int8Array(this.dim * cap); d.set(this.data); this.data = d;
    const n = new Float32Array(cap); n.set(this.inv); this.inv = n;
  }
}

// Layout: u32 MAGIC, u32 header length, header JSON { v, model, dim, count, ids },
// zero padding to a multiple of 4, Float32 inv[count], Int8 data[count * dim].
export function packVectors(set, model) {
  const ids = [], slots = [];
  set.ids.forEach((id, s) => { if (id != null) { ids.push(id); slots.push(s); } });
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, model, dim: set.dim, count: ids.length, ids }));
  const headEnd = 8 + head.length + ((4 - (head.length % 4)) % 4);
  const out = new Uint8Array(headEnd + ids.length * 4 + ids.length * set.dim);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, head.length, true);
  out.set(head, 8);
  const inv = new Float32Array(out.buffer, headEnd, ids.length);
  const data = new Int8Array(out.buffer, headEnd + ids.length * 4, ids.length * set.dim);
  slots.forEach((s, i) => {
    inv[i] = set.inv[s];
    data.set(set.data.subarray(s * set.dim, (s + 1) * set.dim), i * set.dim);
  });
  return out;
}

// A VectorSet from packed bytes, or null when the bytes are not a vector blob
// or were made by another model (`model` must equal the stored key).
export function unpackVectors(bytes, model) {
  if (!bytes) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const hl = dv.getUint32(4, true);
  let head;
  try { head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl))); } catch { return null; }
  if (head?.v !== 1 || head.model !== model || !Array.isArray(head.ids) || head.ids.length !== head.count) return null;
  const headEnd = 8 + hl + ((4 - (hl % 4)) % 4);
  const n = head.count, dim = head.dim;
  if (u8.length < headEnd + n * 4 + n * dim) return null;
  const copy = u8.slice(headEnd, headEnd + n * 4 + n * dim); // aligned copy
  const set = new VectorSet(dim, Math.max(64, n));
  set.inv.set(new Float32Array(copy.buffer, 0, n));
  set.data.set(new Int8Array(copy.buffer, n * 4, n * dim));
  head.ids.forEach((id, s) => { set.ids[s] = id; set.slot.set(id, s); });
  return set;
}

// Brute-force cosine of `query` (any length-dim Float32Array) against every
// vector in `sets`. Returns up to k { id, score } at or above `min`, best first.
// opts.skip: a Set of ids to leave out; opts.keep(id) -> false leaves one out.
export function topK(sets, query, { k = SEARCH_TOP, min = -1, skip = null, keep = null } = {}) {
  const q = normalise(query);
  const dim = q.length;
  const hits = [];
  for (const set of sets) {
    if (set.dim !== dim) continue;
    const { data, inv, ids } = set;
    const n = ids.length;
    for (let s = 0; s < n; s++) {
      const iv = inv[s];
      if (!iv) continue;
      let dot = 0;
      const o = s * dim;
      for (let j = 0; j < dim; j++) dot += q[j] * data[o + j];
      const score = dot * iv;
      if (score < min) continue;
      const id = ids[s];
      if (id == null || (skip && skip.has(id)) || (keep && !keep(id))) continue;
      hits.push({ id, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return hits.length > k ? hits.slice(0, k) : hits;
}

// ── the browser service ───────────────────────────────────────────────────

const cloneBytes = (b) => (b instanceof Uint8Array ? b : b ? new Uint8Array(b) : null);

export async function pickWeights() {
  try { if (typeof navigator !== 'undefined' && navigator.gpu && await navigator.gpu.requestAdapter()) return 'fp16'; }
  catch { /* no usable adapter */ }
  return 'q8';
}

export function createClip(lib, { embedder = null, readThumb = null } = {}) {
  const sets = new Map();          // rootId -> VectorSet
  const dirty = new Set();         // rootIds to save
  const queued = new Set();        // ids waiting or running
  const listeners = new Set();
  const savedBytes = new Map();    // rootId -> bytes of the last save
  let setting = null;              // { on: true, dtype } when turned on
  let model = null;                // 'idle' | 'loading' | 'ready' | 'error'
  let modelError = '', progress = null, device = null;
  let loaded = false, loading = null;
  let saveTimer = null, saving = Promise.resolve();
  let enqueueTimer = null, pendingIds = null;
  let emb = embedder;

  const key = () => modelKey(setting?.dtype ?? 'q8');
  const emit = () => { for (const fn of listeners) { try { fn(status()); } catch { /* a listener never stops the service */ } } };
  const thumbBlob = readThumb ?? (async (id) => {
    const u = await lib.services.thumbs?.url?.(id);
    return u ? (await fetch(u)).blob() : null;
  });

  function status() {
    let count = 0;
    for (const s of sets.values()) count += s.size;
    return {
      on: !!setting?.on, dtype: setting?.dtype ?? null, device, model, error: modelError, progress,
      count, indexable: indexable().length + count, pending: queued.size, bytes: sizeBytes(),
    };
  }

  function sizeBytes() {
    let b = 0;
    for (const [rid, s] of sets) b += savedBytes.get(rid) ?? s.size * (s.dim + 4);
    return b;
  }

  // Photos the lock hides (lib.visible, locked.js) get no vector and match no search until it opens.
  const vis = (id) => (lib.visible ? lib.visible(id) : true);
  const wanted = (r) => r && !r.missing && r.thumb === 'ok' && vis(r.id);
  function indexable() {
    const out = [];
    for (const r of lib.records.values()) if (wanted(r) && !sets.get(r.rootId)?.has(r.id)) out.push(r);
    return out;
  }

  async function ensureModel() {
    if (model === 'ready') return emb;
    if (!emb) emb = workerEmbedder();
    model = 'loading'; modelError = ''; emit();
    try {
      const files = new Map();
      device = await emb.init(setting.dtype, (p) => {
        if (!p?.file || !(p.total > 0)) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        progress = { loaded, total };
        emit();
      });
      model = 'ready'; progress = null; emit();
      return emb;
    } catch (e) {
      model = 'error'; modelError = e?.message ?? String(e); emit();
      throw e;
    }
  }

  // Read the setting and the stored vectors. Blobs from another model are deleted.
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      setting = (await lib.store.getKv(SETTING_KEY)) ?? null;
      if (!setting?.on) { loaded = true; emit(); return; }
      for (const rid of lib.roots.keys()) {
        if (sets.has(rid)) continue;
        const raw = cloneBytes(await lib.store.getKv(VECTORS_PREFIX + rid));
        const set = unpackVectors(raw, key());
        if (set) { sets.set(rid, set); savedBytes.set(rid, raw.length); }
        else if (raw) await lib.store.deleteKv(VECTORS_PREFIX + rid);
      }
      loaded = true;
      emit();
      index();
    })().finally(() => { loading = null; });
    return loading;
  }

  // Queue every record with a thumbnail and no vector (or only `ids`).
  function index(ids = null) {
    if (!setting?.on) return Promise.resolve();
    const list = (ids ? ids.map(id => lib.get(id)).filter(r => wanted(r) && !sets.get(r.rootId)?.has(r.id)) : indexable())
      .filter(r => !queued.has(r.id));
    if (!list.length) return Promise.resolve();
    for (const r of list) queued.add(r.id);
    emit();
    return runOnJobs(lib.jobs, 'clip', list, embedOne).then(() => { emit(); return flush(); });
  }

  async function embedOne(rec, signal) {
    try {
      if (signal.aborted || !setting?.on) return;
      const e = await ensureModel();
      const blob = await thumbBlob(rec.id);
      if (!blob) throw new Error('no thumbnail');
      if (signal.aborted) return;
      const vec = await e.image(blob);
      if (signal.aborted || !setting?.on) return;
      let set = sets.get(rec.rootId);
      if (!set) { set = new VectorSet(vec.length); sets.set(rec.rootId, set); }
      set.set(rec.id, vec);
      dirty.add(rec.rootId);
      scheduleSave();
    } finally {
      queued.delete(rec.id);
    }
  }

  function scheduleSave() {
    if (!saveTimer && dirty.size) saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DELAY_MS);
  }
  function flush() { clearTimeout(saveTimer); saveTimer = null; return save(); }

  // Write each dirty root's blob, dropping ids whose record is gone.
  function save() {
    saving = saving.then(async () => {
      if (!setting?.on) return;
      for (const rid of [...dirty]) {
        dirty.delete(rid);
        const set = sets.get(rid);
        if (!set) continue;
        for (const id of [...set.slot.keys()]) if (!lib.get(id)) set.delete(id);
        const bytes = packVectors(set, key());
        await lib.store.setKv(VECTORS_PREFIX + rid, bytes);
        savedBytes.set(rid, bytes.length);
      }
      emit();
    }).catch(e => console.warn('[slate library] meaning vectors not saved', e));
    return saving;
  }

  // Library events: new thumbnails get vectors; removed roots lose theirs; a
  // rebuild clears kv, so write the setting and the vectors again.
  lib.on('records', (ev) => {
    if (ev?.reason === 'load') { load(); return; }
    if (!setting?.on || !loaded) return;
    if (ev?.reason === 'rebuild') {
      lib.store.setKv(SETTING_KEY, setting).catch(() => {});
      for (const rid of sets.keys()) dirty.add(rid);
      flush();
      return;
    }
    if (ev?.ids) {
      // Records that are gone (emptied trash, moved files) lose their vectors now.
      for (const id of ev.ids) {
        if (lib.get(id)) continue;
        for (const [rid, set] of sets) if (set.delete(id)) { dirty.add(rid); scheduleSave(); }
      }
      pendingIds ??= new Set();
      for (const id of ev.ids) pendingIds.add(id);
    } else pendingIds = null;
    clearTimeout(enqueueTimer);
    enqueueTimer = setTimeout(() => { const p = pendingIds; pendingIds = null; index(p ? [...p] : null); }, ENQUEUE_DELAY_MS);
  });
  lib.on('choices', (ev) => { if (ev?.reason === 'lock' && setting?.on && loaded) index(); });
  lib.on('roots', () => {
    for (const rid of [...sets.keys()]) {
      if (lib.roots.has(rid)) continue;
      sets.delete(rid); savedBytes.delete(rid); dirty.delete(rid);
      lib.store.deleteKv(VECTORS_PREFIX + rid).catch(() => {});
    }
    if (setting?.on && loaded) load();
  });

  const allSets = () => [...sets.values()];
  const vectorOfId = (id) => { const r = lib.get(id); return r ? sets.get(r.rootId)?.view(id) ?? null : null; };

  return {
    status,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    load,
    index,
    enabled: () => !!setting?.on,
    count: () => status().count,
    has: (id) => !!vectorOfId(id),
    vectorOf: vectorOfId,
    sizeBytes,

    // Turn on with the given weights ('fp16' for WebGPU, 'q8' for WASM) and start indexing.
    async enable(dtype) {
      if (!WEIGHTS[dtype]) throw new Error(`unknown weights: ${dtype}`);
      if (setting?.on && setting.dtype !== dtype) await this.disable();
      setting = { on: true, dtype };
      await lib.store.setKv(SETTING_KEY, setting);
      loaded = false;
      emit();
      await load();
      ensureModel().catch(() => {});
    },

    // Turn off: stop the jobs, drop the model, delete every stored vector and the setting.
    async disable() {
      lib.jobs.cancel('clip');
      queued.clear();
      clearTimeout(saveTimer); saveTimer = null;
      clearTimeout(enqueueTimer); pendingIds = null;
      await saving;
      const rids = new Set([...sets.keys(), ...lib.roots.keys()]);
      setting = null; sets.clear(); dirty.clear(); savedBytes.clear();
      for (const rid of rids) await lib.store.deleteKv(VECTORS_PREFIX + rid);
      await lib.store.deleteKv(SETTING_KEY);
      emb?.dispose?.(); if (!embedder) emb = null;
      model = null; progress = null; modelError = ''; device = null;
      emit();
    },

    // Load the model again after a failure; the stored vectors stay.
    async retry() {
      emb?.dispose?.(); if (!embedder) emb = null;
      model = null;
      await ensureModel();
      index();
    },

    // Text query -> [{ id, score }], best first: top SEARCH_TOP at or above SEARCH_MIN.
    async searchText(text, { k = SEARCH_TOP, min = SEARCH_MIN } = {}) {
      if (!setting?.on) throw new Error('Search by meaning is off');
      const e = await ensureModel();
      const v = await e.text(String(text));
      return topK(allSets(), v, { k, min }).filter(h => vis(h.id));
    },

    // The nearest photos to one photo by image vector, the photo itself left out.
    similar(id, { k = SIMILAR_TOP, min = SIMILAR_MIN } = {}) {
      const r = lib.get(id);
      const v = r && sets.get(r.rootId)?.vector(id);
      if (!v) return [];
      if (!vis(id)) return [];
      return topK(allSets(), v, { k, min, skip: new Set([id]) }).filter(h => vis(h.id));
    },

    // Write pending vectors now.
    flush,
  };
}

// ── the worker ────────────────────────────────────────────────────────────

// The default embedder: one blob-URL module worker holding both CLIP encoders.
function workerEmbedder() {
  let w = null, ready = null, onProgress = null;
  const pending = new Map();
  let seq = 0;
  const call = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  function start() {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    w = new Worker(url, { type: 'module' });
    w.addEventListener('error', (e) => {
      console.error('[slate library] meaning worker error:', e.message);
      failAll(new Error(e.message || 'the meaning model worker failed'));
      ready = null;
    });
    w.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'progress') { onProgress?.(d.data); return; }
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
    });
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  return {
    init(dtype, progress) {
      onProgress = progress;
      if (!w) start();
      ready ??= call({ op: 'init', dtype, device: WEIGHTS[dtype].device });
      return ready;
    },
    image: (blob) => call({ op: 'image', blob }),
    text: (text) => call({ op: 'text', text }),
    dispose() { failAll(new Error('stopped')); w?.terminate(); w = null; ready = null; },
  };
}

// Loads the pinned Transformers.js and both encoders, then embeds thumbnails
// (Blob) or text. Replies { id, result } with a unit Float32Array, or { id, error }.
const WORKER_SRC = `
const URL_TJS = ${JSON.stringify(TJS_URL)};
const MODEL = ${JSON.stringify(MODEL_ID)};
const REVISION = ${JSON.stringify(MODEL_REVISION)};
let T, tok, proc, vision, text, device;
const f32 = (t) => (t.type === 'float32' ? t.data : t.to('float32').data);
function unit(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const k = s > 0 ? 1 / Math.sqrt(s) : 0, out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * k;
  return out;
}
async function init(dtype, want) {
  T = await import(URL_TJS);
  T.env.allowLocalModels = true;
  T.env.localModelPath = '/models/';
  T.env.allowRemoteModels = true;
  const progress_callback = (p) => self.postMessage({ type: 'progress', data: { status: p.status, file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 } });
  const base = { revision: REVISION, progress_callback };
  tok = await T.AutoTokenizer.from_pretrained(MODEL, base);
  proc = await T.AutoProcessor.from_pretrained(MODEL, base);
  const load = (d) => Promise.all([
    T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { ...base, device: d, dtype }),
    T.CLIPTextModelWithProjection.from_pretrained(MODEL, { ...base, device: d, dtype }),
  ]);
  try { [vision, text] = await load(want); device = want; }
  catch (e) { if (want === 'wasm') throw e; [vision, text] = await load('wasm'); device = 'wasm'; }
  return device;
}
self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    let result;
    if (op === 'init') result = await init(e.data.dtype, e.data.device);
    else if (op === 'image') {
      const img = await T.RawImage.fromBlob(e.data.blob);
      const out = await vision(await proc(img));
      result = unit(f32(out.image_embeds));
    } else if (op === 'text') {
      const inp = tok([e.data.text], { padding: true, truncation: true });
      const out = await text(inp);
      result = unit(f32(out.text_embeds));
    } else throw new Error('unknown op ' + op);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
`;
