// Google Takeout: matching JSON to photos, reading the JSON, scan.js applying it, and
// the zip import loop. Node only: fake directory handles, a fake zip module, memoryStore().
import assert from 'node:assert/strict';
import { matchSidecars, readTakeoutJson } from '../src/library/takeout.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { makeId, newRecord } from '../src/library/schema.js';
import { parseLibFile } from '../src/library/libfile.js';
import { scanRoot, applyTakeout } from '../src/library/scan.js';
import { importTakeoutZips, destPath } from '../src/ui/library/import.js';

let n = 0;
const failed = [];
const check = async (msg, fn) => {
  try { await fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message); }
};

// ── matching ────────────────────────────────────────────────────────────────
const longStem = 'Screenshot_20190714-180509_A_very_long_messaging_app_name_here';
const cutMedia = longStem.slice(0, 47) + '.jpg';
const cutJson = (longStem + '.jpg').slice(0, 46) + '.json';
const names = [
  'IMG_1.jpg', 'IMG_1.jpg.json',
  'IMG_2.jpg', 'IMG_2.jpg.supplemental-metadata.json',
  'IMG_3.jpg', 'IMG_3.jpg.supplemental-me.json',
  'IMG_4.jpg', 'IMG_4.jpg.s.json',
  'IMG_5.jpg', 'IMG_5.json',
  'IMG.jpg', 'IMG.jpg.json', 'IMG(1).jpg', 'IMG.jpg(1).json',
  'IMG(2).jpg', 'IMG.jpg.supplemental-metadata(2).json',
  'IMG(3).jpg', 'IMG.jpg(3).supplemental-metadata.json',
  cutMedia, cutJson,
  'PXL_20230615_101010123.MP.jpg', 'PXL_20230615_101010123.MP.jpg.supplemental-me.json',
  'IMG_6.jpg', 'IMG_6.jpg.json', 'IMG_6-edited.jpg',
  'Photo-01.jpg', 'Photo 01.jpg.json',
  'IMG_8.HEIC', 'IMG_8.HEIC.json', 'IMG_8.MP4',
  'Tom_Jerry.jpg', 'Tom&Jerry.jpg.json',
  'Lonely(1).jpg', 'Lonely.jpg.json', 'Lonely.jpg',
  'metadata.json', 'print-subscriptions.json',
  'Twin_a.jpg', 'Twin_b.jpg', 'Twin_c.jpg.json',
];
const m = matchSidecars(names);
const cases = [
  ['IMG_1.jpg', 'IMG_1.jpg.json', 'plain name.json'],
  ['IMG_2.jpg', 'IMG_2.jpg.supplemental-metadata.json', 'newer supplemental-metadata suffix'],
  ['IMG_3.jpg', 'IMG_3.jpg.supplemental-me.json', 'cut supplemental suffix'],
  ['IMG_4.jpg', 'IMG_4.jpg.s.json', 'suffix cut to one letter'],
  ['IMG_5.jpg', 'IMG_5.json', 'older stem-only JSON'],
  ['IMG.jpg', 'IMG.jpg.json', 'original of a counted name'],
  ['IMG(1).jpg', 'IMG.jpg(1).json', '(1) counter'],
  ['IMG(2).jpg', 'IMG.jpg.supplemental-metadata(2).json', '(2) counter after the supplemental suffix'],
  ['IMG(3).jpg', 'IMG.jpg(3).supplemental-metadata.json', '(3) counter before the supplemental suffix'],
  [cutMedia, cutJson, '47-character title truncation'],
  ['PXL_20230615_101010123.MP.jpg', 'PXL_20230615_101010123.MP.jpg.supplemental-me.json', 'Pixel motion photo with a cut suffix'],
  ['IMG_6-edited.jpg', 'IMG_6.jpg.json', '-edited copy shares the original JSON'],
  ['Photo-01.jpg', 'Photo 01.jpg.json', 'fuzzy: one character differs'],
  ['IMG_8.MP4', 'IMG_8.HEIC.json', 'fuzzy: live photo video shares the HEIC JSON'],
  ['Tom_Jerry.jpg', 'Tom&Jerry.jpg.json', '& in the title is _ in the file name'],
];
for (const [media, json, msg] of cases) {
  await check(`match: ${msg}`, () => assert.equal(m.get(media), json));
}
await check('match: IMG_8.HEIC keeps its own JSON', () => assert.equal(m.get('IMG_8.HEIC'), 'IMG_8.HEIC.json'));
await check('match: (1) copy with no counted JSON stays unmatched', () => assert.equal(m.has('Lonely(1).jpg'), false));
await check('match: two fuzzy candidates give no match', () => {
  assert.equal(m.has('Twin_a.jpg'), false);
  assert.equal(m.has('Twin_b.jpg'), false);
});
await check('match: album metadata.json and other JSON never match', () => {
  const used = new Set(m.values());
  assert.ok(!used.has('metadata.json') && !used.has('print-subscriptions.json'));
});
await check('match: JSON names are never keys', () => assert.ok([...m.keys()].every(k => !k.endsWith('.json'))));
await check('match: no JSON in the folder gives an empty map', () => assert.equal(matchSidecars(['a.jpg', 'b.png']).size, 0));

