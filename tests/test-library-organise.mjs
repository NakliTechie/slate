// Organise agent tests: XMP parsing, the library file on disk, trash, culling keys,
// and a round trip through a real Library over a fake folder.
import assert from 'node:assert/strict';
import { parseXmp, sidecarNames, parseXmpGps } from '../src/library/xmp.js';
import { createPersist, kvKey } from '../src/library/persist.js';
import { createTrash } from '../src/library/trash.js';
import { keyAction } from '../src/ui/library/organise.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord, wallClockToTime, LIBRARY_FILE, TRASH_DIR, kindOf, isSkippedDir } from '../src/library/schema.js';
import { parseLibFile } from '../src/library/libfile.js';

// ── a fake FileSystemDirectoryHandle tree ─────────────────────────────────
const err = (name) => Object.assign(new Error(name), { name });
class FakeFile {
  constructor(name, data, dir, withMove) { this.kind = 'file'; this.name = name; this.data = data; this.dir = dir; this.mtime = 1000; if (withMove) this.move = this._move; }
  async getFile() { const d = this.data, m = this.mtime, n = this.name; return { name: n, size: d.length, lastModified: m, async text() { return d; } }; }
  async createWritable() {
    if (this.dir.readOnly) throw err('NotAllowedError');
    let buf = '';
    return { write: async (x) => { buf += typeof x === 'string' ? x : await x.text(); }, close: async () => { this.data = buf; this.mtime++; } };
  }
  async _move(toDir, newName) {
    if (toDir.entriesMap.has(newName)) throw err('InvalidModificationError');
    this.dir.entriesMap.delete(this.name);
    this.name = newName; this.dir = toDir;
    toDir.entriesMap.set(newName, this);
  }
}
class FakeDir {
  constructor(name, { withMove = true, perm = 'granted' } = {}) { this.kind = 'directory'; this.name = name; this.entriesMap = new Map(); this.withMove = withMove; this.perm = perm; }
  async queryPermission() { return this.perm; }
  async isSameEntry(o) { return o === this; }
  async getDirectoryHandle(n, { create = false } = {}) {
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'directory') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const d = new FakeDir(n, { withMove: this.withMove }); this.entriesMap.set(n, d); return d;
  }
  async getFileHandle(n, { create = false } = {}) {
    const e = this.entriesMap.get(n);
    if (e) { if (e.kind !== 'file') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const f = new FakeFile(n, '', this, this.withMove); this.entriesMap.set(n, f); return f;
  }
  async removeEntry(n) { if (!this.entriesMap.delete(n)) throw err('NotFoundError'); }
  async *entries() { for (const e of [...this.entriesMap]) yield e; }
  // test helpers
  put(path, data = 'x') {
    const parts = path.split('/'); const name = parts.pop(); let d = this;
    for (const p of parts) { if (!d.entriesMap.has(p)) d.entriesMap.set(p, new FakeDir(p, { withMove: this.withMove })); d = d.entriesMap.get(p); }
    d.entriesMap.set(name, new FakeFile(name, data, d, this.withMove));
  }
  has(path) {
    let d = this; const parts = path.split('/');
    for (const p of parts) { if (!(d instanceof FakeDir)) return false; d = d.entriesMap.get(p); if (!d) return false; }
    return true;
  }
  read(path) { let d = this; for (const p of path.split('/')) d = d.entriesMap.get(p); return d.data; }
}

// ── XMP ───────────────────────────────────────────────────────────────────
const LIGHTROOM = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
   xmp:Rating="4"
   xmp:Label="Red"
   exif:DateTimeOriginal="2024-03-01T09:15:30.12+05:30"
   photoshop:DateCreated="2024-03-01T09:15:30.12+05:30"
   exif:GPSLatitude="15,29.4000N"
   exif:GPSLongitude="73,48.0000E">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>beach</rdf:li>
     <rdf:li>Goa</rdf:li>
     <rdf:li>Tom &amp; Jerry</rdf:li>
    </rdf:Bag>
   </dc:subject>
   <lr:hierarchicalSubject>
    <rdf:Bag>
     <rdf:li>Trips|Goa</rdf:li>
    </rdf:Bag>
   </lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

