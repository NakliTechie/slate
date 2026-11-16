// Defects seen while recording the photo-library promo videos (items 1, 2, 3, 6):
// job lanes, self-writes and partial rescans, XMP for hidden-only changes, failure counts.
import assert from 'node:assert/strict';
import { JobQueue } from '../src/library/jobs.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { makeId } from '../src/library/schema.js';
import { scanRoot } from '../src/library/scan.js';
import { initWatch } from '../src/library/watch.js';
import { initXmpWrite } from '../src/library/xmpwrite.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const named = (name, message = name) => Object.assign(new Error(message), { name });
const file = (name, bytes = 'x', mtime = 1000) => new File([bytes], name, { lastModified: mtime });

// A folder tree that reports its changes to fs.fire(parts, type), as FileSystemObserver would.
function fakeFs(tree) {
  const fs = { tree, bad: new Set(), listeners: new Set(), fire(parts, type) { for (const l of fs.listeners) l([{ type, relativePathComponents: parts }]); } };
  const fileH = (t, n, prefix) => ({
    kind: 'file', name: n,
    async getFile() {
      if (!(t[n] instanceof File)) throw named('NotFoundError');
      if (fs.bad.has([...prefix, n].join('/'))) throw new Error('cannot decode this file');
      return t[n];
    },
    async createWritable() {
      let buf = '';
      return { async write(x) { buf += x; }, async close() { t[n] = file(n, buf, Date.now()); fs.fire([...prefix, n], 'modified'); }, async abort() {} };
    },
  });
  const dir = (t, name, prefix) => ({
    kind: 'directory', name,
    async *entries() { for (const [n, v] of Object.entries(t)) yield [n, v instanceof File ? fileH(t, n, prefix) : dir(v, n, [...prefix, n])]; },
    async getDirectoryHandle(n) {
      if (!(n in t)) throw named('NotFoundError');
      if (t[n] instanceof File) throw named('TypeMismatchError');
      return dir(t[n], n, [...prefix, n]);
    },
    async getFileHandle(n, { create = false } = {}) {
      if (!(n in t)) {
        if (!create) throw named('NotFoundError');
        t[n] = file(n, '', Date.now());
        fs.fire([...prefix, n], 'appeared');
      } else if (!(t[n] instanceof File)) throw named('TypeMismatchError');
      return fileH(t, n, prefix);
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  });
  fs.handle = dir(tree, 'Photos', []);
  return fs;
}

function makeLib(fs, services = {}) {
  const thumbs = { enqueue() {}, async remove() {}, async clear() {}, async url() { return null; } };
  const persist = { async load() { return null; }, async save() {}, canWrite: () => true };
  const lib = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist, ...services }, saveDelay: 5 });
  return lib;
}

// ── 1. job lanes: a 'now' job does not wait behind 500 background jobs ──────────
{
  const q = new JobQueue({ concurrency: 4 });
  const order = [];
  let bgDone = 0;
  q.add('ocr', Array.from({ length: 500 }, (_, i) => i), async () => { await tick(1); bgDone++; });
  await tick(5);
  let startedAfter = null;
  q.add('thumbs', ['t1'], async () => { startedAfter = bgDone; order.push('now'); });
  await tick(5);
  assert.notEqual(startedAfter, null, 'the now job has started');
  assert.ok(startedAfter < 100, `the now job started after ${startedAfter} of 500 background jobs, not after the queue drained`);
  const s = q.status();
  assert.ok(s.kinds.ocr.done < 500, 'background work is still queued');
  assert.equal(s.kinds.thumbs.done, 1, 'status still reports per kind');
  await q.idle();
  assert.equal(q.status().kinds.ocr.done, 500);

  // Background work runs only when 'now' is empty, and never takes the last slot.
  const q2 = new JobQueue({ concurrency: 4 });
  let bgRunning = 0, bgMax = 0, nowWhileBg = 0;
  q2.pause();
  q2.add('scan', [1, 2, 3, 4, 5, 6], async () => { if (bgRunning) nowWhileBg++; await tick(2); });
  q2.add('clip', Array.from({ length: 20 }, (_, i) => i), async () => { bgRunning++; bgMax = Math.max(bgMax, bgRunning); await tick(2); bgRunning--; });
  q2.add('dupes', [1], async () => {}, { lane: 'now' });
  assert.throws(() => q2.add('x', [1], async () => {}, { lane: 'later' }), /no job lane/);
  q2.resume();
  await q2.idle();
  assert.equal(nowWhileBg, 0, 'no background job starts while now work is pending');
  assert.equal(bgMax, 3, 'background jobs use at most concurrency - 1 slots');
  console.log('ok 1: a now job starts before 500 background jobs drain; lanes by kind or by option');
}

