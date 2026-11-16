// Review findings S5, S9 (Takeout and iCloud), S12 (export part), S17 and S23,
// 17 November 2026. Runs in India time, so a UTC-only conversion shows up.
process.env.TZ = 'Asia/Kolkata';
const assert = (await import('node:assert/strict')).default;
const { importTakeoutZips } = await import('../src/ui/library/import.js');
const { readTakeoutJson, instantToWallClock } = await import('../src/library/takeout.js');
const { parseICloudCsv, applyICloudCsv } = await import('../src/library/icloud.js');
const { exportFiles, exportZip, zipEntries } = await import('../src/library/export.js');
const { Library } = await import('../src/library/library.js');
const { memoryStore } = await import('../src/library/store.js');
const { newRecord, wallClockToTime, splitId } = await import('../src/library/schema.js');

assert.equal(new Date(0).getTimezoneOffset(), -330, 'this test runs at UTC+05:30');

// ── a fake folder (case-sensitive or case-insensitive) ─────────────────────
const err = (name) => Object.assign(new Error(name), { name });
function dirOf(name, ci) {
  const k = (n) => (ci ? n.toLowerCase() : n);
  const m = new Map(); // key -> { name, kind, data | dir }
  const d = {
    kind: 'directory', name, m,
    async getDirectoryHandle(n, { create } = {}) {
      const e = m.get(k(n));
      if (e) return e.dir;
      if (!create) throw err('NotFoundError');
      const sub = dirOf(n, ci); m.set(k(n), { name: n, kind: 'directory', dir: sub }); return sub;
    },
    async getFileHandle(n, { create } = {}) {
      let e = m.get(k(n));
      if (!e && !create) throw err('NotFoundError');
      if (!e) { e = { name: n, kind: 'file', data: '' }; m.set(k(n), e); }
      return {
        kind: 'file', name: e.name,
        getFile: async () => new File([e.data], e.name),
        createWritable: async () => { const parts = []; return { async write(b) { parts.push(typeof b === "string" ? b : await b.text()); }, async close() { e.data = parts.join(''); }, async abort() {} }; },
      };
    },
    async *entries() { for (const e of m.values()) yield [e.name, e.dir ?? e]; },
    files() { return Object.fromEntries([...m.values()].filter(e => e.kind === 'file').map(e => [e.name, e.data])); },
    sub(n) { return m.get(k(n))?.dir; },
    put(n, data) { m.set(k(n), { name: n, kind: 'file', data }); },
  };
  return d;
}
const fakeZip = {
  BlobReader: class { constructor(z) { this.z = z; } },
  ZipReader: class {
    constructor(r) { this.z = r.z; }
    async getEntries() {
      return this.z.map(([filename, data]) => ({ filename, directory: false, uncompressedSize: data.length, async getData(w) { await w.write(data); } }));
    }
    async close() {}
  },
};

// S5: a different file of another size at the path is kept; the entry goes to "name (2)".
for (const ci of [false, true]) {
  const dest = dirOf('Dest', ci);
  const trip = await dest.getDirectoryHandle('Trip', { create: true });
  trip.put('IMG_1.jpg', 'E'.repeat(38));
  const res = await importTakeoutZips({ zips: [[['Takeout/Google Photos/Trip/IMG_1.jpg', 'zipdata']]], dest, zipLib: fakeZip });
  assert.equal(res.conflicts, 1, `one conflict (ci ${ci})`);
  assert.equal(res.written, 1);
  assert.deepEqual(trip.files(), { 'IMG_1.jpg': 'E'.repeat(38), 'IMG_1 (2).jpg': 'zipdata' }, 'the edited photo is kept');
  const again = await importTakeoutZips({ zips: [[['Takeout/Google Photos/Trip/IMG_1.jpg', 'zipdata']]], dest, zipLib: fakeZip });
  assert.deepEqual([again.written, again.skipped, again.conflicts], [0, 1, 0], 'a second run finds the (2) copy and skips it');
}

// S5: two entries that differ only by case, or that map to one safe name, both survive.
for (const ci of [false, true]) {
  const dest = dirOf('Dest', ci);
  const zip = [['Takeout/Google Photos/T/IMG_9.JPG', 'upper'], ['Takeout/Google Photos/T/img_9.jpg', 'lower!'],
    ['Takeout/Google Photos/T/a?.jpg', 'question'], ['Takeout/Google Photos/T/a_.jpg', 'underscore']];
  const res = await importTakeoutZips({ zips: [zip], dest, zipLib: fakeZip });
  assert.deepEqual([res.written, res.conflicts], [4, 2], `four files written, two renamed (ci ${ci})`);
  const got = Object.values(dest.sub('T').files()).sort();
  assert.deepEqual(got, ['lower!', 'question', 'underscore', 'upper'], `no entry lost (ci ${ci})`);
}

