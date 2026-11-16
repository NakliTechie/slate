// Duplicates: dHash, Hamming grouping against brute force, exact grouping,
// keeper ranking, trashed records left out, and the job helper.
import assert from 'node:assert/strict';
import {
  dhashRGBA, hamming, exactGroups, nearGroups, nearGroupsAsync, rankKeeper,
  sizeCollisions, sha256Hex, sampleFingerprint, sameBytes, splitByBytes, SAMPLE_BYTES, CHUNK_BYTES, dropCoveredNear, runOnJobs, MAX_DISTANCE_LIMIT,
  clipGroups, clipGroupsAsync, clipCosine, CLIP_DEFAULT_MIN, CLIP_MIN_LIMIT,
} from '../src/library/dupes.js';
import { JobQueue } from '../src/library/jobs.js';
import { VectorSet, normalise } from '../src/library/clip.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// A deterministic generator, so a failure replays.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

// A w x h RGBA picture from f(x, y) -> grey 0..255.
function picture(w, h, f) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y), i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return d;
}

const W = 64, H = 48;
const scene = (x, y) => 128 + 90 * Math.sin(x / 7) * Math.cos(y / 5) + (x * 1.3 - y) * 0.4;
const other = (x, y) => ((x * 31 + y * 17) % 97) * 2.5;

await test('dHash: 16 hex chars, identical pictures match', () => {
  const a = dhashRGBA(picture(W, H, scene), W, H);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(dhashRGBA(picture(W, H, scene), W, H), a);
});

await test('dHash: a brightened copy is within 2 bits, a different picture is far', () => {
  const a = dhashRGBA(picture(W, H, scene), W, H);
  const bright = dhashRGBA(picture(W, H, (x, y) => Math.min(255, scene(x, y) * 1.08 + 10)), W, H);
  const diff = dhashRGBA(picture(W, H, other), W, H);
  assert.ok(hamming(a, bright) <= 2, `brightened distance ${hamming(a, bright)}`);
  assert.ok(hamming(a, diff) >= 16, `different distance ${hamming(a, diff)}`);
});

await test('dHash: a smaller copy of the same picture matches closely', () => {
  const a = dhashRGBA(picture(W * 4, H * 4, (x, y) => scene(x / 4, y / 4)), W * 4, H * 4);
  const b = dhashRGBA(picture(W, H, scene), W, H);
  assert.ok(hamming(a, b) <= 4, `resized distance ${hamming(a, b)}`);
});

await test('dHash bits: left brighter than right sets the bit', () => {
  // grey falls left to right: every bit 1; rises: every bit 0.
  assert.equal(dhashRGBA(picture(18, 8, (x) => 255 - x * 14), 18, 8), 'ffffffffffffffff');
  assert.equal(dhashRGBA(picture(18, 8, (x) => x * 14), 18, 8), '0000000000000000');
});

await test('hamming counts differing bits', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('8000000000000001', '0000000000000000'), 2);
});

// Brute-force reference: union every pair within d, return sorted id lists of size > 1.
function bruteGroups(recs, d) {
  const parent = recs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    if (hamming(recs[i].dhash, recs[j].dhash) <= d) parent[find(i)] = find(j);
  }
  const m = new Map();
  recs.forEach((r, i) => { const k = find(i); (m.get(k) ?? m.set(k, []).get(k)).push(r.id); });
  return [...m.values()].filter(g => g.length > 1).map(g => g.sort().join(',')).sort();
}
const canon = (groups) => groups.map(g => [...g.ids].sort().join(',')).sort();

