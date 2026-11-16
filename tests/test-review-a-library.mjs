// Regression tests for the library-file and trash findings of the 17 November 2026 review
// (plan/review-fable-2026-11-17.md): S1, S2, S3, S12 (pairing and trash), S14, S15, S21, S27.
// Node only: real Library, scanRoot, persist and trash over a fake folder handle.
import assert from 'node:assert/strict';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { scanRoot, movDuration } from '../src/library/scan.js';
import { createPersist, kvKey } from '../src/library/persist.js';
import { createTrash } from '../src/library/trash.js';
import { parseLibFile, buildLibFile, LIBRARY_META_FILE } from '../src/library/libfile.js';
import { LIBRARY_FILE, TRASH_DIR, makeId } from '../src/library/schema.js';

// ── a fake FileSystemDirectoryHandle tree ─────────────────────────────────
// `gate.perm` is the folder's permission. While it is not 'granted', every read or write
// rejects with NotAllowedError, as Chrome does for a stored handle after a restart, until
// requestPermission() (which needs a click in a browser) grants it.
const err = (name) => Object.assign(new Error(name), { name });
class FakeFile {
  constructor(name, data, dir) { this.kind = 'file'; this.name = name; this.data = data; this.dir = dir; this.mtime = 1000; this.writes = 0; }
  check() { if (this.dir.gate.perm !== 'granted') throw err('NotAllowedError'); }
  async getFile() { this.check(); return new File([this.data], this.name, { lastModified: this.mtime }); }
  async createWritable() {
    this.check();
    let buf = '';
    return { write: async (x) => { buf += typeof x === 'string' ? x : await x.text(); }, close: async () => { this.data = buf; this.mtime++; this.writes++; } };
  }
  async move(toDir, newName) {
    this.check();
    if (toDir.entriesMap.has(newName)) throw err('InvalidModificationError');
    this.dir.entriesMap.delete(this.name);
    this.name = newName; this.dir = toDir;
    toDir.entriesMap.set(newName, this);
  }
  async isSameEntry(o) { return o === this; }
}
class FakeDir {
  constructor(name, gate = { perm: 'granted', asked: 0 }) { this.kind = 'directory'; this.name = name; this.entriesMap = new Map(); this.gate = gate; }
  check() { if (this.gate.perm !== 'granted') throw err('NotAllowedError'); }
  async queryPermission() { return this.gate.perm; }
  async requestPermission() { this.gate.asked++; this.gate.perm = 'granted'; return 'granted'; }
  async isSameEntry(o) { return o === this; }
  async getDirectoryHandle(n, { create = false } = {}) {
    this.check();
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'directory') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const d = new FakeDir(n, this.gate); this.entriesMap.set(n, d); return d;
  }
  async getFileHandle(n, { create = false } = {}) {
    this.check();
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'file') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const f = new FakeFile(n, '', this); this.entriesMap.set(n, f); return f;
  }
  async removeEntry(n) { this.check(); if (!this.entriesMap.delete(n)) throw err('NotFoundError'); }
  async *entries() { this.check(); for (const e of [...this.entriesMap]) yield e; }
  // test helpers
  node(path) { let d = this; for (const p of path.split('/')) { if (!(d instanceof FakeDir)) return null; d = d.entriesMap.get(p); if (!d) return null; } return d; }
  put(path, data = 'x') {
    const parts = path.split('/'); const name = parts.pop(); let d = this;
    for (const p of parts) { if (!d.entriesMap.has(p)) d.entriesMap.set(p, new FakeDir(p, this.gate)); d = d.entriesMap.get(p); }
    d.entriesMap.set(name, new FakeFile(name, data, d));
  }
  has(path) { return !!this.node(path); }
  read(path) { return this.node(path)?.data; }
  json() { return parseLibFile(this.read(LIBRARY_FILE)).file; }
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n ', e.stack.split('\n').slice(0, 6).join('\n  ')); }
}