// ── 2 and 3. Slate's own XMP writes cause no rescan; external files rescan their path only ──
{
  const LABELLED = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4" xmp:Label="Red"/></rdf:RDF></x:xmpmeta>`;
  const tree = { trip: {} };
  for (let i = 1; i <= 8; i++) tree[`a${i}.jpg`] = file(`a${i}.jpg`);
  tree['a8.jpg.xmp'] = file('a8.jpg.xmp', LABELLED);
  for (let i = 1; i <= 3; i++) tree.trip[`t${i}.jpg`] = file(`t${i}.jpg`);
  const fs = fakeFs(tree);
  const lib = makeLib(fs);
  const root = await lib.addRoot({ handle: fs.handle, name: 'Photos' });
  const id = (p) => makeId(root.id, p);
  const xmp = initXmpWrite(lib, { delay: 5 });
  await xmp.ready;
  await xmp.setEnabled(true);

  class FakeObserver {
    constructor(cb) { this.cb = cb; }
    async observe() { fs.listeners.add(this.cb); }
    disconnect() { fs.listeners.delete(this.cb); }
  }
  const w = initWatch(lib, { Observer: FakeObserver, delay: 20 });
  await w.ready;
  const rescans = [], scans = [];
  const rescan = lib.rescan.bind(lib);
  lib.rescan = (rootId, o) => { rescans.push(o?.paths ?? 'whole'); return rescan(rootId, o); };
  lib.services.scanRoot = (l, r, o) => { scans.push(o.paths ?? 'whole'); return scanRoot(l, r, o); };

  for (let i = 1; i <= 6; i++) await lib.setRating([id(`a${i}.jpg`)], 3);
  assert.equal(await xmp.flush(), 6, 'six sidecars written');
  await tick(60);
  assert.deepEqual(rescans, [], 'six ratings with XMP writing on cause no rescan');
  assert.match(await tree['a1.jpg.xmp'].text(), /<xmp:Rating>3<\/xmp:Rating>/);

  // 3. Hidden-only changes write nothing; a photo with nothing to carry gets no new sidecar.
  await lib.setHidden([id('a7.jpg'), id('a1.jpg'), id('a8.jpg')], true);
  await lib.setFavourite([id('a7.jpg')], true);
  assert.equal(await xmp.flush(), 0, 'hiding or making a favourite writes no sidecar');
  assert.ok(!('a7.jpg.xmp' in tree), 'a hidden photo with no rating, label or tags gets no sidecar');
  assert.equal(await tree['a8.jpg.xmp'].text(), LABELLED, 'an existing sidecar is not rewritten for a hidden-only change');
  await lib.setFlag([id('a7.jpg')], 'pick');
  assert.equal(await xmp.flush(), 0, 'a pick alone gives no new sidecar (XMP carries only reject)');
  await lib.tag([id('a8.jpg')], { add: ['sea'] });
  assert.equal(await xmp.flush(), 1);
  const a8 = await tree['a8.jpg.xmp'].text();
  assert.match(a8, /<xmp:Rating>4<\/xmp:Rating>/, 'the written sidecar holds the real rating');
  assert.match(a8, /<xmp:Label>Red<\/xmp:Label>/, 'and keeps the label');
  assert.match(a8, /<rdf:li>sea<\/rdf:li>/, 'and the tags');
  await tick(60);
  assert.deepEqual(rescans, [], 'still no rescan');

  // An external new file rescans that path only.
  const before = lib.jobs.status().kinds.scan.total;
  tree['new.jpg'] = file('new.jpg', 'y', 5000);
  fs.fire(['new.jpg'], 'appeared');
  await tick(60);
  await lib.scanning?.get(root.id);
  assert.deepEqual(rescans, [['new.jpg']], 'one rescan, of the new path');
  assert.equal(lib.jobs.status().kinds.scan.total - before, 1, 'one scan job, for the new file only');
  assert.ok(lib.get(id('new.jpg')), 'the new file is in the library');

  // A removed file turns missing; the rest of the root stays as it was.
  delete tree.trip['t2.jpg'];
  fs.fire(['trip', 't2.jpg'], 'disappeared');
  await tick(60);
  await lib.scanning?.get(root.id);
  assert.equal(lib.get(id('trip/t2.jpg')).missing, true, 'the removed file is missing');
  assert.equal(!!lib.get(id('trip/t1.jpg')).missing, false);
  assert.equal(lib.jobs.status().kinds.scan.total - before, 1, 'the removal read no file');

  // An external sidecar edit rescans its photo; an unknown change rescans the whole root.
  tree['a2.jpg.xmp'] = file('a2.jpg.xmp', LABELLED.replace('Rating="4"', 'Rating="5"'), 9000);
  await tick(5100); // past the self-write window for a2's own sidecar
  fs.fire(['a2.jpg.xmp'], 'modified');
  await tick(60);
  await lib.scanning?.get(root.id);
  assert.deepEqual(rescans.at(-1), ['a2.jpg.xmp']);
  assert.equal(lib.get(id('a2.jpg')).xmpRating, 5, 'the photo was read again with its sidecar');
  fs.listeners.forEach(l => l([{ type: 'unknown' }]));
  await tick(60);
  await lib.scanning?.get(root.id);
  assert.equal(rescans.at(-1), 'whole', 'an unknown change rescans the whole root');
  assert.equal(scans.at(-1), 'whole');
  w.stop();
  console.log('ok 2: six XMP-writing ratings cause no rescan; one new file scans that path only');
  console.log('ok 3: hidden-only changes write no sidecar; a written one holds rating, label and tags');
}

