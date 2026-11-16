// Fixes from the promo capture (2026-11-17, items 4, 7, 8, 10 and Remove location):
// the empty-grid message of a locked Hidden view, header counts for panel views,
// stacks over Search by meaning results, the meaning panel's turn-on button, and
// Export's GPS removal from JPEG originals.
import assert from 'node:assert/strict';

globalThis.window ??= {}; // core/fs.js reads window at import time
const { emptyMessage, headCountText, rankedStackOf, meaningSwitch } = await import('../src/ui/library/view.js');
const { collapseStacks } = await import('../src/ui/library/grid-model.js');
const { buildStacks } = await import('../src/library/stacks.js');
const { removeGpsFromApp1, withoutLocation, exportZip } = await import('../src/library/export.js');
const { Library } = await import('../src/library/library.js');
const { memoryStore } = await import('../src/library/store.js');
const { newRecord } = await import('../src/library/schema.js');

let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

// ── item 4: a locked Hidden view says it is locked, even while jobs run ──────
await test('locked hidden view', () => {
  const locked = 'Hidden photos are locked. Unlock them to see them.';
  assert.equal(emptyMessage({ view: 'hidden', busy: true, hiddenLocked: true }), locked);
  assert.equal(emptyMessage({ view: 'hidden', busy: false, hiddenLocked: true }), locked);
  assert.equal(emptyMessage({ view: 'hidden', busy: true, hiddenLocked: false }), 'Reading your folders. Photos appear here as they are found.');
  assert.equal(emptyMessage({ view: 'hidden' }), 'No hidden photos.');
  assert.equal(emptyMessage({ view: 'timeline', busy: true, hiddenLocked: true }), 'Reading your folders. Photos appear here as they are found.');
});

// ── item 7: panel views never show "0 items" ─────────────────────────────────
await test('header count', () => {
  assert.equal(headCountText({ items: 3, selected: 0 }), '3 items');
  assert.equal(headCountText({ items: 1, selected: 1 }), '1 item, 1 selected');
  assert.equal(headCountText({ panel: { render() {} }, items: 0 }), '', 'a panel without countText shows no count');
  assert.equal(headCountText({ panel: { render() {}, countText: () => '12 people' }, items: 0 }), '12 people');
  assert.equal(headCountText({ panel: { render() {}, countText: () => { throw new Error('x'); } } }), '');
});

// ── item 8: meaning results collapse stacks, best score on top ───────────────
await test('ranked stacks', () => {
  const t0 = Date.UTC(2026, 0, 1, 12);
  const rec = (name, time) => ({ id: `r/${name}`, rootId: 'r', path: name, name, ext: 'jpg', kind: 'photo', camera: 'Pixel 9', timeSource: 'exif', time });
  const burst = [0, 1, 2, 3, 4].map(k => rec(`IMG_${10 + k}.jpg`, t0 - k * 300));
  const other = rec('beach.jpg', t0 - 86400000);
  const timeOrder = [...burst, other];
  const { stackOf } = buildStacks(timeOrder);
  assert.ok(stackOf.get(burst[0].id), 'the five frames form a burst stack');
  const scores = new Map([[burst[0].id, 0.21], [burst[1].id, 0.25], [burst[2].id, 0.31], [burst[3].id, 0.24], [burst[4].id, 0.22], [other.id, 0.28]]);
  const ranked = [...timeOrder].sort((a, b) => scores.get(b.id) - scores.get(a.id));
  const { items, members } = collapseStacks(ranked, rankedStackOf(stackOf, scores));
  assert.deepEqual(items.map(r => r.id), [burst[2].id, other.id], 'one tile per stack, in score order');
  assert.equal(members.get(burst[2].id)[0], burst[2].id, 'the best-scoring frame is the top');
  assert.equal(members.get(burst[2].id).length, 5);
  // The original stacks are left as they were.
  assert.notEqual(stackOf.get(burst[0].id).top, undefined);
  assert.ok(stackOf.get(burst[0].id) !== rankedStackOf(stackOf, scores).get(burst[0].id));
});

// ── item 10: a click before the weights check returns is held, not lost ──────
await test('meaning switch holds an early click', async () => {
  let resolveWeights;
  const weights = new Promise(r => { resolveWeights = r; });
  const calls = [];
  let changes = 0;
  const sw = meaningSwitch({ weights, enable: async (d) => { calls.push(d); await new Promise(r => setTimeout(r, 5)); }, onChange: () => { changes++; } });
  assert.equal(sw.dtype, null);
  assert.equal(sw.click(), 'held', 'a click during the check is kept');
  assert.equal(sw.busy, true);
  assert.equal(sw.click(), 'ignored', 'a second click does not queue a second download');
  assert.deepEqual(calls, []);
  resolveWeights('q8');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls, ['q8'], 'the held click turns the feature on once the check answers');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sw.busy, false);
  assert.ok(changes >= 3);
});

