// Duplicates: exact copies (same size, same SHA-256) and near copies (64-bit
// dHash within a Hamming distance). Pure, so Node runs every part of it.
//
//   dhashRGBA(data, w, h)            -> 16 hex chars; data is RGBA bytes of a w x h picture
//   hamming(a, b)                    -> bits that differ between two 16-hex hashes
//   sizeCollisions(records, opts)    -> records whose size another record shares
//   exactGroups(records, hashOf, opts)        -> Promise<Group[]>
//   nearGroups(records, opts)                 -> Group[]
//   nearGroupsAsync(records, opts)            -> Promise<Group[]>, yields to the page as it goes
//   rankKeeper(records, opts)        -> records sorted best keeper first
//
// Group = { kind: 'exact'|'near', key, ids, keeper }; ids are best keeper first.
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

// hashOf(record) -> content hash (or a Promise of one); null or a throw leaves the record out.
export async function exactGroups(records, hashOf, opts = {}) {
  const groups = new Map();
  for (const r of sizeCollisions(records, opts)) {
    let h = null;
    try { h = await hashOf(r); } catch { h = null; }
    if (!h) continue;
    const key = `${r.size}:${h}`;
    const list = groups.get(key);
    if (list) list.push(r); else groups.set(key, [r]);
  }
  const out = [];
  for (const [key, list] of groups) if (list.length > 1) out.push(toGroup('exact', key, list, opts));
  return out.sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1));
}

// SHA-256 of a File, Blob or ArrayBuffer, as hex (browser and Node 20+).
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
