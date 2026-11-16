// Scan, metadata and the pure parts of thumbnails. Node only: a fake
// FileSystemDirectoryHandle over Node File objects, memoryStore() and a real Library.
import assert from 'node:assert/strict';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { wallClockToTime, makeId } from '../src/library/schema.js';
import { readMetadata, parseWallClock } from '../src/library/metadata.js';
import { scanRoot, BATCH } from '../src/library/scan.js';
import { initWatch, status as watchStatus } from '../src/library/watch.js';
import { thumbName, createUrlCache, fitSize, bytesToDataUrl } from '../src/library/thumbs.js';

// ── a minimal JPEG with an EXIF APP1 block ───────────────────────────────────
// entries: [tag, type, value]; type 2 ASCII (string), 3 SHORT, 4 LONG, 5 RATIONAL ([[n, d], ...]).
function tiff(ifds) {
  const SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 };
  const count = (t, v) => (t === 2 ? v.length + 1 : t === 5 ? v.length : 1);
  const bytesOf = (t, v) => count(t, v) * SIZE[t];
  // Lay out: header, then each IFD followed by its out-of-line values.
  let off = 8;
  const at = ifds.map(ifd => {
    const start = off;
    off += 2 + 12 * ifd.length + 4;
    for (const [, t, v] of ifd) { const n = bytesOf(t, v); if (n > 4) off += n + (n & 1); }
    return start;
  });
  const buf = new Uint8Array(off), dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
  ifds.forEach((ifd, k) => {
    let p = at[k], data = p + 2 + 12 * ifd.length + 4;
    dv.setUint16(p, ifd.length, true); p += 2;
    for (const [tag, t, raw] of ifd) {
      const v = typeof raw === 'function' ? raw(at) : raw;
      dv.setUint16(p, tag, true); dv.setUint16(p + 2, t, true); dv.setUint32(p + 4, count(t, v), true);
      const n = bytesOf(t, v);
      let w = n > 4 ? data : p + 8;
      if (n > 4) { dv.setUint32(p + 8, data, true); data += n + (n & 1); }
      if (t === 2) { for (const c of v) buf[w++] = c.charCodeAt(0); buf[w] = 0; }
      else if (t === 3) dv.setUint16(w, v, true);
      else if (t === 4) dv.setUint32(w, v, true);
      else for (const [a, b] of v) { dv.setUint32(w, a, true); dv.setUint32(w + 4, b, true); w += 8; }
      p += 12;
    }
    dv.setUint32(p, 0, true);
  });
  return buf;
}
function jpegWithExif({ date = '2023:07:14 18:05:09', orient = 6 } = {}) {
  const t = tiff([
    [[0x010F, 2, 'Canon'], [0x0110, 2, 'Canon EOS R6'], [0x0112, 3, orient], [0x8769, 4, at => at[1]], [0x8825, 4, at => at[2]]],
    [[0x9003, 2, date], [0xA002, 4, 6000], [0xA003, 4, 4000], [0xA434, 2, 'RF24-105mm F4 L IS USM']],
    [[0x0001, 2, 'N'], [0x0002, 5, [[12, 1], [58, 1], [1200, 100]]], [0x0003, 2, 'E'], [0x0004, 5, [[77, 1], [35, 1], [0, 1]]]],
  ]);
  const head = new TextEncoder().encode('Exif\0\0');
  const len = 2 + head.length + t.length;
  return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, len >> 8, len & 0xFF, ...head, ...t, 0xFF, 0xD9]);
}

