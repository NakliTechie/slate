// Writing XMP sidecars (M5) and exporting originals (I4): buildXmp round-trips
// through parseXmp, keeps other properties, writes -1 for a reject; the write
// path and the export copy run against a fake FileSystemDirectoryHandle tree.
import assert from 'node:assert/strict';
import { buildXmp, parseXmp } from '../src/library/xmp.js';
import { initXmpWrite, XMP_SETTING_KEY } from '../src/library/xmpwrite.js';
import { exportFiles, uniqueName, albumExportIds } from '../src/library/export.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord, makeId } from '../src/library/schema.js';

// ── a fake FileSystemDirectoryHandle tree (as in test-library-organise.mjs) ──
const err = (name) => Object.assign(new Error(name), { name });
class FakeFile {
  constructor(name, data, dir) { this.kind = 'file'; this.name = name; this.data = data; this.dir = dir; this.writes = 0; }
  async getFile() { const d = this.data, n = this.name; return { name: n, size: d.length, lastModified: 1000, async text() { return d; } }; }
  async createWritable() {
    if (this.dir.readOnly) throw err('NotAllowedError');
    let buf = '';
    return { write: async (x) => { buf += typeof x === 'string' ? x : await x.text(); }, close: async () => { this.data = buf; this.writes++; } };
  }
}
class FakeDir {
  constructor(name, perm = 'granted') { this.kind = 'directory'; this.name = name; this.entriesMap = new Map(); this.perm = perm; }
  async queryPermission() { return this.perm; }
  async getDirectoryHandle(n, { create = false } = {}) {
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'directory') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const d = new FakeDir(n); this.entriesMap.set(n, d); return d;
  }
  async getFileHandle(n, { create = false } = {}) {
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'file') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const f = new FakeFile(n, '', this); this.entriesMap.set(n, f); return f;
  }
  async removeEntry(n) { if (!this.entriesMap.delete(n)) throw err('NotFoundError'); }
  async *entries() { for (const e of [...this.entriesMap]) yield e; }
  put(path, data = 'x') {
    const parts = path.split('/'); const name = parts.pop(); let d = this;
    for (const p of parts) { if (!d.entriesMap.has(p)) d.entriesMap.set(p, new FakeDir(p)); d = d.entriesMap.get(p); }
    d.entriesMap.set(name, new FakeFile(name, data, d));
  }
  node(path) { let d = this; for (const p of path.split('/')) { d = d?.entriesMap?.get(p); } return d ?? null; }
  has(path) { return !!this.node(path); }
  read(path) { return this.node(path).data; }
}

