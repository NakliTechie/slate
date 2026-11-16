// Faces (spec rows F1 to F3): find faces in photos, group them into people,
// and let the person name, merge, hide and correct those groups.
//
// Off by default. Nothing runs, and nothing downloads, until the person turns
// it on from the People view, which first says what happens (OPT_IN_TEXT).
// While on:
//   - Models download once into Cache Storage 'slate-faces-models' (MODELS has
//     the URLs, sizes and licences), run with ONNX Runtime Web on WebAssembly
//     in a worker.
//   - Each photo (videos are skipped) is decoded at most 640 px on the long
//     edge, YuNet finds faces and five landmarks, each face is aligned to
//     112 x 112 with a similarity transform, and SFace turns it into a
//     128-number vector. Work runs on lib.jobs as kind 'faces'.
//   - Faces and people live only in this browser, in IndexedDB 'slate.faces'.
//     Nothing goes into the photo files unless "Write XMP sidecars" is on, and
//     then only the rectangles and names of named people (MWG regions, xmp.js).
//   - deleteAll() removes the database, the downloaded models and the setting. It returns
//     { blocked: true } when another tab holds the database open, so the delete waits.
//   - A photo's faces are deleted when the photo leaves the library: Empty trash, Remove
//     folder, a move, or a full scan that finds the file missing ('records' events).
//   - Photos the lock hides (lib.visible, locked.js) are not scanned, and their faces and
//     photos stay out of every list until the lock opens.
//
// Grouping follows Immich's incremental DBSCAN: a face with at least MIN_FACES
// faces (itself included) within MAX_DISTANCE (cosine distance) is a core
// face; it joins the person of its nearest grouped neighbour, or starts a new
// person. Faces with fewer neighbours join the nearest grouped neighbour's
// person when one is in range, and otherwise stay ungrouped. A face marked "not
// this person" never rejoins that person and never starts a new one. The model id is
// stored with every vector; vectors from another model are dropped and redone.
//
// initFaces(lib) -> api (also lib.services.faces):
//   ready, enabled(), setEnabled(on), pause(), resume(), paused(), status(),
//   deleteAll(), people({ hidden }), person(pid), facesOf(pid), photosOf(pid),
//   facesIn(photoId), name(pid, name), merge(intoPid, fromPid), hide(pid, on),
//   notThisPerson(faceId), setCover(pid, faceId), coverFace(pid),
//   regionsFor(photoId), on(fn)
//
// Pure parts, exported for tests and copied into the worker by toString():
//   decodeYunet, nms, similarityTransform, warpAffine, l2normalise, cosineDistance,
//   clusterFaces (with the people state helpers mergePeople, markNotPerson).

import { parseRegions, sidecarNames } from './xmp.js';

export const SETTING_KEY = 'setting:faces';
export const DB_NAME = 'slate.faces';
export const MODEL_CACHE = 'slate-faces-models';
export const ORT_VERSION = '1.29.0';
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const MODELS = {
  detector: {
    id: 'yunet-2023mar', licence: 'MIT', bytes: 232589,
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx',
  },
  recogniser: {
    id: 'sface-2021dec-int8', licence: 'Apache-2.0', bytes: 9896933,
    url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec_int8.onnx',
  },
  runtime: { id: `onnxruntime-web@${ORT_VERSION}`, licence: 'MIT', bytes: 14036063, url: `${ORT_BASE}ort.wasm.min.mjs` },
};
export const MODEL_ID = `${MODELS.detector.id}+${MODELS.recogniser.id}`;
export const DOWNLOAD_MB = Math.round((MODELS.detector.bytes + MODELS.recogniser.bytes + MODELS.runtime.bytes) / 1e6);

export const OPT_IN_TEXT = [
  `Slate downloads three files once: the YuNet face finder (0.2 MB, MIT licence), the SFace face recogniser (9.9 MB, Apache-2.0) and ONNX Runtime Web (14 MB, MIT), about ${DOWNLOAD_MB} MB in all, from Hugging Face and jsDelivr.`,
  'Slate then finds faces in your photos and groups them into people on this device. No photo and no face leaves it.',
  'Face data stays in this browser. Names go into your photo files only if you turn on "Write XMP sidecars".',
  'You can turn faces off and remove every face, person and name with "Delete all face data".',
];

