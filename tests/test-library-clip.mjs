// Search by meaning (rows Q2, Q3): Int8 vector packing and its error, brute-force
// top-k against a float reference, the latency at 100,000 vectors, and the
// service with a fake embedder: indexing, search, similar, reload, invalidation
// on a model change, and turning it off.
import assert from 'node:assert/strict';
import { VectorSet, packVectors, unpackVectors, topK, quantise, normalise, createClip, modelKey, SETTING_KEY, VECTORS_PREFIX, DIM, WEIGHTS } from '../src/library/clip.js';
import { memoryStore } from '../src/library/store.js';
import { JobQueue } from '../src/library/jobs.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function randomUnit(r, dim = DIM) { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = gauss(r); return normalise(v); }
const dotF = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

await test('Int8 quantisation keeps each vector within cosine 0.9995 and components within half a step', () => {
  const r = rng(1);
  const out = new Int8Array(DIM);
  for (let t = 0; t < 200; t++) {
    const v = randomUnit(r);
    const inv = quantise(v, out);
    const back = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) back[i] = out[i] * inv;
    assert.ok(dotF(v, back) >= 0.9995, `cosine ${dotF(v, back)}`);
    let max = 0; for (const x of v) max = Math.max(max, Math.abs(x));
    const step = max / 127;
    for (let i = 0; i < DIM; i++) assert.ok(Math.abs(out[i] * step - v[i]) <= step / 2 + 1e-7);
  }
  assert.equal(quantise(new Float32Array(DIM), out), 0);
});

await test('cosine from Int8 vectors stays within 0.01 of the float cosine', () => {
  const r = rng(2);
  const set = new VectorSet(DIM);
  const vs = [];
  for (let i = 0; i < 300; i++) { const v = randomUnit(r); vs.push(v); set.set(`r/${i}`, v); }
  const q = randomUnit(r);
  const hits = topK([set], q, { k: 300 });
  for (const h of hits) {
    const i = Number(h.id.slice(2));
    assert.ok(Math.abs(h.score - dotF(q, vs[i])) < 0.01, `${h.id}: ${h.score} vs ${dotF(q, vs[i])}`);
  }
});

await test('pack and unpack round-trip ids and bytes, compacting deleted slots', () => {
  const r = rng(3);
  const set = new VectorSet(DIM);
  for (let i = 0; i < 100; i++) set.set(`root/p${i}.jpg`, randomUnit(r));
  for (let i = 0; i < 100; i += 3) set.delete(`root/p${i}.jpg`);
  set.set('root/new.jpg', randomUnit(r)); // reuses a freed slot
  const bytes = packVectors(set, 'model-a');
  const back = unpackVectors(bytes, 'model-a');
  assert.equal(back.size, set.size);
  assert.deepEqual([...back.slot.keys()].sort(), [...set.slot.keys()].sort());
  for (const id of set.slot.keys()) {
    const a = set.view(id), b = back.view(id);
    assert.deepEqual([...b.q], [...a.q]);
    assert.equal(b.inv, a.inv);
  }
  // a slice of a bigger buffer (as IndexedDB may hand back) also reads
  const padded = new Uint8Array(bytes.length + 3); padded.set(bytes, 3);
  assert.equal(unpackVectors(padded.subarray(3), 'model-a').size, set.size);
});

await test('a blob from another model, or not a blob, unpacks to null', () => {
  const set = new VectorSet(DIM); set.set('a', randomUnit(rng(4)));
  const bytes = packVectors(set, modelKey('q8'));
  assert.ok(unpackVectors(bytes, modelKey('q8')));
  assert.equal(unpackVectors(bytes, modelKey('fp16')), null);
  assert.equal(unpackVectors(bytes, 'openai/other'), null);
  assert.equal(unpackVectors(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), modelKey('q8')), null);
  assert.equal(unpackVectors(null, modelKey('q8')), null);
  assert.equal(unpackVectors(bytes.subarray(0, bytes.length - 10), modelKey('q8')), null);
});

