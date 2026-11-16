// Review S15 (text index): text read from photos is stored one kv key per photo, so a save
// writes only the photos read since the last save, never one value holding the whole index.
import assert from 'node:assert/strict';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord } from '../src/library/schema.js';
import { initTextIndex, TEXT_INDEX_KEY, textKey } from '../src/library/textindex.js';

function spyStore() {
  const s = memoryStore();
  const writes = [];
  const set = s.setKv.bind(s);
  s.setKv = async (k, v) => { writes.push(k); return set(k, v); };
  return { store: s, writes };
}
async function fakeScan(lib, root) {
  const upserts = root.files.map(f => newRecord(root.id, f.path, { size: f.size, lastModified: 1 }));
  await lib.applyScan(root.id, { upserts, seen: new Set(upserts.map(r => r.id)) });
}
async function makeLib(store, n) {
  const lib = new Library({ store, services: { scanRoot: fakeScan }, saveDelay: 5 });
  lib.getFile = async (id) => ({ name: lib.get(id).name });
  const ti = initTextIndex(lib, { loadImage: async f => f.name, recognise: async (name) => ({ text: `text of ${name}` }), saveDelay: 10_000 });
  await lib.load();
  await ti.ready;
  const files = Array.from({ length: n }, (_, i) => ({ path: `p${i}.jpg`, size: i + 1 }));
  const root = await lib.addRoot({ handle: null, name: 'P', files });
  await ti.ready;
  return { lib, ti, root };
}

{
  const { store, writes } = spyStore();
  const { lib, ti, root } = await makeLib(store, 50);
  const id = (i) => `${root.id}/p${i}.jpg`;

  ti.runFor([id(0), id(1)]);
  await lib.jobs.idle();
  writes.length = 0;
  await ti.flush();
  assert.deepEqual(writes.sort(), [textKey(id(0)), textKey(id(1))], 'the save touches one key per photo read');

  ti.runFor([id(7)]);
  await lib.jobs.idle();
  writes.length = 0;
  await ti.flush();
  assert.deepEqual(writes, [textKey(id(7))], 'the next save writes only the new photo');
  writes.length = 0;
  await ti.flush();
  assert.deepEqual(writes, [], 'nothing read, nothing written');
  assert.equal(await store.getKv(TEXT_INDEX_KEY), undefined, 'no whole-index value');

  // A second library on the same store finds the text by record.
  const lib2 = new Library({ store, services: { scanRoot: fakeScan }, saveDelay: 5 });
  const ti2 = initTextIndex(lib2, { loadImage: async f => f, recognise: async () => ({ text: '' }), saveDelay: 10_000 });
  await lib2.load();
  await ti2.ready;
  assert.equal(ti2.textOf(id(7)), 'text of p7.jpg');
  assert.equal(ti2.count(), 3);
}

// An older single-object index is split into per-photo keys once, then deleted.
{
  const { store } = spyStore();
  await store.setKv(TEXT_INDEX_KEY, { 'r/x.jpg': { t: 'old text', s: '1:1' } });
  const lib = new Library({ store, saveDelay: 5 });
  const ti = initTextIndex(lib, { loadImage: async f => f, recognise: async () => ({ text: '' }) });
  await lib.load();
  await ti.ready;
  assert.equal(ti.textOf('r/x.jpg'), 'old text');
  assert.deepEqual(await store.getKv(textKey('r/x.jpg')), { t: 'old text', s: '1:1' });
  assert.equal(await store.getKv(TEXT_INDEX_KEY), undefined);
}

console.log('review d2 text index (S15): PASS');