// One browser profile: a store that outlives the Library (IndexedDB), and a Library over it.
function profile() { return { store: memoryStore() }; }
function open(prof, extra = {}) {
  const lib = new Library({ store: prof.store, services: { scanRoot, persist: createPersist(prof.store), trash: createTrash(), ...extra }, saveDelay: 5 });
  return lib;
}
async function addFolder(prof, dir) {
  const lib = open(prof);
  await lib.load();
  const root = await lib.addRoot({ handle: dir, name: dir.name });
  return { lib, root, id: (p) => makeId(root.id, p) };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── S1: a browser restart, then one click, must not erase the library file ──
await check('S1: choices survive a restart in the "prompt" state followed by a favourite', async () => {
  const dir = new FakeDir('Photos');
  for (const p of ['a.jpg', 'b.jpg', 'c.jpg', 'h.jpg', 'gone.jpg']) dir.put(p, p);
  const prof = profile();
  const s1 = await addFolder(prof, dir);
  s1.lib.setFavourite([s1.id('a.jpg')], true);
  s1.lib.setRating([s1.id('a.jpg')], 5);
  s1.lib.setHidden([s1.id('h.jpg')], true);
  const al = s1.lib.albumCreate('Goa', { ids: [s1.id('c.jpg')] });
  await s1.lib.trash([s1.id('gone.jpg')]);
  await s1.lib.flush();

  // Session 2: the stored handle is back in "prompt"; boot runs load() before any click.
  dir.gate.perm = 'prompt';
  const lib = open(prof);
  await lib.load();
  const rootId = s1.root.id, id = (p) => makeId(rootId, p);
  // A favourite before the folder is opened: kept, but the disk file is left alone.
  lib.setFavourite([id('b.jpg')], true);
  await lib.flush();
  dir.gate.perm = 'granted';
  assert.equal(dir.json().items['a.jpg']?.fav, true, 'the file on disk still holds the first session');
  dir.gate.perm = 'prompt';
  // Opening the Library: the scan asks for permission, then reads the file again.
  await lib.rescan(rootId);
  assert.equal(dir.gate.asked, 1);
  lib.setFavourite([id('c.jpg')], true);
  await lib.flush();
  const f = dir.json();
  assert.equal(f.items['a.jpg']?.fav, true, 'favourite kept');
  assert.equal(f.items['a.jpg']?.rating, 5, 'rating kept');
  assert.equal(f.items['h.jpg']?.hidden, true, 'hidden kept');
  assert.equal(f.items['b.jpg']?.fav, true, 'the favourite made before the grant is kept');
  assert.equal(f.items['c.jpg']?.fav, true);
  assert.ok(f.items[`${TRASH_DIR}/gone.jpg`]?.trashed, 'trash record kept');
  assert.equal(f.albums.find(a => a.id === al.albumId)?.name, 'Goa', 'album kept');
  assert.equal(lib.choice(id('h.jpg')).hidden, true, 'the hidden photo stays hidden in memory');
  assert.equal(lib.search({}).some(r => r.id === id('h.jpg')), false);
  assert.equal(lib.counts().trashed, 1);
});

await check('S1: persist.load merges the kv copy with the disk copy item by item', async () => {
  const store = memoryStore(), p = createPersist(store);
  const dir = new FakeDir('P'), root = { id: 'r1', name: 'P', mode: 'fsa', handle: dir };
  const disk = buildLibFile({ choices: new Map([['a.jpg', { fav: true }], ['b.jpg', { rating: 3 }]]), sizes: new Map(), albums: [], times: new Map([['a.jpg', 100], ['b.jpg', 100]]), now: new Date(1000) });
  await p.save(root, disk);
  const kv = buildLibFile({ choices: new Map([['b.jpg', { rating: 1 }]]), sizes: new Map(), albums: [], times: new Map([['b.jpg', 200]]), now: new Date(2000) });
  await store.setKv(kvKey('r1'), JSON.stringify(kv));
  const got = await p.load(root);
  assert.equal(got.items['a.jpg']?.fav, true, 'the disk item absent from kv is kept');
  assert.equal(got.items['b.jpg']?.rating, 1, 'the newer kv item wins');
});

// ── S2: two tabs on one folder ────────────────────────────────────────────
await check('S2: a second tab keeps the first tab\'s trash and choices', async () => {
  const dir = new FakeDir('Photos');
  for (const p of ['keep.jpg', 'other.jpg', 'x.jpg', 'y.jpg']) dir.put(p, p);
  const A = await addFolder(profile(), dir);
  A.lib.setFavourite([A.id('y.jpg')], true);
  await A.lib.flush();
  const B = await addFolder(profile(), dir); // opened earlier, before A's next changes
  const tA = (p) => makeId(A.root.id, p), tB = (p) => makeId(B.root.id, p);
  await A.lib.trash([tA('keep.jpg')]);
  A.lib.albumCreate('Trip', { ids: [tA('x.jpg')] });
  A.lib.setFavourite([tA('y.jpg')], false);          // a removal: must not come back from B
  await A.lib.flush();
  await wait(2);
  B.lib.setFavourite([tB('other.jpg')], true);
  await B.lib.flush();
  const f = dir.json();
  assert.ok(f.items[`${TRASH_DIR}/keep.jpg`]?.trashed, 'trash flag kept');
  assert.equal(f.items['other.jpg']?.fav, true, 'B\'s favourite written');
  assert.ok(f.albums.some(a => a.name === 'Trip'), 'A\'s album kept');
  assert.ok(!f.items['y.jpg']?.fav, 'A\'s un-favourite is not undone by B\'s stale copy');
  assert.ok(f.deleted['y.jpg'] > 0, 'the removal is kept as a tombstone');
  assert.ok(B.lib.choice(tB(`${TRASH_DIR}/keep.jpg`)).trashed, 'B now shows the trash too');
  // Newest change wins on one item.
  A.lib.setRating([tA('x.jpg')], 2); await A.lib.flush(); await wait(2);
  B.lib.setRating([tB('x.jpg')], 4); await B.lib.flush();
  await A.lib.flush(); A.lib.markDirty(A.root.id); await A.lib.flush();
  assert.equal(A.lib.choice(tA('x.jpg')).rating, 4, 'the newer rating from B reaches A');
});

await check('S2: a file in .slate-trash with no record gets one back on the next scan', async () => {
  const dir = new FakeDir('Photos');
  dir.put('a.jpg', 'a'); dir.put(`${TRASH_DIR}/2024/lost.jpg`, 'lost');
  const { lib, id } = await addFolder(profile(), dir);
  assert.ok(lib.choice(id(`${TRASH_DIR}/2024/lost.jpg`)).trashed, 'recovered as trashed');
  const r = await lib.restore([id(`${TRASH_DIR}/2024/lost.jpg`)]);
  assert.equal(r.changed, 1, 'restore reaches it');
  assert.ok(dir.has('2024/lost.jpg') && !dir.has(`${TRASH_DIR}/2024/lost.jpg`));
});

await check('S2: tombstones older than 30 days are pruned', async () => {
  const now = new Date(Date.UTC(2026, 10, 17));
  const f = buildLibFile({ choices: new Map(), sizes: new Map(), albums: [], now,
    times: new Map([['old.jpg', now.getTime() - 31 * 86400000], ['new.jpg', now.getTime() - 86400000]]) });
  assert.deepEqual(Object.keys(f.deleted), ['new.jpg']);
});

await check('S2: saves hold a Web Lock named after the folder', async () => {
  const names = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (n, fn) => { names.push(n); return fn(); } } } });
  try {
    const dir = new FakeDir('Lockme'); dir.put('a.jpg');
    const { lib, id } = await addFolder(profile(), dir);
    lib.setFavourite([id('a.jpg')], true);
    await lib.flush();
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
  assert.ok(names.includes('slate-libfile:Lockme'));
});

