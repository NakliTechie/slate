// Duplicates: exact copies (same size, same sampled fingerprint, then equal
// bytes, compared in chunks) and near copies (64-bit
// dHash within a Hamming distance). Pure, so Node runs every part of it.
//
//   dhashRGBA(data, w, h)            -> 16 hex chars; data is RGBA bytes of a w x h picture
//   hamming(a, b)                    -> bits that differ between two 16-hex hashes
//   sizeCollisions(records, opts)    -> records whose size another record shares
//   exactGroups(records, fingerprintOf, sameOf, opts) -> Promise<Group[]>
//   sampleFingerprint(blob) / sameBytes(a, b)  -> the two stages for real files
//   nearGroups(records, opts)                 -> Group[]
//   nearGroupsAsync(records, opts)            -> Promise<Group[]>, yields to the page as it goes
//   rankKeeper(records, opts)        -> records sorted best keeper first
//   clipGroups(records, vectorOf, opts) / clipGroupsAsync  -> Group[] of kind 'clip' (row D4, at the end)
//
// Group = { kind: 'exact'|'near'|'clip', key, ids, keeper }; ids are best keeper first.
// opts.isTrashed(record) excludes a record (default: record.trashed);
// opts.choiceOf(id) -> { fav, rating } feeds the keeper ranking.
//
// Near grouping splits the 64 bits into 4 blocks of 16. Two hashes within
// distance d agree to within floor(d / 4) bits in at least one block, so each
// hash looks up only the bucket values that close to its own blocks. With
// d <= 11 that is at most 4 x 299 bucket probes per hash, never all pairs.
// Matches are joined into groups (union-find), so a burst chains together.

export const DEFAULT_MAX_DISTANCE = 6;
export const MAX_DISTANCE_LIMIT = 11;