// ── reading ─────────────────────────────────────────────────────────────────
await check('read: full shape', () => {
  const t = readTakeoutJson(JSON.stringify({
    title: 'IMG_1.jpg', description: ' Beach at Goa ',
    creationTime: { timestamp: '1700000000', formatted: '…' },
    photoTakenTime: { timestamp: '1562167590', formatted: '3 Jul 2019, 15:26:30 UTC' },
    geoData: { latitude: 0.0, longitude: 0.0, altitude: 0 },
    geoDataExif: { latitude: 15.5527, longitude: 73.7517, altitude: 0 },
    people: [{ name: 'Asha' }, { name: 'Ravi' }, { name: 'Asha' }, {}],
    favorited: true, archived: true,
  }));
  assert.equal(t.time, 1562167590 * 1000, 'photoTakenTime, seconds to ms');
  assert.deepEqual([t.lat, t.lon], [15.5527, 73.7517], 'geoData 0,0 ignored, geoDataExif used');
  assert.equal(t.description, 'Beach at Goa');
  assert.deepEqual(t.people, ['Asha', 'Ravi']);
  assert.deepEqual([t.favorited, t.archived, t.trashed], [true, true, false]);
});
await check('read: creationTime when photoTakenTime is missing; geoData preferred', () => {
  const t = readTakeoutJson('{"creationTime":{"timestamp":"1600000000"},"geoData":{"latitude":51.5,"longitude":-0.12},"geoDataExif":{"latitude":1,"longitude":2},"trashed":true}');
  assert.equal(t.time, 1600000000000);
  assert.deepEqual([t.lat, t.lon], [51.5, -0.12]);
  assert.equal(t.trashed, true);
  assert.equal(t.description, '');
  assert.deepEqual(t.people, []);
});
await check('read: no time and only 0,0 places give nulls', () => {
  const t = readTakeoutJson('{"title":"Trip","geoData":{"latitude":0,"longitude":0}}');
  assert.equal(t.time, null);
  assert.equal(t.lat, null);
});
await check('read: not JSON, or an array, gives null', () => {
  assert.equal(readTakeoutJson('{oops'), null);
  assert.equal(readTakeoutJson('[]'), null);
});

// ── applyTakeout fills only what is empty ───────────────────────────────────
await check('apply: EXIF time and GPS win over Takeout', () => {
  const rec = Object.assign(newRecord('r1', 'a.jpg', { size: 1, lastModified: 5 }), { time: 42, timeSource: 'exif', lat: 1, lon: 2, xmpTags: ['trips'] });
  applyTakeout(rec, { time: 99, lat: 10, lon: 20, description: 'x', people: ['A/B'] });
  assert.deepEqual([rec.time, rec.timeSource, rec.lat, rec.lon], [42, 'exif', 1, 2]);
  assert.deepEqual(rec.xmpTags, ['trips', 'people/A-B'], 'a / in a name does not make a tag level');
  assert.equal(rec.takeout, true);
});

// ── scan.js applies Takeout JSON ────────────────────────────────────────────
const file = (name, bytes = 'x', mtime = 1000) => new File([bytes], name, { lastModified: mtime });
function fakeDir(name, tree) {
  const child = (k, v) => (v instanceof File ? { kind: 'file', name: k, getFile: async () => tree[k] } : fakeDir(k, v));
  return {
    kind: 'directory', name,
    async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, child(k, v)]; },
    async getDirectoryHandle(k) { if (!tree[k] || tree[k] instanceof File) throw new Error('NotFoundError'); return child(k, tree[k]); },
    async getFileHandle(k) { if (!(tree[k] instanceof File)) throw new Error('NotFoundError'); return child(k, tree[k]); },
    async queryPermission() { return 'granted'; },
    async isSameEntry(o) { return o === this; },
  };
}
function makeLib(libText = null) {
  const thumbs = { enqueue() {}, async remove() {}, async clear() {}, async url() { return null; } };
  const persist = { async load() { return libText ? parseLibFile(libText).file : null; }, async save() {}, canWrite: () => true };
  return new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist }, saveDelay: 5 });
}
const tj = (o) => file('j', JSON.stringify(o));
const takeoutTree = () => ({
  Trip: {
    'IMG_1.jpg': file('IMG_1.jpg'),
    'IMG_1.jpg.supplemental-metadata.json': tj({ photoTakenTime: { timestamp: '1562167590' }, geoData: { latitude: 15.5, longitude: 73.8 }, description: 'Sunset', people: [{ name: 'Asha' }], favorited: true }),
    'IMG_1-edited.jpg': file('IMG_1-edited.jpg'),
    'IMG_2.jpg': file('IMG_2.jpg'),
    'IMG_2.jpg.json': tj({ creationTime: { timestamp: '1600000000' }, archived: true, trashed: true }),
    'metadata.json': tj({ title: 'Trip', description: 'Album' }),
  },
});