function randomHashes(count, seed) {
  const r = rng(seed);
  const hex8 = () => Math.floor(r() * 2 ** 32).toString(16).padStart(8, '0');
  const recs = [];
  for (let i = 0; i < count; i++) {
    let h;
    // a third are near copies of an earlier hash: flip 0 to 12 bits
    if (i > 10 && r() < 0.33) {
      const base = recs[Math.floor(r() * recs.length)].dhash;
      let hi = parseInt(base.slice(0, 8), 16), lo = parseInt(base.slice(8), 16);
      const flips = Math.floor(r() * 13);
      for (let f = 0; f < flips; f++) { const b = Math.floor(r() * 64); if (b < 32) hi = (hi ^ (1 << b)) >>> 0; else lo = (lo ^ (1 << (b - 32))) >>> 0; }
      h = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
    } else h = hex8() + hex8();
    recs.push({ id: `r/${String(i).padStart(5, '0')}.jpg`, dhash: h, w: 100, h: 100, mtime: i });
  }
  return recs;
}

await test('near grouping matches brute force on 2,000 hashes at every distance', () => {
  const recs = randomHashes(2000, 42);
  for (let d = 0; d <= MAX_DISTANCE_LIMIT; d++) {
    assert.deepEqual(canon(nearGroups(recs, { maxDistance: d })), bruteGroups(recs, d), `distance ${d}`);
  }
});

await test('nearGroupsAsync gives the same groups and reports progress', async () => {
  const recs = randomHashes(5000, 7);
  let ticks = 0;
  const a = await nearGroupsAsync(recs, { maxDistance: 6, onProgress: () => ticks++ });
  assert.deepEqual(canon(a), canon(nearGroups(recs, { maxDistance: 6 })));
  assert.ok(ticks >= 2);
});

await test('near grouping of 100,000 hashes stays fast', () => {
  const recs = randomHashes(100000, 99);
  const t = performance.now();
  nearGroups(recs, { maxDistance: 6 });
  const ms = performance.now() - t;
  assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
  console.log(`  100,000 hashes at distance 6: ${Math.round(ms)} ms`);
});

await test('keeper ranking: pixels, then favourite, then rating, then oldest', () => {
  const recs = [
    { id: 'a', w: 100, h: 100, mtime: 5 },
    { id: 'b', w: 200, h: 100, mtime: 9 },
    { id: 'c', w: 100, h: 100, mtime: 1 },
    { id: 'd', w: 100, h: 100, mtime: 3 },
    { id: 'e', w: 100, h: 100, mtime: 2 },
  ];
  const choices = { a: { fav: true }, d: { rating: 4 }, e: { rating: 2 } };
  const order = rankKeeper(recs, { choiceOf: id => choices[id] }).map(r => r.id);
  assert.deepEqual(order, ['b', 'a', 'd', 'e', 'c']);
  const g = nearGroups(recs.map(r => ({ ...r, dhash: '00ff00ff00ff00ff' })), { choiceOf: id => choices[id] });
  assert.equal(g.length, 1);
  assert.equal(g[0].keeper, 'b');
  assert.deepEqual(g[0].ids, order);
});

// Fake files: id -> bytes.
const enc = (s) => new TextEncoder().encode(s);
const FILES = {
  'r/a.jpg': enc('same bytes 1234'),
  'r/b.jpg': enc('same bytes 1234'),
  'r/c.jpg': enc('diff bytes 1234'),   // same size as a and b, other content
  'r/d.jpg': enc('same bytes 1234'),   // trashed
  'r/e.jpg': enc('a longer file, unique size'),
  'r/f.jpg': enc('same bytes 1234'),   // missing
};
const recOf = (id, extra = {}) => ({ id, size: FILES[id].length, w: 10, h: 10, mtime: 1, ...extra });

await test('exact grouping hashes only colliding sizes and leaves out trashed and missing', async () => {
  const recs = [recOf('r/a.jpg', { mtime: 5 }), recOf('r/b.jpg', { mtime: 2 }), recOf('r/c.jpg'), recOf('r/d.jpg'), recOf('r/e.jpg'), recOf('r/f.jpg', { missing: true })];
  const trashed = new Set(['r/d.jpg']);
  const read = [];
  const getFile = async (id) => { read.push(id); return new Blob([FILES[id]]); };
  const blobOf = (r) => new Blob([FILES[r.id]]);
  const groups = await exactGroups(recs, async (r) => sampleFingerprint(await getFile(r.id)), async (a, b) => sameBytes(blobOf(a), blobOf(b)), { isTrashed: r => trashed.has(r.id) });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'exact');
  assert.deepEqual(groups[0].ids, ['r/b.jpg', 'r/a.jpg']); // same pixels: the older file keeps
  assert.equal(groups[0].keeper, 'r/b.jpg');
  assert.deepEqual(read.sort(), ['r/a.jpg', 'r/b.jpg', 'r/c.jpg']); // e has a unique size; d trashed; f missing
  assert.deepEqual(sizeCollisions(recs, { isTrashed: r => trashed.has(r.id) }).map(r => r.id).sort(), ['r/a.jpg', 'r/b.jpg', 'r/c.jpg']);
});