await test('meaning switch after the check', async () => {
  const calls = [];
  const sw = meaningSwitch({ weights: Promise.resolve('fp16'), enable: async (d) => { calls.push(d); } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sw.dtype, 'fp16');
  assert.equal(sw.click(), 'run');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls, ['fp16']);
});

await test('meaning switch: a failed enable frees the button', async () => {
  const sw = meaningSwitch({ weights: 'q8', enable: async () => { throw new Error('offline'); } });
  await new Promise(r => setTimeout(r, 0));
  sw.click();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(sw.busy, false);
});

// ── Remove location: a synthetic JPEG with GPS, a thumbnail and orientation 6 ─
// TIFF layout (big-endian): IFD0 at 8 (5 entries: Make, Orientation, ExifIFD, GPS, DNGVersion),
// Make value at 74, Exif IFD at 80 with DateTimeOriginal at 98, GPS IFD at 118 with its
// latitude at 148, IFD1 at 172 with a 16-byte thumbnail at 202. 218 bytes in all.
function makeApp1({ badIfd0 = false } = {}) {
  const tiff = new Uint8Array(218);
  const v = new DataView(tiff.buffer);
  v.setUint16(0, 0x4D4D); v.setUint16(2, 42); v.setUint32(4, badIfd0 ? 60000 : 8);
  const entry = (at, tag, type, count, value) => { v.setUint16(at, tag); v.setUint16(at + 2, type); v.setUint32(at + 4, count); v.setUint32(at + 8, value); };
  v.setUint16(8, 5);
  entry(10, 0x010F, 2, 6, 74);
  entry(22, 0x0112, 3, 1, 0); v.setUint16(30, 6);
  entry(34, 0x8769, 4, 1, 80);
  entry(46, 0x8825, 4, 1, 118);
  entry(58, 0xC612, 1, 4, 0x01040000);
  v.setUint32(70, 172);
  tiff.set(new TextEncoder().encode('Canon\0'), 74);
  v.setUint16(80, 1); entry(82, 0x9003, 2, 20, 98); v.setUint32(94, 0);
  tiff.set(new TextEncoder().encode('2026:01:01 12:00:00\0'), 98);
  v.setUint16(118, 2);
  entry(120, 0x0001, 2, 2, 0); tiff[128] = 0x4E;
  entry(132, 0x0002, 5, 3, 148);
  v.setUint32(144, 0);
  for (let i = 0; i < 24; i++) tiff[148 + i] = 0x11 + i;
  v.setUint16(172, 2); entry(174, 0x0201, 4, 1, 202); entry(186, 0x0202, 4, 1, 16); v.setUint32(198, 0);
  for (let i = 0; i < 16; i++) tiff[202 + i] = 0xA0 + i;
  const app1 = new Uint8Array(10 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xFFE1); a.setUint16(2, 8 + tiff.length); a.setUint32(4, 0x45786966); a.setUint16(8, 0);
  app1.set(tiff, 10);
  return app1;
}
function makeJpeg(app1) {
  const app0 = Uint8Array.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const body = Uint8Array.from([0xFF, 0xDB, 0x00, 0x04, 0x01, 0x02, 0xFF, 0xDA, 0x00, 0x02, 0x55, 0x66, 0x77, 0xFF, 0xD9]);
  const out = new Uint8Array(2 + app0.length + app1.length + body.length);
  out.set([0xFF, 0xD8]); out.set(app0, 2); out.set(app1, 2 + app0.length); out.set(body, 2 + app0.length + app1.length);
  return { bytes: out, app1At: 2 + app0.length };
}
const T = 10;