// ── S3: the trash intent is saved before the files move ───────────────────
await check('S3: the trashed flag is on disk before the move, and batches save every 50', async () => {
  const dir = new FakeDir('Photos');
  for (let i = 0; i < 120; i++) dir.put(`p${i}.jpg`, String(i));
  const prof = profile();
  const seenAtMove = [];
  const real = createTrash();
  let saves = 0;
  const persist = createPersist(prof.store);
  const lib = open(prof, {
    trash: { ...real, move: async (root, path) => { seenAtMove.push(!!parseLibFile(dir.read(LIBRARY_FILE) ?? '{}').file.items[`${TRASH_DIR}/${path}`]?.trashed); return real.move(root, path); } },
    persist: { ...persist, save: async (...a) => { saves++; return persist.save(...a); } },
  });
  await lib.load();
  const root = await lib.addRoot({ handle: dir, name: 'Photos' });
  saves = 0;
  const ids = [...lib.records.keys()];
  const r = await lib.trash(ids);
  assert.equal(r.changed, 120);
  assert.ok(seenAtMove.length === 120 && seenAtMove.every(Boolean), 'every move came after its trashed flag was saved');
  assert.ok(saves >= 3, `saved once per batch of 50 (saw ${saves})`);
  // The tab closes now, with no further save: a new session still has the whole trash.
  const again = open(prof);
  await again.load();
  assert.equal(again.counts().trashed, 120);
  assert.equal(root.id, [...again.roots.keys()][0]);
});