await test('sha256Hex matches the known digest', async () => {
  assert.equal(await sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// A fake file of `size` bytes whose byte at i is byteAt(i). It answers only
// slice() and arrayBuffer() on slices, and counts the largest read, so a test
// can prove the whole file is never read at once.
function fakeFile(size, byteAt, stats = { largest: 0, reads: 0 }) {
  const part = (start, end) => ({
    size: end - start,
    slice: (s = 0, e = end - start) => part(start + s, start + Math.min(e, end - start)),
    arrayBuffer: async () => {
      const n = end - start;
      stats.largest = Math.max(stats.largest, n); stats.reads++;
      const u = new Uint8Array(n);
      for (let i = 0; i < n; i++) u[i] = byteAt(start + i);
      return u.buffer;
    },
  });
  const f = part(0, size);
  f.arrayBuffer = async () => { throw new Error('whole-file read'); };
  return f;
}

await test('same size, head and tail but a different middle: fingerprints match, bytes do not', async () => {
  const size = 5 * SAMPLE_BYTES;
  const mid = Math.floor(size / 2);
  const a = fakeFile(size, i => i & 0xff);
  const b = fakeFile(size, i => (i === mid ? 7 : i & 0xff) & 0xff);
  const c = fakeFile(size, i => i & 0xff);
  assert.equal(await sampleFingerprint(a), await sampleFingerprint(b));
  assert.equal(await sameBytes(a, b), false);
  assert.equal(await sameBytes(a, c), true);
  const files = { a, b, c };
  const recs = ['a', 'b', 'c'].map(id => ({ id, size, w: 1, h: 1, mtime: 1 }));
  const groups = await exactGroups(recs, r => sampleFingerprint(files[r.id]), (x, y) => sameBytes(files[x.id], files[y.id]));
  assert.deepEqual(groups.map(g => [...g.ids].sort().join()), ['a,c']);
});

await test('a 200 MB file is fingerprinted and compared in chunks, never read whole', async () => {
  const size = 200 * 1024 * 1024;
  const stats = { largest: 0, reads: 0 };
  const byteAt = i => (i * 31 + (i >>> 12)) & 0xff;
  const a = fakeFile(size, byteAt, stats), b = fakeFile(size, byteAt, stats);
  assert.equal(await sampleFingerprint(a), await sampleFingerprint(b));
  assert.equal(stats.largest, SAMPLE_BYTES);
  stats.reads = 0;
  assert.equal(await sameBytes(a, b), true);
  assert.equal(stats.reads, 2 * 50); // 50 chunks of 4 MB from each file
  assert.equal(stats.largest, CHUNK_BYTES);
});

await test('byte comparison stops at the first chunk that differs', async () => {
  const size = 64 * 1024 * 1024;
  const stats = { largest: 0, reads: 0 };
  const a = fakeFile(size, () => 1, stats);
  const b = fakeFile(size, i => (i < CHUNK_BYTES ? 1 : 2), stats);
  assert.equal(await sameBytes(a, b), false);
  assert.equal(stats.reads, 4); // chunk 0 equal, chunk 1 differs: two reads each
  assert.equal(stats.largest, CHUNK_BYTES);
});

await test('splitByBytes keeps distinct contents apart and treats a throw as unequal', async () => {
  const val = { a: 1, b: 2, c: 1, d: 2, e: 3 };
  const list = Object.keys(val).map(id => ({ id }));
  const sets = await splitByBytes(list, async (x, y) => { if (y.id === 'e') throw new Error('unreadable'); return val[x.id] === val[y.id]; });
  assert.deepEqual(sets.map(s => s.map(r => r.id).join()), ['a,c', 'b,d', 'e']);
});

await test('trashed records are left out of near groups by default and by choice', () => {
  const recs = [{ id: 'x', dhash: '0123456789abcdef' }, { id: 'y', dhash: '0123456789abcdee' }, { id: 'z', dhash: '0123456789abcdef', trashed: '2026-01-01' }];
  assert.deepEqual(canon(nearGroups(recs)), ['x,y']);
  assert.deepEqual(canon(nearGroups(recs, { isTrashed: r => r.id === 'y' })), ['x,z']);
});

await test('near groups that repeat an exact group are dropped', () => {
  const exact = [{ kind: 'exact', key: 'k', ids: ['a', 'b'], keeper: 'a' }];
  const near = [{ kind: 'near', ids: ['a', 'b'] }, { kind: 'near', ids: ['a', 'b', 'c'] }, { kind: 'near', ids: ['p', 'q'] }];
  assert.deepEqual(dropCoveredNear(near, exact).map(g => g.ids.join()), ['a,b,c', 'p,q']);
});

await test('runOnJobs resolves when its items finish, and when the kind is cancelled', async () => {
  const q = new JobQueue({ concurrency: 2 });
  const seen = [];
  await runOnJobs(q, 'dupes', [1, 2, 3, 4], async (i) => { seen.push(i); });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
  q.pause();
  const p = runOnJobs(q, 'dupes', [5, 6, 7], async () => {});
  q.cancel('dupes');
  await p;
  await runOnJobs(q, 'dupes', [], async () => {});
});

// ── similar by meaning (row D4) with fake CLIP vectors ───────────────────
// Vectors sit in a narrow cone (a shared offset), as CLIP image vectors do; a
// third are near copies of an earlier vector at cosine about 0.93 to 0.995.
function fakeClip(count, seed, dim = 512) {
  const r = rng(seed);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const offset = new Float32Array(dim); for (let j = 0; j < dim; j++) offset[j] = g();
  const off = normalise(offset);
  const set = new VectorSet(dim, count);
  const base = [];
  const recs = [];
  for (let i = 0; i < count; i++) {
    let v;
    if (i > 10 && r() < 0.33) {
      const src = base[Math.floor(r() * base.length)];
      const noise = r() * 0.4;
      v = new Float32Array(dim);
      for (let j = 0; j < dim; j++) v[j] = src[j] + noise * g() / Math.sqrt(dim);
    } else {
      v = new Float32Array(dim);
      for (let j = 0; j < dim; j++) v[j] = 1.2 * off[j] + g() / Math.sqrt(dim);
    }
    v = normalise(v);
    base.push(v);
    const id = `r/${String(i).padStart(5, '0')}.jpg`;
    set.set(id, v);
    recs.push({ id, w: 100, h: 100, mtime: i });
  }
  return { set, recs, vectorOf: (id) => set.view(id) };
}

function bruteClip(recs, vectorOf, min, exclude = []) {
  const gid = new Map(); exclude.forEach((g, k) => g.ids.forEach(id => gid.set(id, k)));
  const parent = recs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = gid.get(recs[i].id), b = gid.get(recs[j].id);
    if (a !== undefined && a === b) continue;
    if (clipCosine(vectorOf(recs[i].id), vectorOf(recs[j].id)) >= min) parent[find(i)] = find(j);
  }
  const m = new Map();
  recs.forEach((r, i) => { const k = find(i); (m.get(k) ?? m.set(k, []).get(k)).push(r.id); });
  return [...m.values()].filter(g => g.length > 1).map(g => g.sort().join(',')).sort();
}

await test('CLIP pass matches an all-pairs reference on 1,500 fake vectors at 0.95 and 0.98', () => {
  const { recs, vectorOf } = fakeClip(1500, 11);
  for (const min of [CLIP_DEFAULT_MIN, 0.98]) {
    const got = clipGroups(recs, vectorOf, { minCosine: min });
    assert.ok(got.every(g => g.kind === 'clip'));
    assert.deepEqual(canon(got), bruteClip(recs, vectorOf, min), `cosine ${min}`);
  }
});

await test('CLIP pass at the lowest slider value (0.92): no false pair, at least 99% of pairs found', () => {
  const { recs, vectorOf } = fakeClip(1500, 11);
  const got = clipGroups(recs, vectorOf, { minCosine: CLIP_MIN_LIMIT });
  const ref = new Set(bruteClip(recs, vectorOf, CLIP_MIN_LIMIT).flatMap(g => g.split(',')));
  const groupOf = new Map(); got.forEach((g, k) => g.ids.forEach(id => groupOf.set(id, k)));
  for (const g of got) for (const id of g.ids) assert.ok(ref.has(id), `${id} is grouped but has no pair at ${CLIP_MIN_LIMIT}`);
  let pairs = 0, found = 0;
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    if (clipCosine(vectorOf(recs[i].id), vectorOf(recs[j].id)) < CLIP_MIN_LIMIT) continue;
    pairs++;
    const a = groupOf.get(recs[i].id);
    if (a !== undefined && a === groupOf.get(recs[j].id)) found++;
  }
  console.log(`  ${found} of ${pairs} pairs at cosine ${CLIP_MIN_LIMIT} or more are grouped`);
  assert.ok(found / pairs >= 0.99);
});

await test('CLIP pass skips pairs already grouped by fingerprint, and trashed photos', () => {
  const dim = 16;
  const set = new VectorSet(dim);
  const v = (k, e = 0) => { const a = new Float32Array(dim); a[k] = 1; a[(k + 1) % dim] = e; return a; };
  set.set('a', v(0)); set.set('b', v(0, 0.05)); set.set('c', v(0, 0.1)); set.set('d', v(5)); set.set('e', v(5, 0.02)); set.set('t', v(9)); set.set('u', v(9, 0.01));
  const recs = ['a', 'b', 'c', 'd', 'e', 't', 'u'].map((id, i) => ({ id, w: 10, h: 10, mtime: i, trashed: id === 'u' ? '2026-01-01' : undefined }));
  const vectorOf = (id) => set.view(id);
  // a, b and c are all similar; a-b and d-e are already a dHash group.
  const exclude = [{ kind: 'near', key: 'a', ids: ['a', 'b'] }, { kind: 'near', key: 'd', ids: ['d', 'e'] }];
  assert.deepEqual(canon(clipGroups(recs, vectorOf, { exclude })), ['a,b,c']);
  assert.deepEqual(canon(clipGroups(recs, vectorOf)), ['a,b,c', 'd,e']);
  assert.deepEqual(canon(clipGroups(recs, vectorOf, { exclude: [{ ids: ['a', 'b', 'c'] }, { ids: ['d', 'e'] }] })), []);
  assert.deepEqual(clipGroups(recs.slice(0, 1), vectorOf), []);
  assert.deepEqual(canon(clipGroups(recs, (id) => (id === 'c' ? null : vectorOf(id)), { exclude })), []);
});

await test('CLIP pass on 20,000 vectors reports progress and gives the same groups async (time printed)', async () => {
  const { recs, vectorOf } = fakeClip(20000, 21);
  let ticks = 0;
  const t = performance.now();
  const a = await clipGroupsAsync(recs, vectorOf, { onProgress: () => ticks++ });
  const ms = performance.now() - t;
  console.log(`  20,000 vectors at cosine 0.95: ${Math.round(ms)} ms, ${a.length} groups`);
  assert.ok(ticks >= 20);
  assert.deepEqual(canon(a), canon(clipGroups(recs, vectorOf)));
  assert.ok(ms < 60000, `took ${Math.round(ms)} ms`);
});

console.log(`\n${passed} passed`);