// dHash: average the picture down to 9 x 8 grey cells (area average, so the
// result does not depend on how the browser scales), then set one bit per
// cell pair where the left cell is brighter than its right neighbour.
// Self-contained: thumbs.js copies its source into the thumbnail worker.
export function dhashRGBA(data, w, h) {
  const GW = 9, GH = 8;
  const grey = new Float64Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    const y0 = Math.floor(gy * h / GH), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / GH));
    for (let gx = 0; gx < GW; gx++) {
      const x0 = Math.floor(gx * w / GW), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / GW));
      let sum = 0, n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        for (let x = x0; x < x1 && x < w; x++) {
          const i = (y * w + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      grey[gy * GW + gx] = n ? sum / n : 0;
    }
  }
  let hex = '';
  for (let gy = 0; gy < GH; gy++) {
    let byte = 0;
    for (let gx = 0; gx < 8; gx++) byte = (byte << 1) | (grey[gy * GW + gx] > grey[gy * GW + gx + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const pop32 = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

export function hamming(a, b) {
  return pop32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0)
    + pop32((parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0);
}

const defaultTrashed = (r) => !!r.trashed;
const live = (records, opts = {}) => {
  const isTrashed = opts.isTrashed ?? defaultTrashed;
  const out = [];
  for (const r of records) if (r && !r.missing && !isTrashed(r)) out.push(r);
  return out;
};

// Best keeper first: most pixels, then favourite, then higher rating, then the
// oldest file (lowest mtime), then id so the order is stable.
export function rankKeeper(records, opts = {}) {
  const choiceOf = opts.choiceOf ?? (() => ({}));
  const score = new Map(records.map(r => {
    const c = choiceOf(r.id) ?? {};
    return [r.id, { px: (r.w || 0) * (r.h || 0), fav: c.fav ? 1 : 0, rating: c.rating || 0 }];
  }));
  return [...records].sort((a, b) => {
    const sa = score.get(a.id), sb = score.get(b.id);
    return (sb.px - sa.px) || (sb.fav - sa.fav) || (sb.rating - sa.rating)
      || ((a.mtime || 0) - (b.mtime || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

function toGroup(kind, key, members, opts) {
  const ranked = rankKeeper(members, opts);
  return { kind, key, ids: ranked.map(r => r.id), keeper: ranked[0].id };
}

// Records that share their byte size with another live record: the only ones
// whose content hash is worth computing.
export function sizeCollisions(records, opts = {}) {
  const bySize = new Map();
  for (const r of live(records, opts)) {
    if (!(r.size > 0)) continue;
    const list = bySize.get(r.size);
    if (list) list.push(r); else bySize.set(r.size, [r]);
  }
  const out = [];
  for (const list of bySize.values()) if (list.length > 1) out.push(...list);
  return out;
}

// Exact copies in two stages, so no stage ever holds a whole large file:
//   1. fingerprintOf(record) -> sampleFingerprint of its file (or a Promise of
//      one); null or a throw leaves the record out. Records group by size and
//      fingerprint.
//   2. sameOf(a, b) -> Promise<boolean>, true when the two files are equal byte
//      for byte (sameBytes); each fingerprint group splits into byte-equal sets.
// A group is exact only when both stages agree.
export async function exactGroups(records, fingerprintOf, sameOf, opts = {}) {
  const out = [];
  for (const [key, list] of await fingerprintCandidates(records, fingerprintOf, opts)) {
    for (const set of await splitByBytes(list, sameOf)) if (set.length > 1) out.push(toGroup('exact', key, set, opts));
  }
  return out.sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1));
}

// Stage 1 alone: Map of `${size}:${fingerprint}` -> records, only keys with 2+ records.
export async function fingerprintCandidates(records, fingerprintOf, opts = {}) {
  const groups = new Map();
  for (const r of sizeCollisions(records, opts)) {
    let h = null;
    try { h = await fingerprintOf(r); } catch { h = null; }
    if (!h) continue;
    const key = `${r.size}:${h}`;
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }
  for (const [k, list] of groups) if (list.length < 2) groups.delete(k);
  return groups;
}

// Stage 2 alone: split records into sets whose files are equal byte for byte.
// Each record is compared with the first record of each set until one matches,
// so a group of true copies costs n - 1 comparisons. A throw counts as unequal.
export async function splitByBytes(list, sameOf) {
  const sets = [];
  for (const r of list) {
    let home = null;
    for (const set of sets) {
      let same = false;
      try { same = await sameOf(set[0], r); } catch { same = false; }
      if (same) { home = set; break; }
    }
    if (home) home.push(r); else sets.push([r]);
  }
  return sets;
}

export const SAMPLE_BYTES = 1 << 20;   // fingerprint reads this much from each end
export const CHUNK_BYTES = 4 << 20;    // byte comparison reads this much at a time

// A quick fingerprint of a File or Blob: SHA-256 (hex) over the first 1 MB,
// the last 1 MB and the size. It reads at most 2 MB however large the file is,
// so equal fingerprints only nominate a pair; sameBytes confirms it.
export async function sampleFingerprint(blob) {
  const size = blob.size;
  const head = await blob.slice(0, Math.min(SAMPLE_BYTES, size)).arrayBuffer();
  const tail = await blob.slice(Math.max(0, size - SAMPLE_BYTES), size).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(`:${size}`);
  const buf = new Uint8Array(head.byteLength + tail.byteLength + sizeBytes.length);
  buf.set(new Uint8Array(head), 0);
  buf.set(new Uint8Array(tail), head.byteLength);
  buf.set(sizeBytes, head.byteLength + tail.byteLength);
  return sha256Hex(buf);
}

// True when two Files or Blobs hold the same bytes. Reads both in 4 MB chunks
// and stops at the first chunk that differs, so it holds two chunks at most.
export async function sameBytes(a, b, opts = {}) {
  if (a.size !== b.size) return false;
  const step = opts.chunk ?? CHUNK_BYTES;
  for (let at = 0; at < a.size; at += step) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const end = Math.min(a.size, at + step);
    const [x, y] = await Promise.all([a.slice(at, end).arrayBuffer(), b.slice(at, end).arrayBuffer()]);
    if (!equalBuffers(x, y)) return false;
  }
  return true;
}

function equalBuffers(x, y) {
  if (x.byteLength !== y.byteLength) return false;
  const n8 = x.byteLength, n4 = n8 >> 2;
  const a4 = new Uint32Array(x, 0, n4), b4 = new Uint32Array(y, 0, n4);
  for (let i = 0; i < n4; i++) if (a4[i] !== b4[i]) return false;
  const a1 = new Uint8Array(x), b1 = new Uint8Array(y);
  for (let i = n4 << 2; i < n8; i++) if (a1[i] !== b1[i]) return false;
  return true;
}

// SHA-256 of a small buffer or Blob, as hex (browser and Node 20+). Callers
// pass at most a few MB: whole large files go through sampleFingerprint.
export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : await data.arrayBuffer();
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// ── near grouping ─────────────────────────────────────────────────────────

// Every 16-bit value within `r` bits of v.
function neighbours(v, r) {
  const out = [v];
  if (r >= 1) for (let i = 0; i < 16; i++) out.push(v ^ (1 << i));
  if (r >= 2) for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) out.push(v ^ (1 << i) ^ (1 << j));
  return out;
}

function* nearSteps(records, opts = {}) {
  const d = Math.max(0, Math.min(MAX_DISTANCE_LIMIT, Math.floor(opts.maxDistance ?? DEFAULT_MAX_DISTANCE)));
  const list = live(records, opts).filter(r => typeof r.dhash === 'string' && /^[0-9a-f]{16}$/.test(r.dhash));
  const n = list.length;
  const hi = new Uint32Array(n), lo = new Uint32Array(n);
  for (let i = 0; i < n; i++) { hi[i] = parseInt(list[i].dhash.slice(0, 8), 16); lo[i] = parseInt(list[i].dhash.slice(8), 16); }
  const block = (i, b) => b === 0 ? hi[i] >>> 16 : b === 1 ? hi[i] & 0xffff : b === 2 ? lo[i] >>> 16 : lo[i] & 0xffff;

  // 4 bucket tables: block value -> indices.
  const tables = [0, 1, 2, 3].map(() => new Map());
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < 4; b++) {
      const t = tables[b], v = block(i, b), s = t.get(v);
      if (s) s.push(i); else t.set(v, [i]);
    }
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const r = Math.floor(d / 4);
  const STEP = 2000;
  for (let i = 0; i < n; i++) {
    for (let b = 0; b < 4; b++) {
      for (const v of neighbours(block(i, b), r)) {
        const s = tables[b].get(v);
        if (!s) continue;
        for (const j of s) {
          if (j <= i) continue;
          if (pop32((hi[i] ^ hi[j]) >>> 0) + pop32((lo[i] ^ lo[j]) >>> 0) > d) continue;
          const a = find(i), c = find(j);
          if (a !== c) parent[a] = c;
        }
      }
    }
    if ((i + 1) % STEP === 0) yield { done: i + 1, total: n };
  }

  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i), c = comps.get(root);
    if (c) c.push(list[i]); else comps.set(root, [list[i]]);
  }
  const out = [];
  for (const members of comps.values()) if (members.length > 1) out.push(toGroup('near', members.map(m => m.id).sort()[0], members, opts));
  return out.sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1));
}