const DIGIKAM = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:digiKam="http://www.digikam.org/ns/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <xmp:Rating>3</xmp:Rating>
   <exif:DateTimeOriginal>2019-12-30T18:05:00</exif:DateTimeOriginal>
   <exif:GPSLatitude>33,51,54S</exif:GPSLatitude>
   <exif:GPSLongitude>151,12.6W</exif:GPSLongitude>
   <digiKam:TagsList><rdf:Seq><rdf:li>People/Om</rdf:li></rdf:Seq></digiKam:TagsList>
   <dc:subject><rdf:Bag><rdf:li>Om</rdf:li><rdf:li>birthday</rdf:li></rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const DARKTABLE = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:darktable="http://darktable.sf.net/" xmlns:lr="http://ns.adobe.com/lightroom/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
   exif:DateTimeOriginal="2021:07:04 23:59:59"
   xmp:Rating="-1"
   darktable:xmp_version="5">
   <dc:subject><rdf:Seq><rdf:li>darktable|format|nef</rdf:li><rdf:li>landscape</rdf:li></rdf:Seq></dc:subject>
   <lr:hierarchicalSubject><rdf:Seq><rdf:li>darktable|format|nef</rdf:li><rdf:li>places|alps</rdf:li></rdf:Seq></lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

{
  const x = parseXmp(LIGHTROOM);
  assert.deepEqual(x.tags, ['Trips/Goa', 'beach', 'Tom & Jerry'], 'hierarchical tags with / and flat tags, leaf duplicate dropped, entities decoded');
  assert.equal(x.rating, 4);
  assert.equal(x.label, 'Red');
  assert.equal(x.time, wallClockToTime(2024, 3, 1, 9, 15, 30), 'wall clock kept, zone ignored');
  assert.equal(x.lat, 15.49);
  assert.equal(x.lon, 73.8);

  const d = parseXmp(DIGIKAM);
  assert.deepEqual(d.tags, ['Om', 'birthday'], 'element-form dc:subject');
  assert.equal(d.rating, 3, 'element-form rating');
  assert.equal(d.label, null);
  assert.equal(d.time, wallClockToTime(2019, 12, 30, 18, 5, 0));
  assert.equal(d.lat, -33.865, 'DD,MM,SS with S');
  assert.equal(d.lon, -151.21, 'DD,MM.mm with W');

  const t = parseXmp(DARKTABLE);
  assert.equal(t.rating, 0, 'Lightroom/darktable reject (-1) clamps to 0');
  assert.equal(t.time, wallClockToTime(2021, 7, 4, 23, 59, 59), 'EXIF colon date form');
  assert.ok(t.tags.includes('places/alps') && t.tags.includes('landscape'));
  assert.equal(t.lat, null);

  const ps = parseXmp(`<rdf:Description xmlns:photoshop="x" photoshop:DateCreated='2010-05-06'/>`);
  assert.equal(ps.time, wallClockToTime(2010, 5, 6), 'photoshop:DateCreated, date only, single quotes');
  assert.deepEqual(parseXmp(''), { tags: [], rating: 0, label: null, time: null, lat: null, lon: null });
  assert.equal(parseXmp('<x MicrosoftPhoto:Rating="75"/>').rating, 0, 'other namespaces with the same local name are ignored');
  assert.equal(parseXmpGps('12.5'), 12.5);
  assert.equal(parseXmpGps('nonsense'), null);

  assert.deepEqual(sidecarNames('IMG_1.jpg'), ['IMG_1.jpg.xmp', 'IMG_1.xmp']);
  assert.deepEqual(sidecarNames('a.b.dng'), ['a.b.dng.xmp', 'a.b.xmp']);
  assert.deepEqual(sidecarNames('README'), ['README.xmp']);
}

