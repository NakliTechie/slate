// Depth map for Background blur (src/ops/lensblur.js). Depth Anything V2 Small (Apache-2.0;
// the larger V2 models are not) through Transformers.js, both pinned, in a blob-URL module
// worker. Nothing downloads until the person first opens Background blur. fp16 weights run on
// WebGPU; q8 weights on WebAssembly when WebGPU is missing or fails.
//
//   estimateDepth(canvas, { onProgress }) -> { w, h, data: Uint8Array }
// The map is relative inverse depth (near is high), min-max normalised to 0..255, at about
// DEPTH_EDGE px on the long side. It is cached per canvas, so moving the focus point or the
// Strength slider never runs the model again.

import { TJS_URL } from '../library/clip.js';

export const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
export const DEPTH_REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
export const DEPTH_EDGE = 512;
// Download size per weight type, from the model repository's file list at DEPTH_REVISION.
export const DEPTH_WEIGHTS = {
  fp16: { device: 'webgpu', bytes: 49_642_442 },
  q8: { device: 'wasm', bytes: 27_258_801 },
};
export const depthDtype = () => (typeof navigator !== 'undefined' && navigator.gpu ? 'fp16' : 'q8');
export const depthDownloadMB = (dtype = depthDtype()) => Math.round(DEPTH_WEIGHTS[dtype].bytes / 1e6);

// Min-max normalise one channel of float or byte values to bytes.
export function normaliseDepth(values, channels = 1) {
  const n = Math.floor(values.length / channels);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = values[i * channels]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const out = new Uint8Array(n), k = hi > lo ? 255 / (hi - lo) : 0;
  for (let i = 0; i < n; i++) out[i] = Math.round((values[i * channels] - lo) * k);
  return out;
}

const cache = new WeakMap();

export async function estimateDepth(canvas, { onProgress } = {}) {
  if (cache.has(canvas)) return cache.get(canvas);
  const scale = Math.min(1, DEPTH_EDGE / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
  const small = new OffscreenCanvas(w, h);
  small.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const blob = await small.convertToBlob({ type: 'image/png' });
  const worker = getWorker();
  await worker.init(depthDtype(), onProgress);
  const res = await worker.call({ op: 'depth', blob });
  const map = { w: res.w, h: res.h, data: normaliseDepth(res.data, res.channels) };
  cache.set(canvas, map);
  return map;
}

let worker = null;
function getWorker() {
  if (worker) return worker;
  let w, ready = null, onProgress = null, seq = 0;
  const pending = new Map();
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  const call = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
  w = new Worker(url, { type: 'module' });
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  w.addEventListener('error', (e) => {
    console.error('[slate] depth worker error:', e.message);
    failAll(new Error(e.message || 'the depth model worker failed'));
    w.terminate();
    worker = null;
  });
  w.addEventListener('message', (e) => {
    const d = e.data;
    if (d.type === 'progress') { onProgress?.(d.data); return; }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
  });
  worker = {
    init(dtype, progress) {
      onProgress = progress;
      ready ??= call({ op: 'init', dtype, device: DEPTH_WEIGHTS[dtype].device }).catch((err) => { ready = null; throw err; });
      return ready;
    },
    call,
  };
  return worker;
}

// Loads the pinned Transformers.js and the depth model, then estimates depth for a PNG Blob.
// Replies { id, result: { w, h, channels, data } } at the input's size, or { id, error }.
const WORKER_SRC = `
const URL_TJS = ${JSON.stringify(TJS_URL)};
const MODEL = ${JSON.stringify(DEPTH_MODEL)};
const REVISION = ${JSON.stringify(DEPTH_REVISION)};
let T, pipe;
async function init(dtype, want) {
  T = await import(URL_TJS);
  T.env.allowLocalModels = true;
  T.env.localModelPath = '/models/';
  T.env.allowRemoteModels = true;
  const progress_callback = (p) => self.postMessage({ type: 'progress', data: { status: p.status, file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 } });
  const load = (device, dt) => T.pipeline('depth-estimation', MODEL, { revision: REVISION, device, dtype: dt, progress_callback });
  try { pipe = await load(want, dtype); }
  catch (e) { if (want === 'wasm') throw e; pipe = await load('wasm', 'q8'); }
  return true;
}
self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    let result;
    if (op === 'init') result = await init(e.data.dtype, e.data.device);
    else if (op === 'depth') {
      const img = await T.RawImage.fromBlob(e.data.blob);
      let out = await pipe(img);
      if (Array.isArray(out)) out = out[0];
      const d = out.depth;
      if (d && d.data && d.width) result = { w: d.width, h: d.height, channels: d.channels || 1, data: d.data };
      else {
        const t = out.predicted_depth, dims = t.dims;
        result = { w: dims[dims.length - 1], h: dims[dims.length - 2], channels: 1, data: t.data };
      }
    } else throw new Error('unknown op ' + op);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
`;