await check('S3: choices left at the original path follow a file found in the trash', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a'); dir.put('b.jpg', 'b');
  const { lib, id } = await addFolder(profile(), dir);
  lib.setFavourite([id('a.jpg')], true);
  await lib.flush();
  // A crash: the file reached .slate-trash, the library file never heard of it.
  const f = dir.node('a.jpg'); await dir.getDirectoryHandle(TRASH_DIR, { create: true }).then(t => f.move(t, 'a.jpg'));
  await lib.rescan();
  const c = lib.choice(id(`${TRASH_DIR}/a.jpg`));
  assert.ok(c.trashed && c.fav, 'trashed, with its favourite');
  assert.equal(lib.get(id('a.jpg')), null, 'no missing row left at the old path');
});

// ── S21: a new file at a trashed photo's old path is a live photo ─────────
await check('S21: a new file at the path of a trashed photo stays live', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'old copy');
  const { lib, id } = await addFolder(profile(), dir);
  await lib.trash([id('a.jpg')]);
  dir.put('a.jpg', 'a new photo');
  await lib.rescan();
  assert.equal(lib.choice(id('a.jpg')).trashed, null, 'the new file is not trashed');
  assert.ok(lib.search({}).some(r => r.id === id('a.jpg')), 'it shows in the timeline');
  const res = await lib.restore([id(`${TRASH_DIR}/a.jpg`)]);
  assert.equal(res.changed, 0, 'restore refuses to replace the new file');
  await lib.emptyTrash();
  assert.equal(dir.read('a.jpg'), 'a new photo', 'emptying the trash leaves the new file');
  assert.ok(!dir.has(`${TRASH_DIR}/a.jpg`));
});

// ── S27: a sidecar is never left behind ───────────────────────────────────
await check('S27: a sidecar whose name is taken in the trash is kept under a new name', async () => {
  const dir = new FakeDir('Photos');
  dir.put('IMG_1.jpg', 'p'); dir.put('IMG_1.jpg.xmp', 'mine'); dir.put(`${TRASH_DIR}/IMG_1.jpg.xmp`, 'older');
  const res = await createTrash().move({ id: 'r', mode: 'fsa', handle: dir }, 'IMG_1.jpg');
  assert.ok(!dir.has('IMG_1.jpg.xmp'), 'not left behind');
  assert.equal(dir.read(`${TRASH_DIR}/IMG_1.jpg.xmp`), 'older');
  assert.equal(dir.read(`${TRASH_DIR}/IMG_1.jpg (2).xmp`), 'mine');
  assert.deepEqual(res.renamed, [{ from: 'IMG_1.jpg.xmp', to: 'IMG_1.jpg (2).xmp' }]);
});

