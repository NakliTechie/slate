// Review 2026-11-17, S13: face rows leave with their photos (Empty trash, Remove folder, a
// full scan that finds the file missing), and "Delete all face data" says when another tab
// blocks the delete. Uses a fake library so it needs no model.
import assert from 'node:assert/strict';
import { initFaces, memoryFaceStore } from '../src/library/faces.js';
import { JobQueue } from '../src/library/jobs.js';
import { memoryStore } from '../src/library/store.js';
import { visibleRows } from '../src/ui/library/people.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok -', name); }

function fakeLib() {
  const handlers = new Map();
  const records = new Map();
  return {
    records, roots: new Map(), store: memoryStore(), jobs: new JobQueue({ concurrency: 2 }), services: {},
    get: (id) => records.get(id) ?? null,
    choice: () => ({}),
    on(t, fn) { (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(fn); },
    emit(t, d) { for (const fn of handlers.get(t) ?? []) fn(d); },
    async getFile(id) { return { id }; },
  };
}
const vec = Float32Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
const detector = { async detect() { return { faces: [{ box: [0.1, 0.1, 0.2, 0.2], landmarks: new Array(10).fill(0.3), score: 0.9, vector: vec }], w: 400, h: 300 }; }, stop() {} };

async function setup(n = 6) {
  const lib = fakeLib();
  for (let i = 0; i < n; i++) {
    const root = i < 4 ? 'a' : 'b';
    const id = `${root}/p${i}.jpg`;
    lib.records.set(id, { id, rootId: root, name: `p${i}.jpg`, kind: 'photo', size: 10, mtime: 1, time: i });
  }
  const fstore = memoryFaceStore();
  const faces = initFaces(lib, { faceStore: fstore, detector, readSidecar: async () => null });
  await faces.ready;
  await faces.setEnabled(true);
  await lib.jobs.idle();
  faces._recluster();
  return { lib, faces, fstore };
}
const storedIds = async (fstore) => (await fstore.allPhotos()).map(p => p.photoId).sort();

await test('Empty trash deletes the face rows of the emptied photos', async () => {
  const { lib, faces, fstore } = await setup();
  assert.equal((await storedIds(fstore)).length, 6);
  lib.records.delete('a/p0.jpg'); lib.records.delete('a/p1.jpg');
  lib.emit('records', { ids: ['a/p0.jpg', 'a/p1.jpg'], reason: 'empty-trash' });
  await faces.settled();
  assert.deepEqual(await storedIds(fstore), ['a/p2.jpg', 'a/p3.jpg', 'b/p4.jpg', 'b/p5.jpg']);
  assert.deepEqual(faces.facesIn('a/p0.jpg'), []);
  faces._recluster();
  for (const p of faces.people({ hidden: true })) assert.ok(!faces.photosOf(p.id).includes('a/p0.jpg'));
});

await test('Remove folder deletes every face row of that folder', async () => {
  const { lib, faces, fstore } = await setup();
  for (const id of [...lib.records.keys()]) if (id.startsWith('b/')) lib.records.delete(id);
  lib.emit('records', { ids: null, reason: 'remove-root' });
  await faces.settled();
  assert.deepEqual(await storedIds(fstore), ['a/p0.jpg', 'a/p1.jpg', 'a/p2.jpg', 'a/p3.jpg']);
  // Removing the last folder empties the table too.
  lib.records.clear();
  lib.emit('records', { ids: null, reason: 'remove-root' });
  await faces.settled();
  assert.deepEqual(await storedIds(fstore), []);
});

await test('A full scan that finds a file missing deletes its face rows; a move drops the old id', async () => {
  const { lib, faces, fstore } = await setup();
  lib.records.get('a/p2.jpg').missing = true;
  lib.emit('records', { ids: ['a/p2.jpg'], reason: 'scan' });
  lib.records.delete('a/p3.jpg');
  lib.records.set('a/moved.jpg', { id: 'a/moved.jpg', rootId: 'a', name: 'moved.jpg', kind: 'photo', size: 10, mtime: 1, time: 3 });
  lib.emit('records', { ids: ['a/p3.jpg', 'a/moved.jpg'], reason: 'move' });
  await faces.settled();
  await lib.jobs.idle();
  const ids = await storedIds(fstore);
  assert.ok(!ids.includes('a/p2.jpg') && !ids.includes('a/p3.jpg'));
  assert.ok(ids.includes('a/moved.jpg'), 'the moved photo is looked at again under its new id');
});

await test('An emptied index (a load with no records) deletes no face rows', async () => {
  const { lib, faces, fstore } = await setup();
  const keep = new Map(lib.records);
  lib.records.clear();
  lib.emit('records', { ids: null, reason: 'load' });
  await faces.settled();
  assert.equal((await storedIds(fstore)).length, 6);
  for (const [k, v] of keep) lib.records.set(k, v);
});

await test('"Delete all face data" reports a delete that another tab blocks', async () => {
  const { faces } = await setup(2);
  assert.deepEqual(await faces.deleteAll(), { blocked: false, error: null });
  const lib = fakeLib();
  const blocked = { ...memoryFaceStore(), async destroy() { return { blocked: true }; } };
  const f2 = initFaces(lib, { faceStore: blocked, detector, readSidecar: async () => null });
  await f2.ready;
  assert.equal((await f2.deleteAll()).blocked, true);
});

await test('S15: the person page draws only the visible rows', () => {
  // 20,000 photos in 6 columns of 124 px rows; the panel shows 800 px from 50,000 px down.
  const r = visibleRows({ count: 20000, cols: 6, rowH: 120, gap: 4, top: 50000, height: 800 });
  assert.equal(r.rows, 3334);
  assert.ok(r.last - r.first + 1 <= 12, `${r.last - r.first + 1} rows drawn`);
  assert.ok(r.offset <= 50000 && r.offset + (r.last - r.first + 1) * 124 >= 50800);
  const above = visibleRows({ count: 20000, cols: 6, rowH: 120, gap: 4, top: -2000, height: 800 });
  assert.equal(above.last, above.first - 1, 'a grid far below the visible area draws no row');
  const near = visibleRows({ count: 20000, cols: 6, rowH: 120, gap: 4, top: -100, height: 800 });
  assert.ok(near.first === 0 && near.last <= 7, 'a grid that starts in view draws its first rows');
  assert.equal(visibleRows({ count: 0, cols: 6, rowH: 120, gap: 4, top: 0, height: 800 }).total, 0);
});

console.log(`test-review-c-faces: ${passed} passed`);