await test('top-k matches a brute-force float reference over three roots', () => {
  const r = rng(5);
  const sets = [new VectorSet(DIM), new VectorSet(DIM), new VectorSet(DIM)];
  for (let i = 0; i < 6000; i++) sets[i % 3].set(`r${i % 3}/${i}`, randomUnit(r));
  sets[1].delete('r1/1'); sets[2].delete('r2/5');
  const q = randomUnit(r);
  const skip = new Set(['r0/0', 'r0/3']);
  const ref = [];
  for (const s of sets) for (const id of s.slot.keys()) if (!skip.has(id)) ref.push({ id, score: dotF(normalise(q), s.vector(id)) });
  ref.sort((a, b) => b.score - a.score);
  const got = topK(sets, q, { k: 200, skip });
  assert.equal(got.length, 200);
  assert.deepEqual(got.map(h => h.id), ref.slice(0, 200).map(h => h.id));
  got.forEach((h, i) => assert.ok(Math.abs(h.score - ref[i].score) < 1e-5));
  const min = ref[50].score;
  assert.deepEqual(topK(sets, q, { k: 200, min, skip }).map(h => h.id), ref.filter(h => h.score >= min).map(h => h.id));
  assert.equal(topK(sets, q, { k: 200, skip }).some(h => skip.has(h.id)), false);
});

await test('brute-force search over 100,000 vectors (latency gate, printed)', () => {
  const r = rng(6);
  const set = new VectorSet(DIM, 100000);
  const v = new Float32Array(DIM);
  for (let i = 0; i < 100000; i++) { for (let j = 0; j < DIM; j++) v[j] = r() - 0.5; set.set(`r/${i}`, v); }
  const q = randomUnit(r);
  topK([set], q, { k: 200, min: 0 }); // warm-up
  const t = performance.now();
  const runs = 5;
  for (let i = 0; i < runs; i++) topK([set], q, { k: 200, min: 0.05 });
  const ms = (performance.now() - t) / runs;
  console.log(`  100,000 x ${DIM} Int8 vectors: ${ms.toFixed(1)} ms per search in Node`);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

// ── the service with a fake embedder ──────────────────────────────────────

function fakeLib(records, store) {
  const handlers = new Map();
  return {
    store,
    jobs: new JobQueue({ concurrency: 4 }),
    records: new Map(records.map(r => [r.id, r])),
    roots: new Map([['r', { id: 'r' }], ['s', { id: 's' }]]),
    services: {},
    get(id) { return this.records.get(id); },
    on(t, fn) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(fn); },
    emit(t, d) { for (const fn of handlers.get(t) ?? []) fn(d); },
  };
}
const vecOf = (id) => randomUnit(rng([...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)));
function fakeEmbedder() {
  const e = {
    images: 0, inits: 0,
    async init() { e.inits++; return 'wasm'; },
    async image(blob) { e.images++; return vecOf(blob.id); },
    async text(t) { const v = vecOf(t.replace(/^about /, '')); const n = randomUnit(rng(9)); for (let i = 0; i < DIM; i++) v[i] += 0.05 * n[i]; return v; },
  };
  return e;
}
const records = () => [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `r/p${i}.jpg`, rootId: 'r', thumb: 'ok' })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `s/q${i}.jpg`, rootId: 's', thumb: 'ok' })),
  { id: 'r/nothumb.jpg', rootId: 'r', thumb: 'fail' },
  { id: 'r/gone.jpg', rootId: 'r', thumb: 'ok', missing: true },
];
const readThumb = async (id) => ({ id });
const settle = async (lib, clip) => { await lib.jobs.idle(); await new Promise(r => setTimeout(r, 0)); await lib.jobs.idle(); await clip.flush(); };

await test('turning on indexes every photo with a thumbnail, then search and similar rank by cosine', async () => {
  const store = memoryStore();
  const lib = fakeLib(records(), store);
  const emb = fakeEmbedder();
  const clip = createClip(lib, { embedder: emb, readThumb });
  await clip.load();
  assert.equal(clip.enabled(), false);
  assert.equal(emb.inits, 0, 'nothing loads before the person turns it on');
  await clip.enable('q8');
  await settle(lib, clip);
  assert.equal(clip.count(), 50);
  assert.equal(emb.images, 50);
  assert.deepEqual(await store.getKv(SETTING_KEY), { on: true, dtype: 'q8' });
  assert.ok(await store.getKv(VECTORS_PREFIX + 'r'));
  assert.ok(await store.getKv(VECTORS_PREFIX + 's'));
  const hits = await clip.searchText('about s/q3.jpg');
  assert.equal(hits[0].id, 's/q3.jpg');
  assert.ok(hits.length <= 200 && hits.every(h => h.score >= 0.2));
  const sim = clip.similar('r/p7.jpg', { min: -1 });
  assert.equal(sim.length, 49);
  assert.equal(sim.some(h => h.id === 'r/p7.jpg'), false);
  for (let i = 1; i < sim.length; i++) assert.ok(sim[i - 1].score >= sim[i].score);
  assert.ok(clip.sizeBytes() > 50 * DIM);
});