export function nearGroups(records, opts = {}) {
  const it = nearSteps(records, opts);
  for (;;) { const s = it.next(); if (s.done) return s.value; }
}

// The same result, handing the page back every 2,000 hashes. opts.onProgress({ done, total }),
// opts.signal (AbortSignal) stops it with an AbortError.
export async function nearGroupsAsync(records, opts = {}) {
  const it = nearSteps(records, opts);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
    opts.onProgress?.(s.value);
    await new Promise(res => setTimeout(res, 0));
    if (opts.signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
  }
}

// Near groups that only repeat an exact group add nothing; drop them.
export function dropCoveredNear(near, exact) {
  const groupOf = new Map();
  exact.forEach((g, i) => { for (const id of g.ids) groupOf.set(id, i); });
  return near.filter(g => {
    const first = groupOf.get(g.ids[0]);
    return first === undefined || !g.ids.every(id => groupOf.get(id) === first);
  });
}

// Run items on a JobQueue (lib.jobs) and resolve when every item of this call
// has finished or the kind is cancelled. fn(item, signal) as for JobQueue.add.
export function runOnJobs(jobs, kind, items, fn) {
  if (!items.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = items.length, off = null, ended = false;
    const finish = () => { if (ended) return; ended = true; off?.(); resolve(); };
    // cancel() drops pending items without calling fn, so also finish when the
    // queue's count for this kind says nothing of it is left.
    off = jobs.onProgress?.((p) => {
      const c = p.kinds?.[kind];
      if (c && c.done + c.failed >= c.total) finish();
    }) ?? null;
    jobs.add(kind, items, async (item, signal) => {
      try { return await fn(item, signal); }
      finally { if (--left === 0) finish(); }
    });
  });
}

