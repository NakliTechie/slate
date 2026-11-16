// iCloud export details (spec row I5): CSV parsing and applying favourites,
// hidden, albums and missing dates to a root's photos, matched by file name.
import assert from 'node:assert/strict';
import { parseCsv, parseICloudCsv, parseICloudDate, applyICloudCsv } from '../src/library/icloud.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord, wallClockToTime } from '../src/library/schema.js';
import { instantToWallClock as W } from '../src/library/takeout.js'; // CSV dates are GMT instants, stored as the local wall clock (review S9)

// ── CSV ───────────────────────────────────────────────────────────────────
{
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'BOM and CRLF');
  assert.deepEqual(parseCsv('name,date\n"IMG, 1.jpg","Saturday March 18,2023 3:26 PM GMT"\n'),
    [['name', 'date'], ['IMG, 1.jpg', 'Saturday March 18,2023 3:26 PM GMT']], 'commas inside quotes');
  assert.deepEqual(parseCsv('a\n"say ""hi"""\n"two\nlines"'), [['a'], ['say "hi"'], ['two\nlines']], 'escaped quotes and a newline in quotes, no final newline');
  assert.deepEqual(parseCsv('a,,c\n\n'), [['a', '', 'c']], 'empty field kept, blank line dropped');
  assert.deepEqual(parseCsv(''), []);
}

// ── dates ─────────────────────────────────────────────────────────────────
{
  assert.equal(parseICloudDate('Saturday March 18,2023 3:26 PM GMT'), wallClockToTime(2023, 3, 18, 15, 26, 0));
  assert.equal(parseICloudDate('Monday January 2, 2023 12:05 AM GMT'), wallClockToTime(2023, 1, 2, 0, 5, 0), '12 AM is midnight');
  assert.equal(parseICloudDate('Monday January 2,2023 12:05 PM GMT'), wallClockToTime(2023, 1, 2, 12, 5, 0), '12 PM is noon');
  assert.equal(parseICloudDate('2021-07-04 23:59:59'), wallClockToTime(2021, 7, 4, 23, 59, 59));
  assert.equal(parseICloudDate(''), null);
  assert.equal(parseICloudDate('soon'), null);
}

// ── files ─────────────────────────────────────────────────────────────────
const DETAILS = '﻿imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate,viewCount,importDate\r\n'
  + 'IMG_0001.HEIC,abc=,yes,no,no,"Saturday March 18,2023 3:26 PM GMT",3,"Saturday March 18,2023 3:30 PM GMT"\r\n'
  + 'IMG_0002.JPG,def=,no,yes,no,"Sunday March 19,2023 9:00 AM GMT",0,\r\n'
  + '"IMG, odd.JPG",ghi=,yes,no,no,"Monday March 20,2023 10:00 AM GMT",0,\r\n'
  + 'IMG_0004.JPG,jkl=,no,no,yes,"Tuesday March 21,2023 10:00 AM GMT",0,\r\n'
  + 'NOT_HERE.JPG,mno=,yes,no,no,,0,\r\n';
const ALBUM = 'Images\nIMG_0001.HEIC\nimg_0002.jpg\nMISSING.JPG\n';
{
  const d = parseICloudCsv('Photo Details.csv', DETAILS);
  assert.equal(d.kind, 'details');
  assert.equal(d.rows.length, 5);
  assert.deepEqual(d.rows[0], { name: 'IMG_0001.HEIC', favourite: true, hidden: false, deleted: false, time: W(wallClockToTime(2023, 3, 18, 15, 26, 0)) });
  assert.equal(d.rows[2].name, 'IMG, odd.JPG');
  assert.equal(d.rows[3].deleted, true);
  assert.equal(d.rows[4].time, null);
  const a = parseICloudCsv('iCloud Photos/Albums/Goa 2023.csv', ALBUM);
  assert.deepEqual(a, { kind: 'album', album: 'Goa 2023', names: ['IMG_0001.HEIC', 'img_0002.jpg', 'MISSING.JPG'] });
  assert.equal(parseICloudCsv('Memories.csv', 'a,b\n1,2\n').kind, 'unknown');
}