// ── buildXmp ────────────────────────────────────────────────────────────────
{
  const text = buildXmp({ rating: 4, label: 'Red', tags: ['trips/goa', 'beach', 'Tom & Jerry', 'trips/goa'] });
  const x = parseXmp(text);
  assert.equal(x.rating, 4);
  assert.equal(x.label, 'Red');
  assert.deepEqual(x.tags, ['trips/goa', 'beach', 'Tom & Jerry'], 'round trip: hierarchy kept, duplicates dropped, entities decoded');
  assert.match(text, /<rdf:li>trips\|goa<\/rdf:li>/, 'lr:hierarchicalSubject uses |');
  assert.match(text, /<dc:subject>[\s\S]*<rdf:Bag>[\s\S]*<rdf:li>goa<\/rdf:li>/, 'dc:subject is a Bag of leaves');

  const rej = buildXmp({ rating: 3, flag: 'reject', tags: [] });
  assert.match(rej, /<xmp:Rating>-1<\/xmp:Rating>/, 'reject writes xmp:Rating -1');
  assert.equal(parseXmp(rej).rating, 0, 'and reads back as no rating');
  assert.doesNotMatch(buildXmp({ rating: 2, flag: 'pick' }), /Label|-1/, 'a pick writes no label');

  // Merging into an existing sidecar: other properties and namespaces stay.
  const existing = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:darktable="http://darktable.sf.net/"
   xmp:Rating="1" xmp:Label="Blue" exif:DateTimeOriginal="2021:07:04 23:59:59" darktable:xmp_version="5">
   <dc:subject><rdf:Seq><rdf:li>old</rdf:li></rdf:Seq></dc:subject>
   <darktable:history><rdf:Seq><rdf:li darktable:operation="exposure"/></rdf:Seq></darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
  const merged = buildXmp({ rating: 5, tags: ['places/alps'], existing });
  const m = parseXmp(merged);
  assert.equal(m.rating, 5);
  assert.equal(m.label, 'Blue', 'an undefined label keeps the existing one');
  assert.deepEqual(m.tags, ['places/alps'], 'old keywords replaced');
  assert.ok(m.time, 'exif:DateTimeOriginal kept');
  assert.match(merged, /darktable:xmp_version="5"/);
  assert.match(merged, /<darktable:history>[\s\S]*operation="exposure"/, 'other elements kept');
  assert.match(merged, /xmlns:lr="http:\/\/ns.adobe.com\/lightroom\/1.0\/"/, 'missing namespaces declared');
  assert.equal((merged.match(/xmp:Rating/g) || []).length, 2, 'one Rating element, no stale attribute');
  assert.equal(parseXmp(buildXmp({ rating: 5, label: null, existing })).label, null, 'null removes the label');
  // Writing again is stable.
  assert.equal(buildXmp({ rating: 5, tags: ['places/alps'], existing: merged }), merged);
  // A self-closing Description is opened.
  const sc = buildXmp({ rating: 2, existing: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>' });
  assert.equal(parseXmp(sc).rating, 2);
  assert.match(sc, /<\/rdf:Description><\/rdf:RDF>/);
}

// ── the write path ──────────────────────────────────────────────────────────
function makeLib(roots) {
  const store = memoryStore();
  const lib = new Library({ store, saveDelay: 10_000 });
  for (const { id, dir, mode = 'fsa', files } of roots) {
    lib.roots.set(id, { id, name: id, handle: mode === 'fsa' ? dir : null, mode, added: 0, lastScan: 0, files });
  }
  return { lib, store };
}
const addRec = (lib, rootId, path, extra = {}) => { const r = { ...newRecord(rootId, path, { size: 1, lastModified: 1000 }), ...extra }; lib.records.set(r.id, r); return r.id; };

{
  const dir = new FakeDir('photos');
  dir.put('a/one.jpg', 'ORIGINAL-1');
  dir.put('a/two.jpg', 'ORIGINAL-2');
  dir.put('a/two.jpg.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="p" photoshop:City="Panaji" xmp:Rating="1"/></rdf:RDF></x:xmpmeta>');
  dir.put('b/three.jpg', 'ORIGINAL-3');
  dir.put('b/three.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:photoshop="p" photoshop:Headline="Stem"/></rdf:RDF></x:xmpmeta>');
  const ro = new FakeDir('readonly', 'prompt');
  ro.put('c.jpg', 'RO');
  const { lib, store } = makeLib([{ id: 'r1', dir }, { id: 'r2', dir: ro }, { id: 'r3', mode: 'files', files: [] }]);
  const one = addRec(lib, 'r1', 'a/one.jpg'), two = addRec(lib, 'r1', 'a/two.jpg', { xmpTags: ['from/file'] }), three = addRec(lib, 'r1', 'b/three.jpg');
  const c = addRec(lib, 'r2', 'c.jpg'), br = addRec(lib, 'r3', 'd.jpg');

  const w = initXmpWrite(lib, { delay: 5 });
  assert.equal(lib.services.xmpWrite, w);
  await w.ready;
  assert.equal(w.enabled(), false, 'off by default');
  lib.setRating([one], 3);
  assert.equal(await w.flush(), 0);
  assert.ok(!dir.has('a/one.jpg.xmp'), 'nothing written while the setting is off');

  await w.setEnabled(true);
  assert.equal(await store.getKv(XMP_SETTING_KEY), true, 'the setting is stored in kv');
  lib.setRating([one], 4);
  lib.setFlag([two], 'reject');
  lib.tag([two], { add: ['trips/goa'] });
  lib.tag([three], { add: ['stem'] });
  lib.setRating([c, br], 2);
  assert.equal(await w.flush(), 3, 'three sidecars written; read-only and browse-only roots skipped');
  assert.equal(parseXmp(dir.read('a/one.jpg.xmp')).rating, 4);
  const twoX = dir.read('a/two.jpg.xmp');
  assert.match(twoX, /<xmp:Rating>-1<\/xmp:Rating>/);
  assert.match(twoX, /photoshop:City="Panaji"/, 'the existing sidecar is merged');
  assert.deepEqual(parseXmp(twoX).tags.sort(), ['from/file', 'trips/goa']);
  assert.match(dir.read('b/three.jpg.xmp'), /photoshop:Headline="Stem"/, 'the stem sidecar seeds the full-name file');
  assert.ok(!dir.read('b/three.xmp').includes('stem</rdf:li>'), 'the stem sidecar itself is untouched');
  assert.equal(dir.read('a/one.jpg'), 'ORIGINAL-1', 'originals untouched');
  assert.equal(dir.read('a/two.jpg'), 'ORIGINAL-2');
  assert.ok(!ro.has('c.jpg.xmp'), 'a root without write permission is skipped');

  // The debounce writes on its own.
  lib.setRating([one], 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(parseXmp(dir.read('a/one.jpg.xmp')).rating, 1, 'debounced write');
  // An unchanged result is not rewritten.
  const before = dir.node('a/one.jpg.xmp').writes;
  lib.setFavourite([one], true);
  await w.flush();
  assert.equal(dir.node('a/one.jpg.xmp').writes, before, 'no rewrite when the sidecar would not change');

  // A library-file load (ids null) writes nothing.
  lib.emit('choices', { ids: null, reason: 'libfile' });
  assert.equal(await w.flush(), 0);
  await w.setEnabled(false);
  lib.setRating([one], 5);
  assert.equal(await w.flush(), 0, 'off again: nothing written');
}

// ── export ──────────────────────────────────────────────────────────────────
{
  const taken = new Set(['a.jpg', 'a (2).jpg']);
  assert.equal(uniqueName('A.jpg', taken), 'A (3).jpg');
  assert.equal(uniqueName('b.jpg', taken), 'b.jpg');
  assert.equal(uniqueName('b.jpg', taken), 'b (2).jpg');
  assert.equal(uniqueName('README', new Set(['readme'])), 'README (2)');

  const dir = new FakeDir('photos');
  dir.put('x/IMG_1.jpg', 'ONE');
  dir.put('y/IMG_1.jpg', 'OTHER');
  dir.put('y/clip.mov', 'MOVIE');
  const fileB = { name: 'b.png', webkitRelativePath: 'Pick/b.png', size: 3, async text() { return 'BRO'; } };
  const { lib } = makeLib([{ id: 'r1', dir }, { id: 'r2', mode: 'files', files: [fileB] }]);
  const ids = [addRec(lib, 'r1', 'x/IMG_1.jpg'), addRec(lib, 'r1', 'y/IMG_1.jpg'), addRec(lib, 'r1', 'y/clip.mov'), addRec(lib, 'r2', 'b.png')];
  const gone = addRec(lib, 'r1', 'gone.jpg');
  const dest = new FakeDir('out');
  dest.put('clip.mov', 'ALREADY');
  const seen = [];
  lib.jobs.onProgress(p => { if (p.kind === 'export') seen.push(p.kinds.export); });
  const r = await exportFiles(lib, [...ids, gone], dest);
  assert.deepEqual(r, { copied: 4, failed: 1, total: 5 });
  assert.equal(dest.read('IMG_1.jpg'), 'ONE');
  assert.equal(dest.read('IMG_1 (2).jpg'), 'OTHER', 'a name clash gets (2)');
  assert.equal(dest.read('clip.mov'), 'ALREADY', 'an existing file is never overwritten');
  assert.equal(dest.read('clip (2).mov'), 'MOVIE');
  assert.equal(dest.read('b.png'), 'BRO', 'browse-only files export too');
  assert.ok(seen.length && seen.at(-1).total === 5, 'progress runs on lib.jobs as kind export');

  const al = lib.albumCreate('Trip', { ids: [ids[0], ids[1], gone] });
  lib.records.get(gone).missing = true;
  await lib.trash([ids[1]]).catch(() => {});
  assert.deepEqual(albumExportIds(lib, al.albumId), [ids[0]], 'album export leaves out trashed and missing photos');
}

console.log('Slate library xmpwrite and export: PASS');