// S9 and S23: Takeout times are instants, stored as the local wall clock.
{
  const at = Date.UTC(2024, 0, 2, 3, 30, 0) / 1000; // 09:00 on 2 January in India
  const t = readTakeoutJson(JSON.stringify({ photoTakenTime: { timestamp: String(at) } }));
  assert.equal(t.time, wallClockToTime(2024, 1, 2, 9, 0, 0), '09:00 IST shows as 09:00');
  const old = Date.UTC(1960, 5, 1, 6, 30, 0) / 1000; // negative: before 1970
  const t2 = readTakeoutJson(JSON.stringify({ photoTakenTime: { timestamp: String(old) }, creationTime: { timestamp: '1600000000' } }));
  assert.equal(t2.time, wallClockToTime(1960, 6, 1, 12, 0, 0), 'a 1960 photo keeps its own date');
  assert.equal(readTakeoutJson('{"photoTakenTime":{"timestamp":"0"},"creationTime":{"timestamp":"1600000000"}}').time, instantToWallClock(1600000000000), '0 still means no time');
}

// S9: iCloud CSV dates are GMT instants, stored as the local wall clock.
{
  const csv = 'imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate\nIMG_1.HEIC,x,no,no,no,"Saturday March 18,2023 3:30 AM GMT"\n';
  assert.equal(parseICloudCsv('Photo Details.csv', csv).rows[0].time, wallClockToTime(2023, 3, 18, 9, 0, 0), '03:30 GMT shows as 09:00 IST');
}

// S17: a CSV name that matches two photos is skipped and listed, never applied to both.
{
  const store = memoryStore();
  const recs = ['2019/IMG_0001.PNG', '2023/IMG_0001.PNG', '2023/IMG_0002.PNG'];
  const lib = new Library({ store, services: {
    scanRoot: async (l, root) => l.applyScan(root.id, { upserts: recs.map(p => ({ ...newRecord(root.id, p, { size: 1, lastModified: 1 }), timeSource: 'file', time: 5 })) }),
  } });
  await lib.load();
  const root = await lib.addRoot({ name: 'iCloud', files: [] });
  const id = (p) => `${root.id}/${p}`;
  const csv = [{ name: 'Photo Details.csv', text: 'imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate\n'
    + 'IMG_0001.PNG,abc,yes,no,no,"Saturday March 18,2023 3:26 PM GMT"\nIMG_0002.PNG,def,yes,no,no,\n' }];
  const dry = await applyICloudCsv(lib, root.id, csv, { dryRun: true });
  assert.equal(dry.ambiguous, 1);
  assert.deepEqual(dry.ambiguousNames, ['IMG_0001.PNG']);
  assert.equal(dry.matched, 1);
  await applyICloudCsv(lib, root.id, csv);
  assert.equal(lib.choice(id('2019/IMG_0001.PNG')).fav, false, 'neither same-named photo becomes a favourite');
  assert.equal(lib.choice(id('2023/IMG_0001.PNG')).fav, false);
  assert.equal(lib.get(id('2019/IMG_0001.PNG')).time, 5, 'neither gets the CSV date');
  assert.equal(lib.choice(id('2023/IMG_0002.PNG')).fav, true, 'a unique name still applies');
}

// S12: export copies a Live Photo's MOV with its still, named after the still's export name.
{
  const lib = new Library({ store: memoryStore(), saveDelay: 10_000 });
  lib.roots.set('r1', { id: 'r1', name: 'r1', handle: null, mode: 'files', added: 0, lastScan: 0, files: [] });
  const data = { 'a/IMG_1.HEIC': 'STILL', 'a/IMG_1.MOV': 'MOVIE', 'b/IMG_1.HEIC': 'OTHER' };
  const live = newRecord('r1', 'a/IMG_1.HEIC', { size: 5, lastModified: 1 }); live.liveVideo = 'a/IMG_1.MOV';
  const plain = newRecord('r1', 'b/IMG_1.HEIC', { size: 5, lastModified: 1 });
  lib.records.set(plain.id, plain); lib.records.set(live.id, live);
  lib.getFile = async (fid) => { const p = splitId(fid).path; const d = data[p]; return { name: p.split('/').pop(), size: d.length, lastModified: 1, async text() { return d; } }; };
  assert.deepEqual(zipEntries(lib, [plain.id, live.id]).map(e => e.name), ['IMG_1.HEIC', 'IMG_1 (2).HEIC', 'IMG_1 (2).MOV'], 'the MOV follows its still in the zip');

  const dest = dirOf('Out', false);
  const r = await exportFiles(lib, [plain.id, live.id], dest);
  assert.deepEqual(r, { copied: 3, failed: 0, total: 3 });
  assert.deepEqual(dest.files(), { 'IMG_1.HEIC': 'OTHER', 'IMG_1 (2).HEIC': 'STILL', 'IMG_1 (2).MOV': 'MOVIE' });

  const adds = [];
  const zipLib = { ZipWriter: class { async add(name, reader) { adds.push(name); } async close() { return 'ZIP'; } }, BlobReader: class {} };
  lib.getFile = async (fid) => ({ name: 'x', size: 1, lastModified: 1, stream() { return {}; }, fid });
  const z = await exportZip(lib, [live.id], { zipLib, writer: {} });
  assert.deepEqual([z.copied, z.total, adds], [2, 2, ['IMG_1.HEIC', 'IMG_1.MOV']]);
}

console.log('test-review-b-import: PASS');