// ── 6. files trashed while their rescan jobs wait are not failures ──────────────
{
  const tree = {};
  for (let i = 1; i <= 14; i++) tree[`p${i}.jpg`] = file(`p${i}.jpg`);
  const fs = fakeFs(tree);
  fs.bad.add('p13.jpg'); fs.bad.add('p14.jpg');
  const trashDir = {};
  tree['.slate-trash'] = trashDir;
  const trash = {
    async move(root, path) { trashDir[path] = tree[path]; delete tree[path]; return {}; },
    async restore() { return {}; }, async purge() {},
  };
  const lib = makeLib(fs, { trash });
  lib.recoverTrash = undefined;
  const root = await lib.addRoot({ handle: fs.handle, name: 'Photos' });
  assert.equal(lib.jobs.status().kinds.scan.failed, 2, 'the first scan finds the two unreadable files');
  lib.jobs.reset();

  for (let i = 1; i <= 12; i++) tree[`p${i}.jpg`] = file(`p${i}.jpg`, 'changed', 2000);
  lib.jobs.pause();
  const scanning = lib.rescan(root.id);
  for (let k = 0; k < 50 && !(lib.jobs.status().pending >= 14); k++) await tick(1);
  assert.equal(lib.jobs.status().pending, 14, 'the rescan jobs are queued');
  const res = await lib.trash(Array.from({ length: 12 }, (_, i) => makeId(root.id, `p${i + 1}.jpg`)));
  assert.equal(res.changed, 12);
  lib.jobs.resume();
  await scanning;
  await lib.jobs.idle();
  const s = lib.jobs.status().kinds.scan;
  assert.equal(s.failed, 2, `failed stays at the 2 real failures, not ${s.failed}`);
  assert.equal(s.done, 12);
  assert.equal(lib.jobs.status().failed, 2, 'the status count reports only real read failures');
  console.log('ok 6: 12 files trashed while their rescan jobs wait are not failures');
}

console.log('test-promo-a-jobs-watch: all passed');