// ── similar by meaning (row D4) ───────────────────────────────────────────
//
//   clipGroupsAsync(records, vectorOf, opts) -> Promise<Group[]> of kind 'clip'
//
// vectorOf(id) -> { q: Int8Array, inv } (clip.js VectorSet.view) or null.
// Two photos join when their cosine is at least opts.minCosine (default 0.95).
// opts.exclude: groups already found (exact and dHash near); a pair whose two
// photos share one of those groups is skipped, so this pass adds only what the
// fingerprints missed. opts.onProgress({ done, total }), opts.signal as above.
//
// Comparing every pair is too slow past a few thousand photos, so candidate
// pairs come from random-hyperplane hashes (SimHash): CLIP_TABLES tables of 64
// bits each, over vectors centred on the library's mean (CLIP vectors sit in a
// narrow cone, and without centring most bits are the same for every photo).
// Two hashes within CLIP_MAX_BITS bits in any table make a candidate, and every
// candidate is checked with the exact cosine, so a group never holds a false
// pair. A true pair can be missed: on the test's fake vectors the result equals
// an all-pairs reference at 0.95 and 0.98 and misses 3 of about 700 pairs at
// 0.92 (tests/test-library-dupes.mjs). Node takes about 4 s for 20,000 vectors
// and 38 s for 100,000, most of it hashing.

export const CLIP_DEFAULT_MIN = 0.95;
export const CLIP_MIN_LIMIT = 0.92;
export const CLIP_MAX_LIMIT = 0.99;
const CLIP_TABLES = 4;
const CLIP_MAX_BITS = 11;
const CLIP_SEED = 0x5eed1234;

// Seeded Gaussian planes (Box-Muller over a linear congruential generator).
function gaussianPlanes(count, dim, seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 1) / 4294967297; };
  const out = new Float32Array(count * dim);
  for (let i = 0; i < out.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(u())), t = 2 * Math.PI * u();
    out[i] = r * Math.cos(t);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(t);
  }
  return out;
}

export function clipCosine(a, b) {
  const q1 = a.q, q2 = b.q;
  let dot = 0;
  for (let j = 0; j < q1.length; j++) dot += q1[j] * q2[j];
  return dot * a.inv * b.inv;
}

