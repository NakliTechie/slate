// Move and rename (spec row O10): move.js over a fake folder, Library.moveFiles
// and renameFiles re-keying choices and albums, refusal to overwrite, undo,
// and rename templates.
import assert from 'node:assert/strict';
import { createMove, renderName } from '../src/library/move.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { createPersist } from '../src/library/persist.js';
import { createTrash } from '../src/library/trash.js';
import { parseLibFile } from '../src/library/libfile.js';
import { newRecord, wallClockToTime, LIBRARY_FILE, kindOf, isSkippedDir } from '../src/library/schema.js';

// ── a fake FileSystemDirectoryHandle tree (as in test-library-organise.mjs) ──
const err = (name) => Object.assign(new Error(name), { name });
class FakeFile {
  constructor(name, data, dir, withMove) { this.kind = 'file'; this.name = name; this.data = data; this.dir = dir; this.mtime = 1000; if (withMove) this.move = this._move; }
  async getFile() { const d = this.data, m = this.mtime, n = this.name; return { name: n, size: d.length, lastModified: m, async text() { return d; } }; }
  async createWritable() {
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
  constructor(name, { withMove = true } = {}) { this.kind = 'directory'; this.name = name; this.entriesMap = new Map(); this.withMove = withMove; }
  async queryPermission() { return 'granted'; }
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
  put(path, data = 'x') {
    const parts = path.split('/'); const name = parts.pop(); let d = this;
    for (const p of parts) { if (!d.entriesMap.has(p)) d.entriesMap.set(p, new FakeDir(p, { withMove: this.withMove })); d = d.entriesMap.get(p); }
    d.entriesMap.set(name, new FakeFile(name, data, d, this.withMove));
  }
  has(path) {
    let d = this;
    for (const p of path.split('/')) { if (!(d instanceof FakeDir)) return false; d = d.entriesMap.get(p); if (!d) return false; }
    return true;
  }
  read(path) { let d = this; for (const p of path.split('/')) d = d.entriesMap.get(p); return d.data; }
}

// ── rename templates ──────────────────────────────────────────────────────
{
  const rec = { name: 'IMG_0042.JPG', time: wallClockToTime(2024, 3, 1, 9, 5, 7), camera: 'Canon EOS R5' };
  assert.equal(renderName('{date}_{n}', rec, 7, 3), '2024-03-01_007.JPG', 'date and padded counter, extension kept');
  assert.equal(renderName('{date} {time} {name}', rec, 1), '2024-03-01 090507 IMG_0042.JPG');
  assert.equal(renderName('{camera}-{n}', rec, 12, 4), 'Canon EOS R5-0012.JPG');
  assert.equal(renderName('trip_{n}', rec, 3, 2), 'trip_03.JPG');
  const undated = { name: 'scan.png', time: 0, camera: '' };
  assert.equal(renderName('{date}_{time}_{n}', undated, 1), 'undated_001.png', 'missing date: "undated", empty time, separator collapsed');
  assert.equal(renderName('{camera}_{name}', undated, 1), 'scan.png', 'empty camera leaves no stray separator');
  assert.equal(renderName('a:b?{n}', rec, 1), 'a_b_001.JPG', 'characters a file name cannot hold become _');
  assert.throws(() => renderName('{foo}', rec, 1), /unknown field \{foo\}/);
  assert.throws(() => renderName('x/{n}', rec, 1), /cannot contain \//);
  assert.throws(() => renderName('  ', rec, 1), /template/);
  assert.throws(() => renderName('{camera}', undated, 1), /empty name/);
}

// ── move.js on its own ────────────────────────────────────────────────────
for (const withMove of [true, false]) {
  const how = withMove ? 'move()' : 'copy and remove';
  const dir = new FakeDir('Photos', { withMove });
  dir.put('a/IMG_1.jpg', 'one'); dir.put('a/IMG_1.jpg.xmp', 'full');
  dir.put('a/IMG_2.jpg', 'two'); dir.put('a/IMG_2.xmp', 'stem');
  dir.put('a/IMG_3.jpg', 'three'); dir.put('a/IMG_3.dng', 'raw'); dir.put('a/IMG_3.xmp', 'shared');
  const root = { id: 'r1', mode: 'fsa', handle: dir };
  const mv = createMove();

  await mv.move(root, 'a/IMG_1.jpg', 'a/renamed.jpg');
  assert.ok(!dir.has('a/IMG_1.jpg') && dir.read('a/renamed.jpg') === 'one', `rename in a folder (${how})`);
  assert.ok(!dir.has('a/IMG_1.jpg.xmp') && dir.read('a/renamed.jpg.xmp') === 'full', `full-name sidecar renamed with it (${how})`);

  await mv.move(root, 'a/IMG_2.jpg', 'b/c/IMG_2.jpg');
  assert.ok(dir.has('b/c/IMG_2.jpg') && dir.read('b/c/IMG_2.xmp') === 'stem' && !dir.has('a/IMG_2.xmp'), `move across folders creates them and carries the stem sidecar (${how})`);

  await mv.move(root, 'a/IMG_3.jpg', 'b/IMG_3.jpg');
  assert.ok(dir.has('a/IMG_3.xmp') && !dir.has('b/IMG_3.xmp'), 'a shared stem sidecar stays with the other photo');

  dir.put('b/taken.jpg', 'other');
  await assert.rejects(mv.move(root, 'a/renamed.jpg', 'b/taken.jpg'), /already exists/);
  assert.equal(dir.read('b/taken.jpg'), 'other', 'never overwrites');
  assert.ok(dir.has('a/renamed.jpg'), 'the source stays when the move is refused');
  dir.put('b/x.jpg.xmp', 'stray');
  await assert.rejects(mv.move(root, 'a/renamed.jpg', 'b/x.jpg'), /sidecar/, 'a sidecar target that exists refuses the move');
  assert.ok(dir.has('a/renamed.jpg') && !dir.has('b/x.jpg'));
  assert.equal(await mv.exists(root, 'b/taken.jpg'), true);
  assert.equal(await mv.exists(root, 'nope/x.jpg'), false);
  await assert.rejects(mv.move({ id: 'r2', handle: null }, 'a.jpg', 'b.jpg'), /browse-only/);
}

// ── Library.moveFiles and renameFiles ─────────────────────────────────────
async function walkScan(lib, root) {
  const upserts = [], seen = new Set();
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (!isSkippedDir(name)) await walk(h, prefix + name + '/'); continue; }
      if (!kindOf(name)) continue;
      const rec = newRecord(root.id, prefix + name, await h.getFile());
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
  return { lib, root, id: (p) => `${root.id}/${p}`, store };
}

for (const withMove of [true, false]) {
  const dir = new FakeDir('Photos', { withMove });
  dir.put('in/one.jpg', '1'); dir.put('in/one.jpg.xmp', '<x/>'); dir.put('in/two.jpg', '22'); dir.put('in/three.jpg', '333');
  dir.put('out/three.jpg', 'already here');
  const { lib, id } = await open(dir);
  lib.setFavourite([id('in/one.jpg')], true);
  lib.tag([id('in/one.jpg')], { add: ['goa'] });
  const al = lib.albumCreate('Trip', { ids: [id('in/one.jpg'), id('in/two.jpg')] });
  lib.albumSetCover(al.albumId, id('in/one.jpg'));

  // Dry run: counts, conflicts, nothing moves.
  const dry = await lib.moveFiles([
    { id: id('in/one.jpg'), toPath: 'out/one.jpg' },
    { id: id('in/three.jpg'), toPath: 'out/three.jpg' },
  ], { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, 1);
  assert.deepEqual(dry.conflicts.map(c => [c.id, c.reason]), [[id('in/three.jpg'), 'a file with that name already exists']]);
  assert.ok(dir.has('in/one.jpg'), 'a dry run moves nothing');

  // A conflict refuses the whole call.
  await assert.rejects(lib.moveFiles([
    { id: id('in/one.jpg'), toPath: 'out/one.jpg' },
    { id: id('in/three.jpg'), toPath: 'out/three.jpg' },
  ]), /cannot be moved.*nothing was moved/);
  assert.ok(dir.has('in/one.jpg') && !dir.has('out/one.jpg') && dir.read('out/three.jpg') === 'already here', 'nothing moved, nothing overwritten');
  const twins = await lib.moveFiles([{ id: id('in/one.jpg'), toPath: 'x/a.jpg' }, { id: id('in/two.jpg'), toPath: 'x/A.jpg' }], { dryRun: true });
  assert.equal(twins.conflicts[0].reason, 'two files would get the same name');
  const bad = await lib.moveFiles([{ id: id('in/one.jpg'), toPath: '../up.jpg' }, { id: id('in/two.jpg'), toPath: 'x/two.txt' }], { dryRun: true });
  assert.deepEqual(bad.conflicts.map(c => c.reason), ['not a valid path', 'the new name needs a photo or video extension']);

  // Move across folders with the sidecar; record, choices and albums follow.
  const r = await lib.moveFiles([{ id: id('in/one.jpg'), toPath: 'out/one.jpg' }, { id: id('in/two.jpg'), toPath: 'in/two.jpg' }]);
  assert.equal(r.changed, 1, 'a file already at its target is not counted');
  assert.ok(dir.has('out/one.jpg') && dir.has('out/one.jpg.xmp') && !dir.has('in/one.jpg') && !dir.has('in/one.jpg.xmp'));
  const nid = id('out/one.jpg');
  assert.equal(lib.get(id('in/one.jpg')), null);
  assert.equal(lib.get(nid).path, 'out/one.jpg');
  assert.equal(lib.choice(nid).fav, true, 'the favourite follows the file');
  assert.deepEqual(lib.choice(nid).tags, ['goa']);
  assert.equal(lib.choices.has(id('in/one.jpg')), false);
  const album = lib.albums.get(al.albumId);
  assert.ok(album.items.has(nid) && !album.items.has(id('in/one.jpg')), 'album membership follows the file');
  assert.equal(album.cover, nid, 'the album cover follows the file');
  await lib.flush();
  const file = parseLibFile(dir.read(LIBRARY_FILE)).file;
  assert.ok(file.items['out/one.jpg']?.fav && !file.items['in/one.jpg'], 'the library file has the new path');
  assert.ok(file.albums[0].items.includes('out/one.jpg') && file.albums[0].cover === 'out/one.jpg');

  // Undo moves it back and re-keys again.
  await lib.undo(r.undo);
  assert.ok(dir.has('in/one.jpg') && dir.has('in/one.jpg.xmp') && !dir.has('out/one.jpg'), 'undo moves the file and sidecar back');
  assert.equal(lib.choice(id('in/one.jpg')).fav, true);
  assert.equal(lib.albums.get(al.albumId).cover, id('in/one.jpg'));

  // Trashed files cannot move.
  await lib.trash([id('in/three.jpg')]);
  const tr = await lib.moveFiles([{ id: id('in/three.jpg'), toPath: 'z/three.jpg' }], { dryRun: true });
  assert.equal(tr.conflicts[0].reason, 'the file is in the trash');

  // Rename from a template, numbered in capture order.
  await lib.patchRecords([
    { id: id('in/one.jpg'), time: wallClockToTime(2024, 5, 2, 10, 0, 0) },
    { id: id('in/two.jpg'), time: wallClockToTime(2024, 5, 1, 8, 30, 0) },
  ]);
  const plan = lib.renamePlan([id('in/one.jpg'), id('in/two.jpg')], '{date}_{n}');
  assert.deepEqual(plan.map(p => p.toPath), ['in/2024-05-01_001.jpg', 'in/2024-05-02_002.jpg'], 'earliest photo first');
  const rn = await lib.renameFiles([id('in/one.jpg'), id('in/two.jpg')], 'goa {date} {time}');
  assert.equal(rn.changed, 2);
  assert.ok(dir.has('in/goa 2024-05-02 100000.jpg') && dir.has('in/goa 2024-05-02 100000.jpg.xmp') && dir.has('in/goa 2024-05-01 083000.jpg'));
  assert.equal(lib.choice(id('in/goa 2024-05-02 100000.jpg')).fav, true);
  assert.equal((await lib.renameFiles([id('in/goa 2024-05-01 083000.jpg')], 'goa {date} {time}')).changed, 0, 'renaming to the same name changes nothing');
  await lib.undo(rn.undo);
  assert.ok(dir.has('in/one.jpg') && dir.has('in/two.jpg') && dir.has('in/one.jpg.xmp'), 'undo restores the old names');
}

// Browse-only roots cannot move.
{
  const store = memoryStore();
  const lib = new Library({ store, services: { scanRoot: async (l, root) => l.applyScan(root.id, { upserts: [newRecord(root.id, 'a.jpg', { size: 1, lastModified: 1 })] }) } });
  await lib.load();
  const root = await lib.addRoot({ name: 'Phone', files: [] });
  const r = await lib.moveFiles([{ id: `${root.id}/a.jpg`, toPath: 'b.jpg' }], { dryRun: true });
  assert.equal(r.conflicts[0].reason, 'the folder is browse-only');
}

console.log('Slate library move: PASS');