// ── fake folder ──────────────────────────────────────────────────────────────
const file = (name, bytes = 'x', mtime = 1000) => new File([bytes], name, { lastModified: mtime });
function fakeDir(name, tree, perm) {
  const child = (n, v) => (v instanceof File
    ? { kind: 'file', name: n, getFile: async () => { if (!(n in tree)) throw new Error('gone'); return tree[n]; } }
    : fakeDir(n, v, perm));
  return {
    kind: 'directory', name,
    async *entries() { for (const [n, v] of Object.entries(tree)) yield [n, child(n, v)]; },
    async getDirectoryHandle(n) { if (!tree[n] || tree[n] instanceof File) throw new Error('NotFoundError'); return child(n, tree[n]); },
    async getFileHandle(n) { if (!(tree[n] instanceof File)) throw new Error('NotFoundError'); return child(n, tree[n]); },
    async queryPermission() { return perm.state; },
    async requestPermission() { perm.asked++; if (perm.grant) perm.state = 'granted'; return perm.state; },
  };
}

function makeLib() {
  const thumbs = { got: [], enqueue(r) { this.got.push(...r); for (const x of r) x.thumb = 'ok'; }, async remove() {}, async clear() {}, async url() { return null; } };
  const lib = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist: { async load() { return null; }, async save() {}, canWrite: () => true } }, saveDelay: 5 });
  return { lib, thumbs };
}

// ── metadata ─────────────────────────────────────────────────────────────────
{
  const f = file('IMG_1.jpg', jpegWithExif());
  const m = await readMetadata(f, { kind: 'photo', ext: 'jpg' });
  assert.equal(m.time, wallClockToTime(2023, 7, 14, 18, 5, 9), 'EXIF wall clock, no zone shift');
  assert.equal(m.timeSource, 'exif');
  assert.equal(m.orient, 6);
  assert.deepEqual([m.w, m.h], [4000, 6000], 'orientation 6 swaps width and height');
  assert.equal(m.camera, 'Canon EOS R6', 'model already names the make');
  assert.equal(m.lens, 'RF24-105mm F4 L IS USM');
  assert.ok(Math.abs(m.lat - (12 + 58 / 60 + 12 / 3600)) < 1e-6, `latitude ${m.lat}`);
  assert.ok(Math.abs(m.lon - (77 + 35 / 60)) < 1e-6, `longitude ${m.lon}`);
  const upright = await readMetadata(file('a.jpg', jpegWithExif({ orient: 1 })), { kind: 'photo', ext: 'jpg' });
  assert.deepEqual([upright.w, upright.h], [6000, 4000]);
  assert.deepEqual(await readMetadata(file('junk.jpg', 'not a jpeg at all'), { kind: 'photo', ext: 'jpg' }), {}, 'unreadable gives {}');
  assert.deepEqual(await readMetadata(file('clip.mp4', 'x'), { kind: 'video', ext: 'mp4' }), {});
  assert.equal(parseWallClock('0000:00:00 00:00:00'), null);
  assert.equal(parseWallClock('2024-03-01T09:15:30+05:30'), wallClockToTime(2024, 3, 1, 9, 15, 30));
}