export const DETECT_SIZE = 640;
export const MIN_SCORE = 0.7;          // Immich's default minimum detection score
// Faces under 32 px (at 640 px) are skipped: on OpenCV's crowd selfie, pairs of
// different people under 24 px reached cosine similarity 0.59, while every pair
// at 32 px or more stayed at 0.41 or below.
export const MIN_FACE_PX = 32;
export const NMS_IOU = 0.3;
export const MAX_DISTANCE = 0.5;       // cosine distance; SFace's own same-person cut is 0.637
export const MIN_FACES = 3;
// ArcFace's five-point template for a 112 x 112 crop (OpenCV FaceRecognizerSF uses it).
export const TEMPLATE = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041];

// ── pure parts ──────────────────────────────────────────────────────────────

// YuNet 2023mar output (a fixed 640 x 640 input) to faces in input pixels.
// out: { cls_8, obj_8, bbox_8, kps_8, ... } Float32Arrays. Returns
// [{ box: [x, y, w, h], landmarks: [x0, y0, ... x4, y4], score }].
export function decodeYunet(out, size, minScore) {
  const faces = [];
  for (const s of [8, 16, 32]) {
    const cols = size / s, rows = size / s;
    const cls = out['cls_' + s], obj = out['obj_' + s], bb = out['bbox_' + s], kp = out['kps_' + s];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < minScore) continue;
      const cx = (c + bb[i * 4]) * s, cy = (r + bb[i * 4 + 1]) * s;
      const w = Math.exp(bb[i * 4 + 2]) * s, h = Math.exp(bb[i * 4 + 3]) * s;
      const landmarks = [];
      for (let k = 0; k < 5; k++) landmarks.push((kp[i * 10 + 2 * k] + c) * s, (kp[i * 10 + 2 * k + 1] + r) * s);
      faces.push({ box: [cx - w / 2, cy - h / 2, w, h], landmarks, score });
    }
  }
  return faces;
}

// Greedy non-maximum suppression on [x, y, w, h] boxes, best score first.
export function nms(faces, iouMax) {
  const iou = (a, b) => {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
  };
  const keep = [];
  for (const f of [...faces].sort((a, b) => b.score - a.score)) if (keep.every(k => iou(k.box, f.box) <= iouMax)) keep.push(f);
  return keep;
}

// The least-squares similarity transform (scale, rotation, shift; no
// reflection) taking src points to dst points, both flat [x0, y0, x1, y1, ...].
// Returns the 2 x 3 matrix [a, b, tx, c, d, ty]: x' = a x + b y + tx, y' = c x + d y + ty.
export function similarityTransform(src, dst) {
  const n = src.length / 2;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[2 * i]; sy += src[2 * i + 1]; dx += dst[2 * i]; dy += dst[2 * i + 1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let p = 0, q = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[2 * i] - sx, ay = src[2 * i + 1] - sy, bx = dst[2 * i] - dx, by = dst[2 * i + 1] - dy;
    p += ax * bx + ay * by; q += ax * by - ay * bx; norm += ax * ax + ay * ay;
  }
  const a = norm ? p / norm : 1, c = norm ? q / norm : 0;   // a = s cos(t), c = s sin(t)
  return [a, -c, dx - (a * sx - c * sy), c, a, dy - (c * sx + a * sy)];
}

// Warp RGBA pixels (width w, height h) through matrix m into an out x out
// RGBA crop, sampling bilinearly; outside the image is black (as cv2.warpAffine).
export function warpAffine(px, w, h, m, out) {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const res = new Uint8ClampedArray(out * out * 4);
  for (let v = 0; v < out; v++) for (let u = 0; u < out; u++) {
    const X = u - tx, Y = v - ty;
    const x = ia * X + ib * Y, y = ic * X + id * Y;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const o = (v * out + u) * 4;
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (const [xx, yy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
        if (wt && xx >= 0 && yy >= 0 && xx < w && yy < h) acc += px[(yy * w + xx) * 4 + ch] * wt;
      }
      res[o + ch] = acc;
    }
    res[o + 3] = 255;
  }
  return res;
}