// ── S12: Live Photo pairing and the trash ─────────────────────────────────
// A QuickTime file: ftyp, then moov with an mvhd (version 0) of the given length.
function mov(seconds, pad = 0) {
  const scale = 600, b = new Uint8Array(20 + 8 + 8 + 100 + pad), v = new DataView(b.buffer);
  v.setUint32(0, 20); b.set([0x66, 0x74, 0x79, 0x70], 4); b.set([0x71, 0x74, 0x20, 0x20], 8);
  v.setUint32(20, 8 + 108); b.set([0x6d, 0x6f, 0x6f, 0x76], 24);
  v.setUint32(28, 108); b.set([0x6d, 0x76, 0x68, 0x64], 32);
  v.setUint32(48, scale); v.setUint32(52, Math.round(seconds * scale));
  return b;
}
await check('S12: only a short MOV pairs with a still', async () => {
  assert.equal(await movDuration(new File([mov(2.5)], 'x.mov')), 2.5);
  const dir = new FakeDir('Live');
  dir.put('IMG_1.HEIC', 'h'); dir.put('IMG_1.MOV', mov(2.5));
  dir.put('birthday.jpg', 'j'); dir.put('birthday.mov', mov(60));
  const { lib, id } = await addFolder(profile(), dir);
  assert.equal(lib.get(id('IMG_1.HEIC')).liveVideo, 'IMG_1.MOV', 'a 2.5 s clip pairs');
  assert.equal(lib.get(id('birthday.jpg')).liveVideo, undefined, 'a 60 s video does not pair');
  assert.equal(lib.get(id('birthday.mov'))?.kind, 'video', 'it stays a video with its own tile');
});

await check('S12: trash, restore and empty trash take the paired MOV along', async () => {
  const dir = new FakeDir('Live');
  dir.put('IMG_1.HEIC', 'h'); dir.put('IMG_1.MOV', mov(2));
  const { lib, id } = await addFolder(profile(), dir);
  await lib.trash([id('IMG_1.HEIC')]);
  assert.ok(dir.has(`${TRASH_DIR}/IMG_1.HEIC`) && dir.has(`${TRASH_DIR}/IMG_1.MOV`) && !dir.has('IMG_1.MOV'), 'trash moves both');
  await lib.rescan();
  assert.equal(lib.get(id('IMG_1.MOV')), null, 'the MOV does not come back as a video');
  await lib.restore([id(`${TRASH_DIR}/IMG_1.HEIC`)]);
  assert.ok(dir.has('IMG_1.HEIC') && dir.has('IMG_1.MOV'), 'restore brings both back');
  assert.equal(lib.get(id('IMG_1.HEIC')).liveVideo, 'IMG_1.MOV');
  await lib.trash([id('IMG_1.HEIC')]);
  await lib.emptyTrash();
  assert.ok(!dir.has(`${TRASH_DIR}/IMG_1.HEIC`) && !dir.has(`${TRASH_DIR}/IMG_1.MOV`) && !dir.has('IMG_1.MOV'), 'empty trash deletes both');
});

// ── S14: a rescan during a scan runs again afterwards ─────────────────────
await check('S14: a rescan asked for while a scan runs finds files added during it', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a');
  let hold = null, first = true;
  const slow = async (lib, root, o) => {
    const r = await scanRoot(lib, root, o);
    if (first) { first = false; await new Promise(res => { hold = res; }); }
    return r;
  };
  const prof = profile();
  const lib = open(prof, { scanRoot: slow });
  await lib.load();
  const adding = lib.addRoot({ handle: dir, name: 'Photos' });
  while (!hold) await wait(1);
  dir.put('late.jpg', 'l');
  const root = [...lib.roots.values()][0];
  const second = lib.rescan(root.id);
  hold();
  await Promise.all([adding, second]);
  assert.ok(lib.get(makeId(root.id, 'late.jpg')), 'the file added during the scan has a record');
});

