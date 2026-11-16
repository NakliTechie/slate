// Review findings S4 and S12 (move part), 17 November 2026: move.js on fake folders that
// behave like a case-sensitive and a case-insensitive disk. move() on these fakes replaces
// an existing target, as FileSystemFileHandle.move() does.
import assert from 'node:assert/strict';
import { createMove } from '../src/library/move.js';

const err = (name) => Object.assign(new Error(name), { name });
class F {
  constructor(name, data, dir) { this.kind = 'file'; this.name = name; this.data = data; this.dir = dir; }
  async getFile() { const d = this.data; return { name: this.name, size: d.length, lastModified: 1, async text() { return d; } }; }
  async createWritable() { let b = ''; return { write: async (x) => { b += typeof x === 'string' ? x : await x.text(); }, close: async () => { this.data = b; } }; }
  async isSameEntry(o) { return o === this; }
  async move(toDir, newName) {
    this.dir.m.delete(this.dir.k(this.name));
    toDir.m.delete(toDir.k(newName)); // replaces whatever sits there
    this.name = newName; this.dir = toDir;
    toDir.m.set(toDir.k(newName), this);
  }
}
class D {
  constructor(name, ci) { this.kind = 'directory'; this.name = name; this.ci = ci; this.m = new Map(); this.onEntries = null; }
  k(n) { return this.ci ? n.toLowerCase() : n; }
  async isSameEntry(o) { return o === this; }
  async getDirectoryHandle(n, { create = false } = {}) {
    const e = this.m.get(this.k(n));
    if (e) { if (e.kind !== 'directory') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const d = new D(n, this.ci); this.m.set(this.k(n), d); return d;
  }
  async getFileHandle(n, { create = false } = {}) {
    const e = this.m.get(this.k(n));
    if (e) { if (e.kind !== 'file') throw err('TypeMismatchError'); return e; }
    if (!create) throw err('NotFoundError');
    const f = new F(n, '', this); this.m.set(this.k(n), f); return f;
  }
  async removeEntry(n) { if (!this.m.delete(this.k(n))) throw err('NotFoundError'); }
  async *entries() { this.onEntries?.(); for (const e of [...this.m.values()]) yield [e.name, e]; }
  put(path, data) {
    const parts = path.split('/'); const name = parts.pop(); let d = this;
    for (const p of parts) { if (!d.m.has(d.k(p))) d.m.set(d.k(p), new D(p, this.ci)); d = d.m.get(d.k(p)); }
    d.m.set(d.k(name), new F(name, data, d));
  }
  names() { return [...this.m.values()].map(e => e.name).sort(); }
  sub(p) { return this.m.get(this.k(p)); }
  read(n) { return this.m.get(this.k(n))?.data; }
}
const mv = createMove();
const rootOf = (dir) => ({ id: 'r1', mode: 'fsa', handle: dir });

// S4: a case-sensitive disk holds IMG.JPG and img.jpg; renaming one onto the other is refused.
{
  const dir = new D('Photos', false);
  dir.put('IMG.JPG', 'A'.repeat(979)); dir.put('img.jpg', 'B'.repeat(943));
  const root = rootOf(dir);
  assert.equal(await mv.exists(root, 'img.jpg', 'IMG.JPG'), true, 'exists() sees the other file on a case-sensitive disk');
  await assert.rejects(mv.move(root, 'IMG.JPG', 'img.jpg'), /already exists/);
  assert.deepEqual(dir.names(), ['IMG.JPG', 'img.jpg'], 'both files are still there');
  assert.equal(dir.read('img.jpg').length, 943, 'the 943-byte photo is untouched');
}

// S4: a case-only rename with no other file works on both disks, with its sidecar, and
// leaves no temporary file.
for (const ci of [false, true]) {
  const dir = new D('Photos', ci);
  dir.put('IMG.JPG', 'one'); dir.put('IMG.JPG.xmp', 'side');
  const root = rootOf(dir);
  assert.equal(await mv.exists(root, 'img.jpg', 'IMG.JPG'), false, `the source itself does not count as taken (ci ${ci})`);
  await mv.move(root, 'IMG.JPG', 'img.jpg');
  assert.deepEqual(dir.names(), ['img.jpg', 'img.jpg.xmp'], `case-only rename (ci ${ci})`);
  assert.equal(dir.read('img.jpg'), 'one');
}

// S4: on a case-insensitive disk a rename onto another file whose name differs only by case is refused.
{
  const dir = new D('Photos', true);
  dir.put('a.jpg', 'A'); dir.put('B.jpg', 'B');
  await assert.rejects(mv.move(rootOf(dir), 'a.jpg', 'b.jpg'), /already exists/);
  assert.deepEqual(dir.names(), ['B.jpg', 'a.jpg']);
}

// S4: a file that appears at the target after the first check (another tab, a sync client)
// is not replaced, because the target is checked again straight before the move.
{
  const dir = new D('Photos', false);
  dir.put('a.jpg', 'mine'); dir.put('a.xmp', 'stem sidecar');
  dir.onEntries = () => { if (!dir.read('b.jpg')) dir.put('b.jpg', 'arrived later'); };
  await assert.rejects(mv.move(rootOf(dir), 'a.jpg', 'b.jpg'), /already exists/);
  assert.equal(dir.read('b.jpg'), 'arrived later', 'the late file is kept');
  assert.equal(dir.read('a.jpg'), 'mine', 'the source stays');
}

// S12: the paired Live Photo MOV moves with its still and takes the new stem.
for (const ci of [false, true]) {
  const dir = new D('Photos', ci);
  dir.put('IMG_2.HEIC', 'still'); dir.put('IMG_2.MOV', 'movie');
  const r = await mv.move(rootOf(dir), 'IMG_2.HEIC', 'Goa/beach.HEIC', { liveVideo: 'IMG_2.MOV' });
  assert.deepEqual(r, { liveVideo: 'Goa/beach.MOV' }, 'the new MOV path comes back');
  assert.deepEqual(dir.names(), ['Goa'], `nothing left behind (ci ${ci})`);
  assert.deepEqual(dir.sub('Goa').names(), ['beach.HEIC', 'beach.MOV']);
  assert.equal(dir.sub('Goa').read('beach.MOV'), 'movie');
}

// S12: a file already at the MOV's target refuses the whole move before anything moves.
{
  const dir = new D('Photos', false);
  dir.put('IMG_3.HEIC', 'still'); dir.put('IMG_3.MOV', 'movie'); dir.put('Goa/beach.MOV', 'other');
  await assert.rejects(mv.move(rootOf(dir), 'IMG_3.HEIC', 'Goa/beach.HEIC', { liveVideo: 'IMG_3.MOV' }), /Live Photo movie/);
  assert.deepEqual(dir.names(), ['Goa', 'IMG_3.HEIC', 'IMG_3.MOV']);
  assert.equal(dir.sub('Goa').read('beach.MOV'), 'other');
}

console.log('test-review-b-move: PASS');