await test('vectors reload without new embedding; a different model key discards them', async () => {
  const store = memoryStore();
  const lib = fakeLib(records(), store);
  const first = createClip(lib, { embedder: fakeEmbedder(), readThumb });
  await first.enable('q8');
  await settle(lib, first);

  const lib2 = fakeLib(records(), store);
  const emb2 = fakeEmbedder();
  const again = createClip(lib2, { embedder: emb2, readThumb });
  await again.load();
  await settle(lib2, again);
  assert.equal(again.count(), 50);
  assert.equal(emb2.images, 0);

  // A blob stored by another model is deleted on load and every photo is embedded again.
  const set = unpackVectors(await store.getKv(VECTORS_PREFIX + 'r'), modelKey('q8'));
  await store.setKv(VECTORS_PREFIX + 'r', packVectors(set, 'Xenova/some-other-model@abc:q8'));
  const lib3 = fakeLib(records(), store);
  const emb3 = fakeEmbedder();
  const third = createClip(lib3, { embedder: emb3, readThumb });
  await third.load();
  await settle(lib3, third);
  assert.equal(emb3.images, 40, 'only root r is embedded again');
  assert.ok(unpackVectors(await store.getKv(VECTORS_PREFIX + 'r'), modelKey('q8')));

  // Switching weights changes the model key, so every vector is made again.
  const emb4 = fakeEmbedder();
  const lib4 = fakeLib(records(), store);
  const fourth = createClip(lib4, { embedder: emb4, readThumb });
  await fourth.load();
  await fourth.enable('fp16');
  await settle(lib4, fourth);
  assert.equal(emb4.images, 50);
  assert.equal(unpackVectors(await store.getKv(VECTORS_PREFIX + 's'), modelKey('q8')), null);
  assert.ok(unpackVectors(await store.getKv(VECTORS_PREFIX + 's'), modelKey('fp16')));
});

await test('new thumbnails get vectors, deleted records drop out on save, and turning off deletes everything', async () => {
  const store = memoryStore();
  const lib = fakeLib(records(), store);
  const clip = createClip(lib, { embedder: fakeEmbedder(), readThumb });
  await clip.enable('q8');
  await settle(lib, clip);
  lib.records.get('r/nothumb.jpg').thumb = 'ok';
  await clip.index(['r/nothumb.jpg']);
  await settle(lib, clip);
  assert.ok(clip.has('r/nothumb.jpg'));
  lib.records.delete('r/p0.jpg');
  lib.emit('records', { ids: ['r/p0.jpg'], reason: 'empty-trash' });
  assert.equal(clip.has('r/p0.jpg'), false);
  assert.equal(clip.similar('r/p1.jpg', { min: -1 }).some(h => h.id === 'r/p0.jpg'), false);
  await clip.flush();
  const stored = unpackVectors(await store.getKv(VECTORS_PREFIX + 'r'), modelKey('q8'));
  assert.equal(stored.has('r/p0.jpg'), false);
  assert.equal(stored.size, 40);
  await clip.disable();
  assert.equal(clip.enabled(), false);
  assert.equal(clip.count(), 0);
  assert.equal(await store.getKv(SETTING_KEY), undefined);
  assert.equal(await store.getKv(VECTORS_PREFIX + 'r'), undefined);
  assert.equal(await store.getKv(VECTORS_PREFIX + 's'), undefined);
  await assert.rejects(() => clip.searchText('x'), /off/);
});

await test('download sizes are stated for both weight types', () => {
  assert.ok(WEIGHTS.q8.bytes > 150e6 && WEIGHTS.q8.bytes < 160e6);
  assert.ok(WEIGHTS.fp16.bytes > 300e6 && WEIGHTS.fp16.bytes < 310e6);
});

console.log(`\n${passed} passed`);
