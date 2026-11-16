// Read text in photos (row X3, src/library/textindex.js) with a fake recogniser:
// search matches the text, the setting off queues no jobs, the text is stored per id in kv.
import assert from 'node:assert/strict';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord } from '../src/library/schema.js';
import { query } from '../src/library/query.js';
import { initTextIndex, TEXT_INDEX_KEY, TEXT_SETTING_KEY, textKey } from '../src/library/textindex.js';

const TEXT = { 'a.jpg': 'INVOICE 2047\nPaid', 'b.jpg': 'Goa beach shack menu', 'c.jpg': '' };

async function fakeScan(lib, root) {
  const upserts = root.files.map(f => newRecord(root.id, f.path, { size: f.size, lastModified: 1 }));
  await lib.applyScan(root.id, { upserts, seen: new Set(upserts.map(r => r.id)) });
}

async function makeLib(store = memoryStore()) {
  const lib = new Library({ store, services: { scanRoot: fakeScan }, saveDelay: 5 });
  lib.getFile = async (id) => ({ name: lib.get(id).name });
  const calls = [];
  const ti = initTextIndex(lib, {
    loadImage: async (file) => file.name,
    recognise: async (name) => { calls.push(name); return { text: TEXT[name] ?? '' }; },
    saveDelay: 1,
  });
  await lib.load();
  await ti.ready;
  const root = await lib.addRoot({ handle: null, name: 'P', files: [{ path: 'a.jpg', size: 10 }, { path: 'b.jpg', size: 20 }, { path: 'c.jpg', size: 30 }, { path: 'v.mp4', size: 40 }] });
  return { lib, ti, calls, store, root };
}

// 1. Opt-in off: a scan queues no ocr jobs and search finds nothing by text.
{
  const { lib, ti, calls } = await makeLib();
  await lib.jobs.idle();
  assert.equal(ti.enabled(), false);
  assert.equal(lib.jobs.status().kinds.ocr, undefined, 'no ocr jobs while the setting is off');
  assert.equal(calls.length, 0);
  assert.equal(lib.search({ q: 'invoice', textOf: lib.textOf }).length, 0);
}

// 2. Turning it on reads every photo (not the video), stores the text per id, and search matches it.
{
  const store = memoryStore();
  const { lib, ti, calls, root } = await makeLib(store);
  await ti.setEnabled(true);
  await lib.jobs.idle();
  await ti.flush();
  assert.deepEqual(calls.sort(), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.equal(await store.getKv(TEXT_SETTING_KEY), true);
  assert.equal((await store.getKv(textKey(`${root.id}/a.jpg`))).t, 'INVOICE 2047\nPaid');
  assert.equal((await store.getKv(textKey(`${root.id}/c.jpg`))).t, '', 'a photo with no text is stored as read');
  assert.equal(await store.getKv(TEXT_INDEX_KEY), undefined, 'no single whole-index value');
  assert.equal(ti.textOf(`${root.id}/b.jpg`), 'Goa beach shack menu');
  assert.equal(ti.count(), 3);

  const ids = (opts) => query(lib.records.values(), lib.choices, lib.albums, { textOf: lib.textOf, ...opts }).map(r => r.name);
  assert.deepEqual(ids({ q: 'invoice' }), ['a.jpg']);
  assert.deepEqual(ids({ q: 'shack menu' }), ['b.jpg'], 'every word must match');
  assert.deepEqual(ids({ q: 'invoice menu' }), []);
  assert.deepEqual(query(lib.records.values(), lib.choices, lib.albums, { q: 'invoice' }).length, 0, 'without textOf the search is unchanged');
  assert.deepEqual(ids({ q: 'a.jpg' }), ['a.jpg'], 'file names still match');

  // A second library on the same store loads the text and does not read again.
  const calls2 = [];
  const lib2 = new Library({ store, services: { scanRoot: fakeScan }, saveDelay: 5 });
  lib2.getFile = async (id) => ({ name: lib2.get(id).name });
  const ti2 = initTextIndex(lib2, { loadImage: async f => f.name, recognise: async (n) => { calls2.push(n); return { text: '' }; }, saveDelay: 1 });
  await lib2.load();
  await ti2.ready;
  await lib2.jobs.idle();
  assert.equal(ti2.enabled(), true);
  assert.equal(calls2.length, 0, 'stored text is not read again');
  assert.equal(ti2.textOf(`${root.id}/a.jpg`), 'INVOICE 2047\nPaid');

  // Turning it off cancels and queues nothing more; the stored text stays.
  await ti.setEnabled(false);
  await fakeScan(lib, { id: root.id, files: [{ path: 'd.jpg', size: 5 }, { path: 'a.jpg', size: 10 }, { path: 'b.jpg', size: 20 }, { path: 'c.jpg', size: 30 }] });
  await lib.jobs.idle();
  assert.equal(calls.length, 3, 'a new photo is not read while the setting is off');
  assert.equal(ti.textOf(`${root.id}/a.jpg`), 'INVOICE 2047\nPaid');

  await ti.forget();
  assert.equal(ti.count(), 0);
  assert.equal(await store.getKv(TEXT_INDEX_KEY), undefined);
  assert.equal(await store.getKv(textKey(`${root.id}/a.jpg`)), undefined, 'forget deletes the per-photo keys');
}

// 3. Read text for a selection runs with the setting off, and a changed file is read again.
{
  const { lib, ti, calls, root } = await makeLib();
  const a = `${root.id}/a.jpg`;
  assert.equal(ti.runFor([a, `${root.id}/v.mp4`]), 1, 'videos are skipped');
  await lib.jobs.idle();
  assert.deepEqual(calls, ['a.jpg']);
  assert.equal(ti.runFor([a]), 0, 'an unchanged photo is not read twice');
  await lib.patchRecords([{ id: a, size: 11 }]);
  assert.equal(ti.runFor([a]), 1, 'a changed photo is read again');
  await lib.jobs.idle();
  assert.equal(calls.length, 2);
}

console.log('Slate library text index: PASS');