export function l2normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

// Vectors are unit length, so cosine distance is 1 minus the dot product.
export function cosineDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return 1 - s;
}

// ── people state ────────────────────────────────────────────────────────────
// state = { people: { [pid]: { id, name, hidden, cover } },
//           assign: { [faceId]: pid },
//           notPerson: { [faceId]: [pid, ...] },   // "not this person" marks
//           next: number }                         // next person number

export function emptyState() { return { people: {}, assign: {}, notPerson: {}, next: 1 }; }

function newPerson(state) {
  let id;
  do id = 'p' + state.next++; while (state.people[id]);
  state.people[id] = { id, name: '', hidden: false, cover: null };
  return id;
}

// faces: [{ id, vector }]. Assigns ungrouped faces in place; returns the number assigned.
export function clusterFaces(faces, state, { maxDistance = MAX_DISTANCE, minFaces = MIN_FACES } = {}) {
  const allowed = (fid, pid) => !!state.people[pid] && !(state.notPerson[fid] ?? []).includes(pid);
  const ungrouped = faces.filter(f => !state.assign[f.id] || !state.people[state.assign[f.id]]);
  const near = new Map();
  for (const f of ungrouped) {
    const list = [];
    for (const g of faces) if (g !== f) { const dist = cosineDistance(f.vector, g.vector); if (dist <= maxDistance) list.push([dist, g.id]); }
    near.set(f.id, list.sort((x, y) => x[0] - y[0]));
  }
  const nearestPerson = (f) => {
    for (const [, gid] of near.get(f.id)) { const pid = state.assign[gid]; if (pid && allowed(f.id, pid)) return pid; }
    return null;
  };
  let assigned = 0;
  for (const f of ungrouped) {                              // core faces
    if (near.get(f.id).length + 1 < minFaces) continue;
    // A face marked "not this person" joins another person but never starts one.
    const pid = nearestPerson(f) ?? (state.notPerson[f.id]?.length ? null : newPerson(state));
    if (pid) { state.assign[f.id] = pid; assigned++; }
  }
  for (const f of ungrouped) {                              // border faces
    if (state.assign[f.id]) continue;
    const pid = nearestPerson(f);
    if (pid) { state.assign[f.id] = pid; assigned++; }
  }
  return assigned;
}

// Move every face of `from` into `into`; keeps into's name unless it has none.
export function mergePeople(state, into, from) {
  if (into === from || !state.people[into] || !state.people[from]) return false;
  for (const [fid, pid] of Object.entries(state.assign)) if (pid === from) state.assign[fid] = into;
  for (const list of Object.values(state.notPerson)) { const i = list.indexOf(from); if (i >= 0) list[i] = into; }
  if (!state.people[into].name) state.people[into].name = state.people[from].name;
  delete state.people[from];
  return true;
}

// The face leaves its person and never rejoins that person automatically.
export function markNotPerson(state, faceId) {
  const pid = state.assign[faceId];
  if (!pid) return null;
  delete state.assign[faceId];
  (state.notPerson[faceId] ??= []).includes(pid) || state.notPerson[faceId].push(pid);
  if (state.people[pid]?.cover === faceId) state.people[pid].cover = null;
  return pid;
}

// Intersection over union of two normalised [x, y, w, h] boxes.
export function boxIou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

// ── storage: IndexedDB 'slate.faces' (or a Map in Node) ─────────────────────
//   photos  keyPath 'photoId'   { photoId, sig, model, faces: [face], xmp: regions|null }
//   kv      'people'            the people state
// face = { id, box: [x, y, w, h] (0 to 1 of the photo), landmarks: [10 numbers, 0 to 1], score, vector: Float32Array(128) }

export function memoryFaceStore() {
  const photos = new Map(), kv = new Map();
  const clone = (v) => structuredClone(v);
  return {
    async allPhotos() { return [...photos.values()].map(clone); },
    async putPhoto(p) { photos.set(p.photoId, clone(p)); },
    async deletePhotos(ids) { for (const id of ids) photos.delete(id); },
    async getKv(k) { return kv.has(k) ? clone(kv.get(k)) : undefined; },
    async setKv(k, v) { kv.set(k, clone(v)); },
    async destroy() { photos.clear(); kv.clear(); return { blocked: false }; },
  };
}