// ── scan: walk, skip, unchanged, missing, sidecar ────────────────────────────
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4">
<dc:subject><rdf:Bag><rdf:li>beach</rdf:li><rdf:li>family</rdf:li></rdf:Bag></dc:subject>
</rdf:Description></rdf:RDF></x:xmpmeta>`;
{
  const tree = {
    'top.jpg': file('top.jpg', jpegWithExif()),
    'notes.txt': file('notes.txt'),
    '2024': { goa: { 'a.jpg': file('a.jpg'), 'a.jpg.xmp': file('a.jpg.xmp', XMP), 'clip.mp4': file('clip.mp4') }, 'b.png': file('b.png') },
    '.slate-trash': { 'old.jpg': file('old.jpg') },
    '.thumbs': { 'c.jpg': file('c.jpg') },
  };
  const perm = { state: 'granted', asked: 0, grant: true };
  const { lib, thumbs } = makeLib();
  await lib.load();
  const root = await lib.addRoot({ handle: fakeDir('Photos', tree, perm), name: 'Photos' });
  const ids = [...lib.records.keys()].sort();
  const id = p => makeId(root.id, p);
  assert.deepEqual(ids, [id('.slate-trash/old.jpg'), id('2024/b.png'), id('2024/goa/a.jpg'), id('2024/goa/clip.mp4'), id('top.jpg')].sort(), 'recursive walk; dot-folders and non-media skipped; a file found in .slate-trash becomes a trashed record (review S2)');
  assert.ok(lib.choice(id('.slate-trash/old.jpg')).trashed, 'the file in .slate-trash is in the Trash view');
  assert.equal(lib.get(id('2024/goa/clip.mp4')).kind, 'video');
  assert.equal(lib.get(id('top.jpg')).camera, 'Canon EOS R6');
  const a = lib.get(id('2024/goa/a.jpg'));
  assert.equal(a.sidecar, true);
  assert.deepEqual(a.xmpTags, ['beach', 'family'], 'sidecar tags apply');
  assert.equal(a.xmpRating, 4, 'sidecar rating applies');
  assert.deepEqual(lib.search({ tag: 'beach' }).map(r => r.id), [a.id]);
  assert.equal(thumbs.got.length, 5, 'new records, and the file recovered from .slate-trash, go to thumbnails');
  assert.equal(lib.jobs.status().kinds.scan.done, 4, 'metadata reads counted on lib.jobs as scan');

  // Rescan: nothing changed, nothing re-read.
  const before = lib.get(id('top.jpg'));
  before.thumb = null; // as if the tab closed before its thumbnail was made
  thumbs.got.length = 0;
  let res = await scanRoot(lib, root, {});
  assert.deepEqual(res, { added: 0, changed: 0, unchanged: 4, missing: 0, failed: 0 });
  assert.equal(lib.get(id('top.jpg')), before, 'unchanged record is not re-read');
  assert.deepEqual(thumbs.got.map(r => r.path), ['top.jpg'], 'an unchanged record with no thumbnail is queued again');
  thumbs.got.length = 0;

  // A changed file, a new file and a deleted file.
  tree['top.jpg'] = file('top.jpg', jpegWithExif({ date: '2020:01:02 03:04:05' }), 2000);
  tree['2024']['new.webp'] = file('new.webp');
  delete tree['2024']['b.png'];
  res = await scanRoot(lib, root, {});
  assert.deepEqual(res, { added: 1, changed: 1, unchanged: 2, missing: 1, failed: 0 });
  assert.equal(lib.get(id('top.jpg')).time, wallClockToTime(2020, 1, 2, 3, 4, 5));
  assert.equal(lib.get(id('2024/b.png')).missing, true, 'a deleted file becomes missing');
  assert.deepEqual(thumbs.got.map(r => r.path).sort(), ['2024/new.webp', 'top.jpg']);

  // A full rescan re-reads everything.
  res = await scanRoot(lib, root, { full: true });
  assert.equal(res.changed, 4);

  // An edited sidecar alone makes the photo re-read.
  tree['2024'].goa['a.jpg.xmp'] = file('a.jpg.xmp', XMP.replace('xmp:Rating="4"', 'xmp:Rating="2"'), Date.now() + 1000);
  res = await scanRoot(lib, root, {});
  assert.equal(res.changed, 1);
  assert.equal(lib.get(id('2024/goa/a.jpg')).xmpRating, 2);

  // Permission refused.
  perm.state = 'prompt'; perm.grant = false;
  await assert.rejects(scanRoot(lib, root, {}), e => e.code === 'permission');
  assert.equal(perm.asked, 1, 'requestPermission is tried once');
  perm.grant = true;
  await scanRoot(lib, root, {});
  assert.equal(perm.state, 'granted');
}

// ── files root (browse-only) ─────────────────────────────────────────────────
{
  const rel = (path, bytes) => { const f = file(path.split('/').pop(), bytes); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f; };
  const files = [rel('Pick/x.jpg'), rel('Pick/sub/y.heic'), rel('Pick/.hidden/z.jpg'), rel('Pick/sub/y.xmp', XMP)];
  const { lib } = makeLib();
  await lib.load();
  const root = await lib.addRoot({ handle: null, name: 'Pick', files });
  assert.deepEqual([...lib.records.values()].map(r => r.path).sort(), ['sub/y.heic', 'x.jpg']);
  assert.deepEqual(lib.get(makeId(root.id, 'sub/y.heic')).xmpTags, ['beach', 'family'], 'stem-named sidecar applies');
}

// ── batching ─────────────────────────────────────────────────────────────────
{
  const tree = {};
  for (let d = 0; d < 12; d++) { const sub = tree[`d${d}`] = {}; for (let i = 0; i < 100; i++) sub[`p${i}.jpg`] = file(`p${i}.jpg`); }
  const { lib } = makeLib();
  await lib.load();
  const calls = [];
  const orig = lib.applyScan.bind(lib);
  lib.applyScan = (rootId, arg) => { calls.push({ n: arg.upserts.length, seen: arg.seen?.size ?? null }); return orig(rootId, arg); };
  await lib.addRoot({ handle: fakeDir('Big', tree, { state: 'granted', asked: 0 }), name: 'Big' });
  assert.equal(lib.records.size, 1200);
  assert.ok(calls.length >= 3, `applyScan called ${calls.length} times`);
  assert.ok(calls.slice(0, -1).every(c => c.n >= BATCH && c.seen === null), 'batches of about 500 without seen');
  assert.equal(calls.at(-1).seen, 1200, 'final call carries seen');
}

// ── thumbs: pure parts ───────────────────────────────────────────────────────
{
  const n = thumbName('r1/2024/a.jpg');
  assert.match(n, /^[0-9a-f]{16}\.webp$/);
  assert.equal(thumbName('r1/2024/a.jpg'), n, 'stable');
  const names = new Set(Array.from({ length: 20000 }, (_, i) => thumbName(`r1/f/${i}.jpg`)));
  assert.equal(names.size, 20000, 'no collisions in 20,000 ids');

  const revoked = [];
  const c = createUrlCache(3, u => revoked.push(u));
  c.set('a', 'u1'); c.set('b', 'u2'); c.set('c', 'u3');
  c.get('a');                 // a is now most recent
  c.set('d', 'u4');           // evicts b
  assert.deepEqual(revoked, ['u2']);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.size, 3);
  c.set('a', 'u5');           // replacing revokes the old URL
  assert.deepEqual(revoked, ['u2', 'u1']);
  c.delete('c'); c.clear();
  assert.deepEqual(revoked.sort(), ['u1', 'u2', 'u3', 'u4', 'u5']);

  assert.deepEqual(fitSize(6000, 4000), { w: 256, h: 171, scale: 256 / 6000 });
  assert.deepEqual([fitSize(6000, 4000, 6).w, fitSize(6000, 4000, 6).h], [171, 256], 'orientation 6 is portrait');
  assert.equal(fitSize(160, 120).scale, 1, 'never upscales');
  assert.match(bytesToDataUrl(new Uint8Array([0x52, 0x49, 0x46, 0x46])), /^data:image\/webp;base64,UklGRg==$/);
}

// ── Live Photos in a scan (row M7) ───────────────────────────────────────────
{
  const { lib } = makeLib();
  const tree = { 'IMG_1.HEIC': file('IMG_1.HEIC', 'h'), 'IMG_1.MOV': file('IMG_1.MOV', 'm'), 'IMG_2.MOV': file('IMG_2.MOV', 'v') };
  const root = await lib.addRoot({ handle: fakeDir('Live', tree, { state: 'granted', asked: 0 }), name: 'Live' });
  assert.equal(lib.get(makeId(root.id, 'IMG_1.HEIC')).liveVideo, 'IMG_1.MOV');
  assert.equal(lib.get(makeId(root.id, 'IMG_1.MOV')), null, 'a paired MOV has no tile');
  assert.equal(lib.get(makeId(root.id, 'IMG_2.MOV')).kind, 'video', 'an unpaired MOV stays a video');
  // Removing the MOV re-reads the photo even though the photo itself did not change.
  delete tree['IMG_1.MOV'];
  const res = await scanRoot(lib, root, {});
  assert.equal(res.changed, 1);
  assert.equal(lib.get(makeId(root.id, 'IMG_1.HEIC')).liveVideo, undefined);
}

// ── watching folders (row L9) with a fake FileSystemObserver ─────────────────
{
  const made = [];
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.handles = []; this.off = false; made.push(this); }
    async observe(h, opts) { if (h.name === 'NoPerm') throw new Error('NotAllowedError'); assert.equal(opts.recursive, true); this.handles.push(h); }
    disconnect() { this.off = true; }
    fire(parts, type = 'modified') { this.cb([{ type, relativePathComponents: parts }], this); }
  }
  const rescans = [];
  const listeners = new Map();
  const lib = {
    roots: new Map([['a', { id: 'a', name: 'A', handle: { name: 'A' } }], ['b', { id: 'b', name: 'B', handle: { name: 'B' } }], ['f', { id: 'f', name: 'F', handle: null }]]),
    on(t, fn) { listeners.set(t, fn); return () => listeners.delete(t); },
    async rescan(id) { rescans.push(id); },
  };
  assert.equal(initWatch(lib, { Observer: undefined }).status(), 'unavailable', 'no FileSystemObserver: nothing happens');
  assert.equal(watchStatus(), 'unavailable');

  const w = initWatch(lib, { Observer: FakeObserver, delay: 20 });
  await w.ready;
  assert.equal(made.length, 2, 'one observer per fsa root, none for a browse-only root');
  assert.equal(w.status(), 'watching');
  assert.equal(watchStatus(), 'watching');
  const [oa, ob] = made;
  oa.fire(['trip', 'IMG_1.jpg']); oa.fire(['IMG_2.jpg']); oa.fire(['IMG_3.jpg']);
  ob.fire(['.slate-library.json']); ob.fire(['.slate-trash', 'x.jpg']);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(rescans, ['a'], 'debounced to one rescan, only of the root that changed; dot-files ignored');

  // A removed root stops being watched; an added one starts, and one without permission is skipped.
  lib.roots.delete('b');
  lib.roots.set('c', { id: 'c', name: 'NoPerm', handle: { name: 'NoPerm' } });
  listeners.get('roots')();
  await w.ready;
  assert.equal(ob.off, true);
  assert.equal(made.length, 3);
  assert.equal(made[2].off, true, 'a folder that cannot be observed is let go');
  w.stop();
  assert.equal(oa.off, true);
  assert.equal(watchStatus(), 'unavailable');
}

// ── library-file meta: EXIF beats it, a plain file takes it ───────────────────
{
  const meta = { taken: '2019-07-03T15:26:30', lat: 15.5, lon: 73.8, caption: 'Sunset', source: 'takeout' };
  const text = JSON.stringify({ format: 'slate-library', version: 1, items: { 'exif.jpg': { meta }, 'plain.jpg': { meta } }, albums: [] });
  const { parseLibFile } = await import('../src/library/libfile.js');
  const thumbs = { enqueue() {}, async remove() {}, async clear() {}, async url() { return null; } };
  const lib = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist: { async load() { return parseLibFile(text).file; }, async save() {}, canWrite: () => true } }, saveDelay: 5 });
  const root = await lib.addRoot({ handle: fakeDir('M', { 'exif.jpg': file('exif.jpg', jpegWithExif()), 'plain.jpg': file('plain.jpg', 'x') }, { state: 'granted' }), name: 'M' });
  const ex = lib.get(makeId(root.id, 'exif.jpg')), pl = lib.get(makeId(root.id, 'plain.jpg'));
  assert.deepEqual([ex.time, ex.timeSource], [wallClockToTime(2023, 7, 14, 18, 5, 9), 'exif'], 'EXIF beats meta');
  assert.equal(ex.description, 'Sunset', 'a caption from meta still fills in');
  assert.deepEqual([pl.time, pl.timeSource, pl.lat, pl.lon], [wallClockToTime(2019, 7, 3, 15, 26, 30), 'takeout', 15.5, 73.8], 'a file with no EXIF takes meta');
}

console.log('test-library-scan: all passed');