// ── apply ─────────────────────────────────────────────────────────────────
{
  const files = [
    ['2023/IMG_0001.HEIC', { timeSource: 'file', time: 5 }],
    ['2023/IMG_0002.JPG', { timeSource: 'exif', time: wallClockToTime(2020, 1, 1) }],
    ['other/IMG, odd.JPG', { timeSource: 'file', time: 7 }],
    ['IMG_0004.JPG', { timeSource: 'file', time: 9 }],
  ];
  const store = memoryStore();
  const lib = new Library({ store, services: {
    scanRoot: async (l, root) => l.applyScan(root.id, { upserts: files.map(([p, f]) => ({ ...newRecord(root.id, p, { size: 1, lastModified: 1 }), ...f })) }),
  } });
  await lib.load();
  const root = await lib.addRoot({ name: 'iCloud', files: [] });
  const id = (p) => `${root.id}/${p}`;
  const csv = [{ name: 'Photo Details.csv', text: DETAILS }, { name: 'Albums/Goa 2023.csv', text: ALBUM }, { name: 'Memories.csv', text: 'a,b\n1,2' }];

  const dry = await applyICloudCsv(lib, root.id, csv, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.matched, 4);
  assert.equal(dry.unmatched, 2);
  assert.deepEqual(dry.unmatchedNames.sort(), ['MISSING.JPG', 'NOT_HERE.JPG']);
  assert.equal(dry.favourites, 2);
  assert.equal(dry.hidden, 1);
  assert.equal(dry.dates, 3, 'dates only for photos with no date of their own');
  assert.deepEqual(dry.albums, [{ name: 'Goa 2023', added: 2, created: true }]);
  assert.equal(dry.deleted, 1);
  assert.equal(dry.skippedFiles, 1);
  assert.equal(lib.choice(id('2023/IMG_0001.HEIC')).fav, false, 'a dry run changes nothing');

  const r = await applyICloudCsv(lib, root.id, csv);
  assert.equal(r.changed, 2 + 1 + 3 + 2);
  assert.equal(lib.choice(id('2023/IMG_0001.HEIC')).fav, true);
  assert.equal(lib.choice(id('other/IMG, odd.JPG')).fav, true, 'a quoted name with a comma matches');
  assert.equal(lib.choice(id('2023/IMG_0002.JPG')).hidden, true);
  assert.equal(lib.get(id('2023/IMG_0001.HEIC')).time, W(wallClockToTime(2023, 3, 18, 15, 26, 0)));
  assert.equal(lib.get(id('2023/IMG_0001.HEIC')).timeSource, 'icloud');
  assert.equal(lib.get(id('2023/IMG_0002.JPG')).time, wallClockToTime(2020, 1, 1), 'an EXIF date is kept');
  assert.equal(lib.get(id('2023/IMG_0002.JPG')).timeSource, 'exif');
  const al = [...lib.albums.values()].find(a => a.name === 'Goa 2023');
  assert.deepEqual([...al.items].sort(), [id('2023/IMG_0001.HEIC'), id('2023/IMG_0002.JPG')], 'album by the CSV file name, names matched ignoring case');

  // Applying again changes nothing and reuses the album.
  const again = await applyICloudCsv(lib, root.id, csv);
  assert.equal(again.changed, 0);
  assert.equal(again.undo, null);
  assert.equal([...lib.albums.values()].filter(a => a.name === 'Goa 2023').length, 1);

  // One undo reverses all of it.
  await lib.undo(r.undo);
  assert.equal(lib.choice(id('2023/IMG_0001.HEIC')).fav, false);
  assert.equal(lib.choice(id('2023/IMG_0002.JPG')).hidden, false);
  assert.equal(lib.get(id('2023/IMG_0001.HEIC')).time, 5);
  assert.equal(lib.get(id('2023/IMG_0001.HEIC')).timeSource, 'file');
  assert.equal([...lib.albums.values()].some(a => a.name === 'Goa 2023'), false);

  // An existing album of that name is added to, not duplicated.
  lib.albumCreate('goa 2023', { ids: [id('IMG_0004.JPG')] });
  const r3 = await applyICloudCsv(lib, root.id, [{ name: 'Goa 2023.csv', text: ALBUM }]);
  assert.deepEqual(r3.albums, [{ name: 'Goa 2023', added: 2, created: false }]);
  assert.equal(lib.albums.size, 1);
  await assert.rejects(applyICloudCsv(lib, 'nope', csv), /no root/);
}

// ── a CSV date survives a rebuild with the CSV gone (libfile meta) ─────────────
{
  const { scanRoot } = await import('../src/library/scan.js');
  const { parseLibFile } = await import('../src/library/libfile.js');
  const tree = { 'IMG_0001.HEIC': new File(['x'], 'IMG_0001.HEIC', { lastModified: 1000 }) };
  const dir = {
    kind: 'directory', name: 'iCloud',
    async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, { kind: 'file', name: k, getFile: async () => v }]; },
    async queryPermission() { return 'granted'; },
    async isSameEntry(o) { return o === this; },
  };
  let saved = null;
  const thumbs = { enqueue() {}, async remove() {}, async clear() {}, async url() { return null; } };
  const persist = { async load() { return saved; }, async save(_r, f) { saved = parseLibFile(JSON.stringify(f)).file; }, canWrite: () => true };
  const lib = new Library({ store: memoryStore(), services: { scanRoot, thumbs, persist }, saveDelay: 5 });
  const root = await lib.addRoot({ handle: dir, name: 'iCloud' });
  const id = `${root.id}/IMG_0001.HEIC`;
  assert.equal(lib.get(id).timeSource, 'file');
  const r = await applyICloudCsv(lib, root.id, [{ name: 'Photo Details.csv', text: DETAILS }]);
  await lib.flush();
  assert.deepEqual(saved.items['IMG_0001.HEIC'].meta, { taken: new Date(W(Date.UTC(2023, 2, 18, 15, 26))).toISOString().slice(0, 19), source: 'icloud' });
  await lib.rebuild();
  assert.equal(lib.get(id).time, W(wallClockToTime(2023, 3, 18, 15, 26, 0)), 'the CSV date comes back after a rebuild');
  assert.equal(lib.get(id).timeSource, 'icloud');
  await lib.undo(r.undo);
  assert.equal(lib.meta.has(id), false, 'undo removes the saved date');
  await lib.rebuild();
  assert.equal(lib.get(id).timeSource, 'file');
}

console.log('Slate library iCloud: PASS');