await test('GPS directory removed, every other byte kept', () => {
  const src = makeApp1();
  const out = removeGpsFromApp1(src);
  assert.equal(out.length, src.length);
  const v = new DataView(out.buffer, out.byteOffset + T);
  assert.equal(v.getUint16(8), 4, 'IFD0 has one entry fewer');
  const tags = [0, 1, 2, 3].map(i => v.getUint16(10 + i * 12));
  assert.deepEqual(tags, [0x010F, 0x0112, 0x8769, 0xC612], 'the GPS entry is gone; the entry after it moved up');
  assert.equal(v.getUint16(30), 6, 'orientation stays 6: the original pixels are not rotated');
  assert.equal(v.getUint32(46 + 8), 0x01040000, 'the moved entry keeps its value');
  assert.equal(v.getUint32(58), 172, 'IFD1 (the thumbnail) is still linked');
  for (let i = 118; i < 172; i++) assert.equal(out[T + i], 0, `GPS byte ${i} is zeroed`);
  // Every byte outside IFD0's entry block (8..74) and the GPS region (118..172) is the original.
  for (let i = 0; i < src.length; i++) {
    const t = i - T;
    if ((t >= 8 && t < 74) || (t >= 118 && t < 172)) continue;
    assert.equal(out[i], src[i], `byte ${i} unchanged`);
  }
  // Inside IFD0, the entries before GPS are unchanged too.
  for (let i = T + 8 + 2; i < T + 46; i++) assert.equal(out[i], src[i]);
});

await test('withoutLocation: JPEG file in, same length out, GPS gone', async () => {
  const { bytes, app1At } = makeJpeg(makeApp1());
  const file = new File([bytes], 'IMG_1.jpg', { type: 'image/jpeg', lastModified: 1234 });
  const r = await withoutLocation(file);
  assert.equal(r.change, 'gps');
  const out = new Uint8Array(await r.file.arrayBuffer());
  assert.equal(out.length, bytes.length);
  assert.equal(r.file.name, 'IMG_1.jpg');
  assert.equal(r.file.lastModified, 1234);
  assert.deepEqual(out.slice(0, app1At), bytes.slice(0, app1At), 'bytes before the EXIF block unchanged');
  const end = app1At + makeApp1().length;
  assert.deepEqual(out.slice(end), bytes.slice(end), 'image data after the EXIF block unchanged');
  // Running it again finds no GPS and returns the file untouched.
  const again = await withoutLocation(r.file);
  assert.equal(again.change, 'none');
  assert.equal(again.file, r.file);
});

await test('withoutLocation: non-JPEG and unreadable EXIF', async () => {
  const png = new File([Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])], 'a.png');
  const r1 = await withoutLocation(png);
  assert.equal(r1.change, 'none');
  assert.equal(r1.file, png, 'other files are copied as they are');
  const { bytes } = makeJpeg(makeApp1({ badIfd0: true }));
  const r2 = await withoutLocation(new File([bytes], 'b.jpg'));
  assert.equal(r2.change, 'exif', 'unreadable EXIF is removed whole, so no location can stay');
  const out = new Uint8Array(await r2.file.arrayBuffer());
  assert.equal(out.length, bytes.length - makeApp1().length);
});

await test('exportZip with removeLocation', async () => {
  const lib = new Library({ store: memoryStore(), saveDelay: 10_000 });
  lib.roots.set('r1', { id: 'r1', name: 'r1', handle: null, mode: 'files', added: 0, lastScan: 0, files: [] });
  const { bytes } = makeJpeg(makeApp1());
  const files = { 'a.jpg': new File([bytes], 'a.jpg'), 'b.heic': new File([Uint8Array.from([0, 0, 0, 24, 1, 2])], 'b.heic') };
  const ids = Object.keys(files).map(p => { const r = newRecord('r1', p, { size: files[p].size, lastModified: 1 }); lib.records.set(r.id, r); return r.id; });
  lib.getFile = async (id) => files[lib.get(id).path];
  const got = new Map();
  class ZipWriter { async add(name, reader) { got.set(name, new Uint8Array(await new Response(reader).arrayBuffer())); } async close() { return 'ZIP'; } }
  const r = await exportZip(lib, ids, { zipLib: { ZipWriter, BlobReader: class {} }, writer: {}, removeLocation: true });
  assert.equal(r.copied, 2);
  assert.equal(r.exifRemoved, 0);
  const a = got.get('a.jpg');
  assert.equal(a.length, bytes.length);
  assert.notDeepEqual(a, bytes, 'the JPEG lost its GPS');
  assert.deepEqual(got.get('b.heic'), new Uint8Array(await files['b.heic'].arrayBuffer()), 'HEIC copied as it is');
  const kept = new Map();
  class Z2 { async add(name, reader) { kept.set(name, new Uint8Array(await new Response(reader).arrayBuffer())); } async close() { return 'ZIP'; } }
  await exportZip(lib, ids, { zipLib: { ZipWriter: Z2, BlobReader: class {} }, writer: {} });
  assert.deepEqual(kept.get('a.jpg'), bytes, 'without the option the original is byte for byte');
});

console.log(`test-promo-b-fixes: ${n} tests passed`);