await check('scan: Takeout JSON fills time, GPS, description and people; JSON is never a photo', async () => {
  const lib = makeLib();
  const root = await lib.addRoot({ handle: fakeDir('Takeout', takeoutTree()), name: 'Takeout' });
  const recs = [...lib.records.values()];
  assert.equal(recs.length, 3, `3 photos indexed, got ${recs.map(r => r.path).join(', ')}`);
  assert.ok(recs.every(r => r.ext !== 'json'));
  const r1 = lib.get(makeId(root.id, 'Trip/IMG_1.jpg'));
  assert.equal(r1.time, 1562167590000);
  assert.equal(r1.timeSource, 'takeout');
  assert.deepEqual([r1.lat, r1.lon], [15.5, 73.8]);
  assert.equal(r1.description, 'Sunset');
  assert.deepEqual(r1.xmpTags, ['people/Asha']);
  const ed = lib.get(makeId(root.id, 'Trip/IMG_1-edited.jpg'));
  assert.equal(ed.time, 1562167590000, 'the edited copy reads the original JSON');
});

await check('scan: favourite, archived and trashed become choices once', async () => {
  const lib = makeLib();
  const root = await lib.addRoot({ handle: fakeDir('Takeout', takeoutTree()), name: 'Takeout' });
  const id1 = makeId(root.id, 'Trip/IMG_1.jpg'), id2 = makeId(root.id, 'Trip/IMG_2.jpg');
  assert.equal(lib.choice(id1).fav, true);
  assert.equal(lib.choice(id2).hidden, true);
  assert.equal(lib.choice(id2).flag, 'reject', 'trashed in Google becomes the reject flag, not Slate trash');
  assert.equal(lib.choice(id2).trashed, null);
  await lib.setFavourite([id1], false);
  const res = await scanRoot(lib, root, { full: true });
  assert.equal(lib.choice(id1).fav, false, 'a rescan does not bring the favourite back');
  assert.equal(res.takeout.matched, 3);
  assert.equal(res.takeout.favourites, 0);
});

await check('scan: an existing library-file entry keeps Takeout choices out', async () => {
  const lib = makeLib(JSON.stringify({ format: 'slate-library', version: 1, items: { 'Trip/IMG_2.jpg': { rating: 3 } }, albums: [] }));
  const root = await lib.addRoot({ handle: fakeDir('Takeout', takeoutTree()), name: 'Takeout' });
  const c = lib.choice(makeId(root.id, 'Trip/IMG_2.jpg'));
  assert.deepEqual([c.rating, c.hidden, c.flag], [3, false, null]);
  assert.equal(lib.choice(makeId(root.id, 'Trip/IMG_1.jpg')).fav, true);
});