function* clipSteps(records, vectorOf, opts = {}) {
  const min = Math.max(CLIP_MIN_LIMIT, Math.min(CLIP_MAX_LIMIT, Number(opts.minCosine ?? CLIP_DEFAULT_MIN)));
  const list = [], vecs = [];
  for (const r of live(records, opts)) { const v = vectorOf(r.id); if (v && v.inv) { list.push(r); vecs.push(v); } }
  const n = list.length;
  if (n < 2) return [];
  const dim = vecs[0].q.length;
  const STEP = 1000;
  const total = n * 2;

  // Centre, then hash: bit p of table t is sign(plane · (v - mean)).
  const mean = new Float64Array(dim);
  for (const v of vecs) for (let j = 0; j < dim; j++) mean[j] += v.q[j] * v.inv;
  for (let j = 0; j < dim; j++) mean[j] /= n;
  const P = CLIP_TABLES * 64;
  const planes = gaussianPlanes(P, dim, CLIP_SEED);
  const pm = new Float64Array(P);
  for (let p = 0; p < P; p++) { let s = 0; const o = p * dim; for (let j = 0; j < dim; j++) s += planes[o + j] * mean[j]; pm[p] = s; }
  const hi = Array.from({ length: CLIP_TABLES }, () => new Uint32Array(n));
  const lo = Array.from({ length: CLIP_TABLES }, () => new Uint32Array(n));
  for (let i = 0; i < n; i++) {
    const { q, inv } = vecs[i];
    for (let p = 0; p < P; p++) {
      let s = 0;
      const o = p * dim;
      for (let j = 0; j < dim; j++) s += planes[o + j] * q[j];
      if (s * inv > pm[p]) {
        const t = (p / 64) | 0, b = p % 64;
        if (b < 32) hi[t][i] |= (1 << b); else lo[t][i] |= (1 << (b - 32));
      }
    }
    if ((i + 1) % STEP === 0) yield { done: i + 1, total };
  }

  const groupOf = new Int32Array(n).fill(-1);
  const gid = new Map();
  (opts.exclude ?? []).forEach((g, k) => { for (const id of g.ids) gid.set(id, k); });
  for (let i = 0; i < n; i++) { const k = gid.get(list[i].id); if (k !== undefined) groupOf[i] = k; }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const r = Math.floor(CLIP_MAX_BITS / 4);
  for (let t = 0; t < CLIP_TABLES; t++) {
    const H = hi[t], L = lo[t];
    const block = (i, b) => b === 0 ? H[i] >>> 16 : b === 1 ? H[i] & 0xffff : b === 2 ? L[i] >>> 16 : L[i] & 0xffff;
    const tables = [0, 1, 2, 3].map(() => new Map());
    for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) { const m = tables[b], v = block(i, b), s = m.get(v); if (s) s.push(i); else m.set(v, [i]); }
    for (let i = 0; i < n; i++) {
      for (let b = 0; b < 4; b++) {
        for (const v of neighbours(block(i, b), r)) {
          const s = tables[b].get(v);
          if (!s) continue;
          for (const j of s) {
            if (j <= i) continue;
            if (groupOf[i] >= 0 && groupOf[i] === groupOf[j]) continue;
            if (pop32((H[i] ^ H[j]) >>> 0) + pop32((L[i] ^ L[j]) >>> 0) > CLIP_MAX_BITS) continue;
            const a = find(i), c = find(j);
            if (a === c) continue;
            if (clipCosine(vecs[i], vecs[j]) >= min) parent[a] = c;
          }
        }
      }
      if ((i + 1) % STEP === 0) yield { done: n + Math.round((t * n + i + 1) / CLIP_TABLES), total };
    }
  }

  const comps = new Map();
  for (let i = 0; i < n; i++) { const root = find(i), c = comps.get(root); if (c) c.push(list[i]); else comps.set(root, [list[i]]); }
  const out = [];
  for (const members of comps.values()) if (members.length > 1) out.push(toGroup('clip', 'c:' + members.map(m => m.id).sort()[0], members, opts));
  return out.sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1));
}

export function clipGroups(records, vectorOf, opts = {}) {
  const it = clipSteps(records, vectorOf, opts);
  for (;;) { const s = it.next(); if (s.done) return s.value; }
}

export async function clipGroupsAsync(records, vectorOf, opts = {}) {
  const it = clipSteps(records, vectorOf, opts);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
    opts.onProgress?.(s.value);
    await new Promise(res => setTimeout(res, 0));
    if (opts.signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
  }
}