// ── persist ───────────────────────────────────────────────────────────────
{
  const store = memoryStore();
  const p = createPersist(store);
  const dir = new FakeDir('Photos');
  const root = { id: 'r1', name: 'Photos', mode: 'fsa', handle: dir };
  assert.equal(await p.load(root), null, 'no file gives null');
  const file = { format: 'slate-library', version: 1, updated: '2026-11-16T00:00:00.000Z', items: { 'a.jpg': { size: 3, fav: true } }, albums: [] };
  assert.deepEqual(await p.save(root, file), { where: 'disk' });
  assert.ok(parseLibFile(dir.read(LIBRARY_FILE)).ok, 'file written at the root');
  assert.equal((await p.load(root)).items['a.jpg'].fav, true);
  assert.equal(p.canWrite(root), true);

  // No write permission: kept in kv, read back from kv because it is newer.
  dir.perm = 'prompt';
  const newer = { ...file, updated: '2026-11-17T00:00:00.000Z', items: { 'a.jpg': { size: 3, rating: 2 } } };
  assert.deepEqual(await p.save(root, newer), { where: 'kv' });
  assert.equal(typeof await store.getKv(kvKey('r1')), 'string');
  assert.equal(p.canWrite(root), false);
  assert.equal((await p.load(root)).items['a.jpg'].rating, 2, 'newer kv copy wins');
  dir.perm = 'granted';
  await p.save(root, newer);
  assert.equal(await store.getKv(kvKey('r1')), undefined, 'kv copy dropped once the disk has it');

  // A write refused by the browser falls back to kv.
  dir.readOnly = true;
  assert.deepEqual(await p.save(root, file), { where: 'kv' });
  dir.readOnly = false;

  // Browse-only roots live in kv.
  const froot = { id: 'r2', name: 'Phone', mode: 'files', handle: null };
  assert.equal(await p.load(froot), null);
  await p.save(froot, file);
  assert.equal((await p.load(froot)).items['a.jpg'].fav, true);
  assert.equal(p.canWrite(froot), false);

  // A file that does not parse is reported and never overwritten.
  const bad = new FakeDir('Bad'); bad.put(LIBRARY_FILE, '{ broken');
  const broot = { id: 'r3', name: 'Bad', mode: 'fsa', handle: bad };
  await assert.rejects(p.load(broot), /will not overwrite/);
  await p.save(broot, file);
  assert.equal(bad.read(LIBRARY_FILE), '{ broken');
}

// ── trash ─────────────────────────────────────────────────────────────────
for (const withMove of [true, false]) {
  const dir = new FakeDir('Photos', { withMove });
  dir.put('2024/goa/IMG_1.jpg', 'one'); dir.put('2024/goa/IMG_1.jpg.xmp', 'side');
  dir.put('2024/goa/IMG_2.jpg', 'two'); dir.put('2024/goa/IMG_2.xmp', 'stem');
  dir.put('2024/goa/IMG_3.jpg', 'three'); dir.put('2024/goa/IMG_3.dng', 'raw'); dir.put('2024/goa/IMG_3.xmp', 'shared');
  const root = { id: 'r1', mode: 'fsa', handle: dir };
  const tr = createTrash();
  const T = `${TRASH_DIR}/2024/goa/`;

  await tr.move(root, '2024/goa/IMG_1.jpg');
  assert.ok(!dir.has('2024/goa/IMG_1.jpg') && dir.has(T + 'IMG_1.jpg'), `move (${withMove ? 'move()' : 'copy'})`);
  assert.ok(!dir.has('2024/goa/IMG_1.jpg.xmp') && dir.has(T + 'IMG_1.jpg.xmp'), 'full-name sidecar moves with its photo');
  assert.equal(dir.read(T + 'IMG_1.jpg'), 'one');

  await tr.move(root, '2024/goa/IMG_2.jpg');
  assert.ok(dir.has(T + 'IMG_2.xmp'), 'stem sidecar moves when no other photo shares it');
  await tr.move(root, '2024/goa/IMG_3.jpg');
  assert.ok(dir.has('2024/goa/IMG_3.xmp') && !dir.has(T + 'IMG_3.xmp'), 'a shared stem sidecar stays with the other photo');

  await tr.restore(root, '2024/goa/IMG_1.jpg');
  assert.ok(dir.has('2024/goa/IMG_1.jpg') && dir.has('2024/goa/IMG_1.jpg.xmp') && !dir.has(T + 'IMG_1.jpg'), 'restore brings photo and sidecar back');

  dir.put('2024/goa/IMG_2.jpg', 'a new file');
  await assert.rejects(tr.restore(root, '2024/goa/IMG_2.jpg'), /already exists/);
  assert.equal(dir.read('2024/goa/IMG_2.jpg'), 'a new file', 'restore never overwrites');
  assert.ok(dir.has(T + 'IMG_2.jpg'), 'the trashed copy stays in the trash');

  await tr.purge(root, '2024/goa/IMG_2.jpg');
  assert.ok(!dir.has(T + 'IMG_2.jpg') && !dir.has(T + 'IMG_2.xmp'), 'purge deletes photo and sidecar');
  await assert.rejects(tr.move({ id: 'r2', mode: 'files', handle: null }, 'a.jpg'), /browse-only/);
}