function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); }); }

export async function idbFaceStore(name = DB_NAME) {
  let db = null;
  const open = () => db ?? (db = new Promise((resolve, reject) => {
    const o = indexedDB.open(name, 1);
    o.onupgradeneeded = () => { o.result.createObjectStore('photos', { keyPath: 'photoId' }); o.result.createObjectStore('kv'); };
    o.onsuccess = () => resolve(o.result);
    o.onerror = () => reject(o.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); await idbDone(t); return r; };
  return {
    async allPhotos() { const d = await open(); return idbReq(d.transaction('photos').objectStore('photos').getAll()); },
    async putPhoto(p) { await tx('photos', 'readwrite', s => s.put(p)); },
    async deletePhotos(ids) { await tx('photos', 'readwrite', s => { for (const id of ids) s.delete(id); }); },
    async getKv(k) { const d = await open(); return idbReq(d.transaction('kv').objectStore('kv').get(k)); },
    async setKv(k, v) { await tx('kv', 'readwrite', s => s.put(v, k)); },
    async destroy() {
      if (db) { (await db).close(); db = null; }
      // onblocked: another tab holds the database open; the delete finishes when that tab closes.
      return new Promise((res) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = () => res({ blocked: false });
        r.onerror = () => res({ blocked: false, error: r.error?.message ?? 'the delete failed' });
        r.onblocked = () => res({ blocked: true });
      });
    },
  };
}

// ── the worker ──────────────────────────────────────────────────────────────
// Messages in:  { op: 'detect', id, file }   (a Blob; decoded here)
// Messages out: { id, faces: [face without id], w, h } or { id, error }
// The pure functions above are copied in by toString(), so one copy is tested.

const WORKER_BODY = `
let ready = null;
async function modelBytes(url) {
  const cache = await caches.open(${JSON.stringify(MODEL_CACHE)});
  let res = await cache.match(url);
  if (!res) {
    const got = await fetch(url);
    if (!got.ok) throw new Error('could not download ' + url.slice(url.lastIndexOf('/') + 1) + ' (HTTP ' + got.status + ')');
    await cache.put(url, got.clone());
    res = got;
  }
  return new Uint8Array(await res.arrayBuffer());
}
function load() {
  return ready ??= (async () => {
    const ort = await import(CFG.ortUrl);
    ort.env.wasm.wasmPaths = CFG.ortBase;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const opts = { executionProviders: ['wasm'] };
    const det = await ort.InferenceSession.create(await modelBytes(CFG.detUrl), opts);
    const rec = await ort.InferenceSession.create(await modelBytes(CFG.recUrl), opts);
    return { ort, det, rec };
  })().catch(e => { ready = null; throw e; });
}
async function detect(file) {
  const { ort, det, rec } = await load();
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height, S = CFG.size;
  const k = Math.min(1, S / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const cv = new OffscreenCanvas(S, S);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const px = g.getImageData(0, 0, S, S).data;
  const plane = S * S, inp = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) { inp[i] = px[i * 4 + 2]; inp[plane + i] = px[i * 4 + 1]; inp[2 * plane + i] = px[i * 4]; }  // BGR, 0 to 255
  const o = await det.run({ input: new ort.Tensor('float32', inp, [1, 3, S, S]) });
  const out = {}; for (const key in o) out[key] = o[key].data;
  const found = nms(decodeYunet(out, S, CFG.minScore), CFG.nmsIou).filter(f => Math.min(f.box[2], f.box[3]) >= CFG.minPx).slice(0, 50);
  const faces = [];
  for (const f of found) {
    const crop = warpAffine(px, S, S, similarityTransform(f.landmarks, CFG.template), 112);
    const p2 = 112 * 112, t = new Float32Array(3 * p2);
    for (let i = 0; i < p2; i++) { t[i] = crop[i * 4]; t[p2 + i] = crop[i * 4 + 1]; t[2 * p2 + i] = crop[i * 4 + 2]; }  // RGB, 0 to 255
    const r = await rec.run({ data: new ort.Tensor('float32', t, [1, 3, 112, 112]) });
    const vector = l2normalise(r.fc1.data);
    const [x, y, bw, bh] = f.box;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(w, x + bw), y1 = Math.min(h, y + bh);
    faces.push({
      box: [x0 / w, y0 / h, Math.max(0, x1 - x0) / w, Math.max(0, y1 - y0) / h],
      landmarks: f.landmarks.map((v, i) => v / (i % 2 ? h : w)),
      score: f.score, vector,
    });
  }
  return { faces, w: W, h: H };
}
// One photo at a time: the sessions are not run concurrently.
let chain = Promise.resolve();
self.onmessage = (e) => {
  const { id, file } = e.data;
  chain = chain.then(() => detect(file)).then(r => self.postMessage({ id, ...r }), err => self.postMessage({ id, error: String(err && err.message || err) }));
};
`;

export function workerSource() {
  const cfg = {
    ortUrl: MODELS.runtime.url, ortBase: ORT_BASE, detUrl: MODELS.detector.url, recUrl: MODELS.recogniser.url,
    size: DETECT_SIZE, minScore: MIN_SCORE, nmsIou: NMS_IOU, minPx: MIN_FACE_PX, template: TEMPLATE,
  };
  return `const CFG = ${JSON.stringify(cfg)};\n${[decodeYunet, nms, similarityTransform, warpAffine, l2normalise].map(f => f.toString()).join('\n')}\n${WORKER_BODY}`;
}

function makeDetector() {
  let w = null, seq = 0;
  const waiting = new Map();
  const start = () => {
    const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
    w = new Worker(url, { type: 'module' });
    w.addEventListener('message', (e) => { const p = waiting.get(e.data.id); if (p) { waiting.delete(e.data.id); p(e.data); } });
    w.addEventListener('error', (e) => {
      console.error('[slate faces] worker error:', e.message);
      for (const p of waiting.values()) p({ error: e.message || 'the face worker failed to start' });
      waiting.clear(); w.terminate(); w = null;
    });
  };
  return {
    detect(file) {
      if (!w) start();
      const id = ++seq;
      return new Promise((resolve) => { waiting.set(id, resolve); w.postMessage({ id, file }); });
    },
    stop() { w?.terminate(); w = null; for (const p of waiting.values()) p({ error: 'stopped' }); waiting.clear(); },
  };
}

// ── the service ─────────────────────────────────────────────────────────────

const sigOf = (r) => `${r.size}:${r.mtime}`;
const RECLUSTER_MS = 1500;

export function initFaces(lib, { faceStore = null, detector = null, readSidecar = null } = {}) {
  let on = false, paused = false, loaded = false;
  let fstore = faceStore;
  let det = detector;
  const photos = new Map();          // photoId -> { photoId, sig, model, faces, xmp }
  let state = emptyState();
  let lastError = '';
  let reclusterTimer = null;
  const listeners = new Set();
  const changed = (what) => { for (const fn of listeners) { try { fn(what); } catch { /* a listener never stops the service */ } } };

  const getStore = async () => fstore ??= (typeof indexedDB !== 'undefined' ? await idbFaceStore() : memoryFaceStore());

  async function loadData() {
    if (loaded) return;
    const s = await getStore();
    for (const p of await s.allPhotos()) {
      if (p.model !== MODEL_ID) continue;          // another model's vectors are redone
      p.faces.forEach(f => { f.vector = f.vector instanceof Float32Array ? f.vector : Float32Array.from(f.vector); });
      photos.set(p.photoId, p);
    }
    state = (await s.getKv('people')) ?? emptyState();
    loaded = true;
  }
  const saveState = () => getStore().then(s => s.setKv('people', state)).catch(e => lib.emit('error', { message: `Could not save people: ${e.message}` }));

  const vis = (photoId) => (lib.visible ? lib.visible(photoId) : true);
  const photoOf = (fid) => fid.slice(0, fid.lastIndexOf('#'));
  const allFaces = () => { const out = []; for (const p of photos.values()) for (const f of p.faces) out.push(f); return out; };
  const faceById = (fid) => photos.get(fid.slice(0, fid.lastIndexOf('#')))?.faces.find(f => f.id === fid) ?? null;

  // Named XMP regions name a person who has none yet, when a face overlaps the region.
  function nameFromXmp() {
    let n = 0;
    for (const p of photos.values()) {
      if (!p.xmp?.regions?.length) continue;
      for (const f of p.faces) {
        const pid = state.assign[f.id], person = pid && state.people[pid];
        if (!person || person.name) continue;
        const hit = p.xmp.regions.find(r => r.name && boxIou([r.x - r.w / 2, r.y - r.h / 2, r.w, r.h], f.box) > 0.3);
        if (hit) { person.name = hit.name; n++; }
      }
    }
    return n;
  }

  function recluster() {
    clearTimeout(reclusterTimer); reclusterTimer = null;
    const faces = allFaces();
    // Assignments to faces that no longer exist are dropped.
    const live = new Set(faces.map(f => f.id));
    for (const fid of Object.keys(state.assign)) if (!live.has(fid)) delete state.assign[fid];
    clusterFaces(faces, state);
    nameFromXmp();
    const used = new Set(Object.values(state.assign));
    for (const pid of Object.keys(state.people)) if (!used.has(pid) && !state.people[pid].name) delete state.people[pid];
    saveState();
    changed('people');
  }
  const scheduleRecluster = () => { clearTimeout(reclusterTimer); reclusterTimer = setTimeout(recluster, RECLUSTER_MS); };

  const wanted = (r) => r && r.kind !== 'video' && !r.missing && !lib.choice?.(r.id)?.trashed && vis(r.id);
  const todo = () => [...lib.records.values()].filter(r => wanted(r) && photos.get(r.id)?.sig !== sigOf(r));

  async function defaultSidecar(id) {
    const r = lib.get(id), root = r && lib.roots?.get(r.rootId);
    if (!r?.sidecar || root?.mode !== 'fsa') return null;
    const dir = await lib.getHandle(id, { parent: true });
    for (const n of sidecarNames(r.name)) {
      try { return await (await (await dir.getFileHandle(n)).getFile()).text(); } catch { /* try the next name */ }
    }
    return null;
  }

  const queued = new Set();           // photo ids on lib.jobs now, so a records event never adds one twice
  async function processOne(rec, signal) {
    try { await detectOne(rec, signal); } finally { queued.delete(rec.id); }
  }
  async function detectOne(rec, signal) {
    if (signal?.aborted || !on) return;
    const file = await lib.getFile(rec.id);
    det ??= makeDetector();
    const res = await det.detect(file);
    if (signal?.aborted || !on) return;
    if (res.error) { lastError = res.error; throw new Error(res.error); }
    lastError = '';
    let xmp = null;
    try { xmp = parseRegions(await (readSidecar ?? defaultSidecar)(rec.id)); } catch { /* no sidecar */ }
    const faces = res.faces.map((f, i) => ({ ...f, id: `${rec.id}#${i}` }));
    const entry = { photoId: rec.id, sig: sigOf(rec), model: MODEL_ID, faces, xmp };
    // A changed file gets new face ids; drop the old ones' assignments.
    for (const old of photos.get(rec.id)?.faces ?? []) { delete state.assign[old.id]; delete state.notPerson[old.id]; }
    photos.set(rec.id, entry);
    await (await getStore()).putPhoto(entry);
    scheduleRecluster();
    changed('photos');
  }

  function enqueue(recs) {
    recs = recs.filter(r => !queued.has(r.id));
    if (!on || paused || !recs.length) return;
    for (const r of recs) queued.add(r.id);
    lib.jobs.add('faces', recs, processOne);
  }

  // Face rows of photos that left the library: `ids` (or every row when null) whose record is
  // gone or missing. Their assignments go at the next recluster.
  async function prune(ids) {
    if (!loaded) return;
    const gone = (ids ?? [...photos.keys()]).filter(id => photos.has(id) && (!lib.get(id) || lib.get(id).missing));
    if (!gone.length) return;
    for (const id of gone) {
      for (const f of photos.get(id)?.faces ?? []) { delete state.assign[f.id]; delete state.notPerson[f.id]; }
      photos.delete(id);
    }
    try { await (await getStore()).deletePhotos(gone); }
    catch (e) { lib.emit('error', { message: `Could not delete face data: ${e.message}` }); }
    scheduleRecluster();
    changed('photos');
  }
  // While faces are off the rows are not loaded; start() prunes them when faces turn on.
  // A whole-table prune needs the records loaded, so it runs only when there are records
  // (an emptied index must not delete every face).
  const PRUNE = new Set(['empty-trash', 'remove-root', 'scan', 'move']);
  let pruning = Promise.resolve();
  const pruneAll = () => (lib.records.size ? prune(null) : undefined);
  lib.on('records', (ev = {}) => {
    if (PRUNE.has(ev.reason)) pruning = pruning.then(() => (Array.isArray(ev.ids) ? prune(ev.ids) : ev.reason === 'remove-root' ? prune(null) : pruneAll())).catch(() => {});
    else if (ev.reason === 'load') pruning = pruning.then(pruneAll).catch(() => {});
  });
  // Unlocking makes hidden photos visible; the face job picks them up then.
  lib.on('choices', (ev = {}) => { if (ev.reason === 'lock' && on && !paused) enqueue(todo()); });

  lib.on('records', ({ ids } = {}) => {
    if (!on || paused) return;
    if (!Array.isArray(ids)) { enqueue(todo()); return; }
    enqueue(ids.map(id => lib.get(id)).filter(r => wanted(r) && photos.get(r.id)?.sig !== sigOf(r)));
  });

  async function start() {
    await loadData();
    await pruneAll();
    lib.jobs.cancel('faces'); queued.clear();
    enqueue(todo());
    recluster();
  }

  const ready = Promise.resolve(lib.store?.getKv?.(SETTING_KEY)).then(v => { on = v === true; if (on) return start(); }).catch(e => { lastError = e.message; });

  const writeXmp = (photoIds) => { if (photoIds.length) lib.services.xmpWrite?.queue?.(photoIds); };
  const photosOfPid = (pid) => [...new Set(Object.entries(state.assign).filter(([, p]) => p === pid).map(([fid]) => fid.slice(0, fid.lastIndexOf('#'))))];

  const api = {
    ready,
    enabled: () => on,
    paused: () => paused,
    lastError: () => lastError,
    async setEnabled(v) {
      on = !!v;
      await lib.store?.setKv?.(SETTING_KEY, on);
      if (on) { paused = false; await start(); }
      else { lib.jobs.cancel('faces'); queued.clear(); det?.stop?.(); }
      changed('setting');
    },
    pause() { paused = true; lib.jobs.cancel('faces'); queued.clear(); changed('setting'); },
    resume() { paused = false; enqueue(todo()); changed('setting'); },
    status() {
      const total = [...lib.records.values()].filter(wanted).length;
      let done = 0, faces = 0;
      for (const r of lib.records.values()) { const p = photos.get(r.id); if (wanted(r) && p?.sig === sigOf(r)) { done++; faces += p.faces.length; } }
      const people = Object.values(state.people);
      return { on, paused, total, done, faces, people: people.length, named: people.filter(p => p.name).length, error: lastError };
    },
    hasData: () => photos.size > 0 || Object.keys(state.people).length > 0,
    // Resolves when the face rows of removed photos are deleted (for tests and callers that wait).
    settled: () => pruning,
    // Turns faces off and removes every face, vector, person, name and the downloaded models.
    async deleteAll() {
      on = false; paused = false;
      lib.jobs.cancel('faces'); queued.clear();
      det?.stop?.();
      clearTimeout(reclusterTimer);
      photos.clear();
      state = emptyState();
      loaded = false;
      const res = (await (await getStore()).destroy()) ?? { blocked: false };
      fstore = faceStore;
      if (typeof caches !== 'undefined') await caches.delete(MODEL_CACHE).catch(() => {});
      await lib.store?.setKv?.(SETTING_KEY, false);
      changed('deleted');
      return { blocked: !!res.blocked, error: res.error ?? null };
    },

    people({ hidden = false } = {}) {
      const counts = new Map();
      for (const [fid, pid] of Object.entries(state.assign)) if (vis(photoOf(fid))) counts.set(pid, (counts.get(pid) ?? 0) + 1);
      return Object.values(state.people)
        .filter(p => hidden || !p.hidden)
        .map(p => ({ ...p, faces: counts.get(p.id) ?? 0, photos: photosOfPid(p.id).filter(vis).length }))
        .filter(p => p.faces > 0)
        .sort((a, b) => (!!b.name - !!a.name) || b.faces - a.faces);
    },
    person: (pid) => state.people[pid] ?? null,
    facesOf: (pid) => Object.entries(state.assign).filter(([fid, p]) => p === pid && vis(photoOf(fid))).map(([fid]) => faceById(fid)).filter(Boolean),
    photosOf: (pid) => photosOfPid(pid).filter(id => lib.get(id) && vis(id)).sort((a, b) => (lib.get(b).time ?? 0) - (lib.get(a).time ?? 0)),
    facesIn: (photoId) => (vis(photoId) ? (photos.get(photoId)?.faces ?? []) : []).map(f => ({ ...f, person: state.assign[f.id] ?? null })),
    coverFace(pid) {
      const p = state.people[pid];
      if (!p) return null;
      const cover = p.cover && state.assign[p.cover] === pid && vis(photoOf(p.cover)) ? faceById(p.cover) : null;
      return cover ?? api.facesOf(pid).sort((a, b) => b.score * b.box[2] - a.score * a.box[2])[0] ?? null;
    },

    name(pid, name) {
      const p = state.people[pid];
      if (!p) throw new Error('no such person');
      p.name = String(name ?? '').trim().slice(0, 100);
      saveState(); changed('people'); writeXmp(photosOfPid(pid));
      return p;
    },
    merge(into, from) {
      const touched = photosOfPid(from);
      if (!mergePeople(state, into, from)) throw new Error('pick two different people');
      saveState(); changed('people'); writeXmp(touched);
      return state.people[into];
    },
    hide(pid, v = true) {
      const p = state.people[pid];
      if (!p) throw new Error('no such person');
      p.hidden = !!v;
      saveState(); changed('people');
      return p;
    },
    notThisPerson(faceId) {
      const pid = markNotPerson(state, faceId);
      if (!pid) throw new Error('that face is not in a person');
      // Drop a person left with no faces, unless it has a name.
      if (!Object.values(state.assign).includes(pid) && !state.people[pid]?.name) delete state.people[pid];
      saveState(); changed('people'); writeXmp([faceId.slice(0, faceId.lastIndexOf('#'))]);
      return pid;
    },
    setCover(pid, faceId) {
      if (state.assign[faceId] !== pid) throw new Error('that face is not in this person');
      state.people[pid].cover = faceId;
      saveState(); changed('people');
    },

    // MWG regions for xmpwrite.js: the named people in a photo (hidden ones too:
    // hiding is a People view choice, not an edit), plus
    // regions already in the sidecar that none of them overlaps. undefined
    // (leave the sidecar's regions alone) when faces are off or none is named.
    regionsFor(photoId) {
      if (!on) return undefined;
      const p = photos.get(photoId);
      if (!p) return undefined;
      const ours = [];
      for (const f of p.faces) {
        const person = state.people[state.assign[f.id]];
        if (!person?.name) continue;
        const [x, y, w, h] = f.box;
        ours.push({ name: person.name, type: 'Face', x: x + w / 2, y: y + h / 2, w, h, box: f.box });
      }
      if (!ours.length) return undefined;
      const kept = (p.xmp?.regions ?? []).filter(r => !ours.some(o => boxIou(o.box, [r.x - r.w / 2, r.y - r.h / 2, r.w, r.h]) > 0.3));
      const rec = lib.get(photoId);
      return { w: rec?.w ?? 0, h: rec?.h ?? 0, regions: [...ours.map(({ box, ...r }) => r), ...kept] };
    },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _recluster: recluster,
  };
  lib.services.faces = api;
  return api;
}