await check('scan: Takeout details are saved once as meta and survive a rebuild with the JSON gone', async () => {
  let saved = null;
  const thumbs = { enqueue() {}, async remove() {}, async clear() {}, async url() { return null; } };
  const persist = { async load() { return saved; }, async save(_r, f) { saved = parseLibFile(JSON.stringify(f)).file; }, canWrite: () => true };
  const lib = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist }, saveDelay: 5 });
  const tree = takeoutTree();
  const root = await lib.addRoot({ handle: fakeDir('Takeout', tree), name: 'Takeout' });
  await lib.flush();
  const meta = saved.items['Trip/IMG_1.jpg'].meta;
  assert.deepEqual(meta, { taken: '2019-07-03T15:26:30', lat: 15.5, lon: 73.8, caption: 'Sunset', people: ['Asha'], source: 'takeout' });
  // A changed JSON is not read again once meta exists.
  tree.Trip['IMG_1.jpg.supplemental-metadata.json'] = tj({ photoTakenTime: { timestamp: '1000' }, description: 'Changed' });
  await scanRoot(lib, root, { full: true });
  const id1 = makeId(root.id, 'Trip/IMG_1.jpg');
  assert.equal(lib.get(id1).description, 'Sunset', 'the JSON is not re-read');
  // Rebuild with every JSON removed: the details come back from the library file.
  for (const k of Object.keys(tree.Trip)) if (k.endsWith('.json')) delete tree.Trip[k];
  const fresh = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist }, saveDelay: 5 });
  await fresh.addRoot({ handle: fakeDir('Takeout', tree), name: 'Takeout' });
  await fresh.rebuild();
  const r1 = [...fresh.records.values()].find(r => r.path === 'Trip/IMG_1.jpg');
  assert.deepEqual([r1.time, r1.timeSource, r1.lat, r1.lon, r1.description], [1562167590000, 'takeout', 15.5, 73.8, 'Sunset']);
  assert.deepEqual(r1.xmpTags, ['people/Asha']);
  const r2 = [...fresh.records.values()].find(r => r.path === 'Trip/IMG_2.jpg');
  assert.equal(r2.time, 1600000000000, 'a creationTime date survives too');
});

// ── zip import loop ─────────────────────────────────────────────────────────
await check('import: destPath keeps album folders and drops Takeout/<product>', () => {
  assert.deepEqual(destPath('Takeout/Google Photos/Trip 2024/IMG_1.jpg'), ['Trip 2024', 'IMG_1.jpg']);
  assert.deepEqual(destPath('Takeout/Google Fotos/Fotos von 2019/IMG_1.jpg.json'), ['Fotos von 2019', 'IMG_1.jpg.json']);
  assert.equal(destPath('Takeout/archive_browser.html'), null);
  assert.equal(destPath('Takeout/Google Photos/../evil.jpg'), null);
  assert.equal(destPath('Takeout/Google Photos/Trip/.hidden.jpg'), null);
  assert.deepEqual(destPath('Takeout/Google Photos/A:B/x.jpg'), ['A_B', 'x.jpg']);
});

function memDir(name) {
  const files = new Map(), dirs = new Map();
  return {
    kind: 'directory', name, files, dirs,
    async getDirectoryHandle(k, { create } = {}) {
      if (!dirs.has(k)) { if (!create) throw new Error('NotFoundError'); dirs.set(k, memDir(k)); }
      return dirs.get(k);
    },
    async getFileHandle(k, { create } = {}) {
      if (!files.has(k) && !create) throw new Error('NotFoundError');
      return {
        getFile: async () => new File([files.get(k) ?? ''], k),
        createWritable: async () => {
          const parts = [];
          return { async write(b) { parts.push(b); }, async close() { files.set(k, parts.join('')); }, async abort() {} };
        },
      };
    },
  };
}
const fakeZip = {
  BlobReader: class { constructor(z) { this.z = z; } },
  ZipReader: class {
    constructor(r) { this.z = r.z; }
    async getEntries() {
      return this.z.map(([filename, data]) => ({
        filename, directory: filename.endsWith('/'), uncompressedSize: data?.length ?? 0,
        async getData(w) { if (data === null) throw new Error('bad entry'); await w.write(data); },
      }));
    }
    async close() {}
  },
};

await check('import: parts one at a time, album folders kept, same-size files skipped', async () => {
  const dest = memDir('Takeout');
  const part1 = [['Takeout/', ''], ['Takeout/Google Photos/', ''], ['Takeout/Google Photos/Trip/IMG_1.jpg', 'abc'],
    ['Takeout/Google Photos/Trip/IMG_1.jpg.json', '{}'], ['Takeout/archive_browser.html', '<html>']];
  const part2 = [['Takeout/Google Photos/Photos from 2019/IMG_2.jpg', 'defg'], ['Takeout/Google Photos/Trip/bad.jpg', null]];
  const seen = [];
  let res = await importTakeoutZips({ zips: [part1, part2], dest, zipLib: fakeZip, onProgress: p => seen.push(p.part) });
  assert.deepEqual(res, { written: 3, skipped: 0, failed: 1, bytes: 9 });
  assert.equal(dest.dirs.get('Trip').files.get('IMG_1.jpg'), 'abc');
  assert.equal(dest.dirs.get('Photos from 2019').files.get('IMG_2.jpg'), 'defg');
  assert.ok(!dest.files.has('archive_browser.html'));
  assert.deepEqual([...new Set(seen)], [1, 2]);
  res = await importTakeoutZips({ zips: [part1], dest, zipLib: fakeZip });
  assert.deepEqual([res.written, res.skipped], [0, 2], 'a second run skips files already there');
});

console.log(`test-library-takeout: ${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