// ── culling keys ──────────────────────────────────────────────────────────
{
  const k = (key, more = {}) => keyAction({ key, code: '', ...more });
  assert.deepEqual(k('f'), { op: 'favourite', advance: false });
  assert.deepEqual(k('F', { shiftKey: true }), { op: 'favourite', advance: true });
  assert.deepEqual(k('3'), { op: 'rate', rating: 3, advance: false });
  assert.deepEqual(keyAction({ key: '#', code: 'Digit3', shiftKey: true }), { op: 'rate', rating: 3, advance: true }, 'Shift+3 reads the physical key');
  assert.deepEqual(k('p'), { op: 'flag', flag: 'pick', advance: false });
  assert.deepEqual(k('x'), { op: 'flag', flag: 'reject', advance: false });
  assert.deepEqual(k('u'), { op: 'flag', flag: 'none', advance: false });
  assert.deepEqual(k('h'), { op: 'hide', advance: false });
  assert.deepEqual(k('t'), { op: 'tag', advance: false });
  assert.deepEqual(k('Delete'), { op: 'trash', advance: false });
  assert.equal(k('6'), null);
  assert.equal(k('f', { ctrlKey: true }), null, 'Ctrl+F is not a culling key');
  assert.equal(k('f', { target: { tagName: 'INPUT' } }), null, 'typing in a field is ignored');
}

// ── end to end: a real Library over a fake folder ─────────────────────────
// A small scanner over the fake tree, standing in for scan.js.
async function walkScan(lib, root) {
  const upserts = [], seen = new Set();
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (!isSkippedDir(name)) await walk(h, prefix + name + '/'); continue; }
      if (!kindOf(name)) continue;
      const f = await h.getFile();
      const rec = newRecord(root.id, prefix + name, f);
      seen.add(rec.id);
      if (!lib.get(rec.id)) upserts.push(rec);
    }
  }
  await walk(root.handle, '');
  await lib.applyScan(root.id, { upserts, seen });
}
async function open(dir) {
  const store = memoryStore();
  const lib = new Library({ store, services: { scanRoot: walkScan, persist: createPersist(store), trash: createTrash() }, saveDelay: 5 });
  await lib.load();
  const root = await lib.addRoot({ handle: dir, name: 'Photos' });
  const byPath = (p) => `${root.id}/${p}`;
  return { lib, root, byPath };
}
{
  const dir = new FakeDir('Photos', { withMove: false });
  dir.put('a/one.jpg', '1'); dir.put('a/two.jpg', '22'); dir.put('b/three.heic', '333'); dir.put('b/three.heic.xmp', '<x/>');
  const { lib, byPath } = await open(dir);
  assert.equal(lib.records.size, 3);
  lib.setFavourite([byPath('a/one.jpg')], true);
  lib.setRating([byPath('a/two.jpg')], 5);
  lib.tag([byPath('a/two.jpg')], { add: ['trips/goa'] });
  const al = lib.albumCreate('Best', { ids: [byPath('a/one.jpg'), byPath('a/two.jpg')] });
  const t = await lib.trash([byPath('b/three.heic')]);
  assert.equal(t.changed, 1);
  assert.ok(dir.has(`${TRASH_DIR}/b/three.heic`) && dir.has(`${TRASH_DIR}/b/three.heic.xmp`), 'the photo and sidecar are in the trash on disk');
  await lib.flush();
  assert.ok(dir.has(LIBRARY_FILE));

  const again = await open(dir);
  const c = (p) => again.lib.choice(again.byPath(p));
  assert.equal(c('a/one.jpg').fav, true);
  assert.equal(c('a/two.jpg').rating, 5);
  assert.deepEqual(c('a/two.jpg').tags, ['trips/goa']);
  assert.ok(c('.slate-trash/b/three.heic').trashed, 'trash state comes back from the file (keyed by its place in the trash, review S21)');
  const al2 = again.lib.albums.get(al.albumId);
  assert.equal(al2.name, 'Best');
  assert.deepEqual([...al2.items].sort(), [again.byPath('a/one.jpg'), again.byPath('a/two.jpg')]);

  // Restore through the Library puts the file back; emptying deletes it for good.
  await lib.restore([byPath('b/three.heic')]); // the original id still finds the trashed photo
  assert.ok(dir.has('b/three.heic') && dir.has('b/three.heic.xmp'));
  await lib.trash([byPath('b/three.heic')]);
  await lib.emptyTrash();
  assert.ok(!dir.has(`${TRASH_DIR}/b/three.heic`) && !dir.has('b/three.heic'));
}

console.log('Slate library organise: PASS');