// ── S15: import details live in their own file ────────────────────────────
await check('S15: a favourite does not rewrite the import-details file', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a'); dir.put('b.jpg', 'b');
  const prof = profile();
  const { lib, id } = await addFolder(prof, dir);
  lib.setMeta(id('a.jpg'), { caption: 'Sunset', source: 'takeout' });
  await lib.flush();
  const metaFile = dir.node(LIBRARY_META_FILE);
  assert.ok(metaFile, 'the meta file is written');
  assert.equal(dir.json().items['a.jpg'].meta, undefined, 'the library file has no meta');
  const writes = metaFile.writes;
  lib.setFavourite([id('b.jpg')], true);
  await lib.flush();
  assert.equal(metaFile.writes, writes, 'not rewritten for a favourite');
  const again = open(prof); await again.load();
  assert.equal(again.meta.get(id('a.jpg'))?.caption, 'Sunset', 'both files are read back');
});

await check('S15: an older library file with meta inside its items still loads', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a');
  dir.put(LIBRARY_FILE, JSON.stringify({ format: 'slate-library', version: 1, items: { 'a.jpg': { size: 1, fav: true, meta: { caption: 'Old', source: 'icloud' } } }, albums: [] }));
  const { lib, id } = await addFolder(profile(), dir);
  assert.equal(lib.meta.get(id('a.jpg'))?.caption, 'Old');
  lib.setFavourite([id('a.jpg')], false); await lib.flush();
  assert.ok(dir.read(LIBRARY_META_FILE).includes('Old'), 'moved to the meta file on the next save');
});

// ── S10: a rating or tag from XMP can be cleared ──────────────────────────
await check('S10: clearing an XMP rating and removing an XMP tag stick, through the library file', async () => {
  const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4">
<dc:subject><rdf:Bag><rdf:li>goa</rdf:li><rdf:li>beach</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a'); dir.put('a.jpg.xmp', XMP);
  const prof = profile();
  const { lib, id } = await addFolder(prof, dir);
  assert.equal(lib.rating(id('a.jpg')), 4);
  assert.equal(lib.setRating([id('a.jpg')], 0).changed, 1, 'clearing the XMP rating is a change');
  assert.equal(lib.rating(id('a.jpg')), 0);
  assert.equal(lib.tag([id('a.jpg')], { remove: ['goa'] }).changed, 1, 'removing an XMP tag is a change');
  assert.deepEqual(lib.tagsOf(id('a.jpg')), ['beach']);
  assert.equal(lib.search({ tag: 'goa' }).length, 0);
  await lib.flush();
  const again = open(prof); await again.load();
  assert.equal(again.rating(id('a.jpg')), 0, 'the cleared rating survives a reload');
  assert.deepEqual(again.tagsOf(id('a.jpg')), ['beach'], 'the removed tag stays removed');
  again.tag([id('a.jpg')], { add: ['goa'] });
  assert.ok(again.tagsOf(id('a.jpg')).includes('goa'), 'adding it again brings it back');
  again.setRating([id('a.jpg')], 3);
  assert.equal(again.rating(id('a.jpg')), 3);
});

// ── S22: unknown fields survive a save ────────────────────────────────────
await check('S22: unknown fields on items and at the top level are written back', async () => {
  const dir = new FakeDir('Photos'); dir.put('a.jpg', 'a'); dir.put('b.jpg', 'b');
  dir.put(LIBRARY_FILE, JSON.stringify({ format: 'slate-library', version: 1, future: { x: 1 }, items: { 'a.jpg': { size: 1, fav: true, colour: 'red' } }, albums: [] }));
  const { lib, id } = await addFolder(profile(), dir);
  lib.setFavourite([id('b.jpg')], true);
  await lib.flush();
  const raw = JSON.parse(dir.read(LIBRARY_FILE));
  assert.deepEqual(raw.future, { x: 1 }, 'top-level field kept');
  assert.equal(raw.items['a.jpg'].colour, 'red', 'item field kept');
});

console.log(failed ? `test-review-a-library: ${failed} failed` : 'test-review-a-library: all passed');
process.exit(failed ? 1 : 0);
