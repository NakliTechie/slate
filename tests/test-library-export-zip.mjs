// Export as one .zip file (spec row I4): zipLevelFor, the file and entry names, and
// the streaming order of exportZip against a fake zip.js ZipWriter (zip.js itself
// loads from esm.sh in the browser, so it is not available here).
import assert from 'node:assert/strict';
import { exportZip, zipLevelFor, zipFileName, zipEntries } from '../src/library/export.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord } from '../src/library/schema.js';

// ── zipLevelFor ────────────────────────────────────────────────────────────
for (const n of ['a.jpg', 'B.JPEG', 'c.heic', 'd.HEIF', 'e.png', 'f.mp4', 'g.MOV', 'h.webp']) assert.equal(zipLevelFor(n), 0, n);
for (const n of ['a.dng', 'b.CR3', 'c.tif', 'd.xmp', 'README', '.png']) assert.equal(zipLevelFor(n), undefined, n);

// ── zipFileName ────────────────────────────────────────────────────────────
const day = new Date(2026, 10, 7);
assert.equal(zipFileName('Goa trip', day), 'Goa trip 2026-11-07.zip');
assert.equal(zipFileName(undefined, day), 'Slate export 2026-11-07.zip');
assert.equal(zipFileName('a/b: c?', day), 'a b c 2026-11-07.zip');
assert.equal(zipFileName(' / ', day), 'Slate export 2026-11-07.zip');

// ── a library with a fake file source ──────────────────────────────────────
function makeLib(files) {
  const lib = new Library({ store: memoryStore(), saveDelay: 10_000 });
  lib.roots.set('r1', { id: 'r1', name: 'r1', handle: null, mode: 'files', added: 0, lastScan: 0, files: [] });
  const ids = [];
  for (const [path, data] of files) {
    const r = newRecord('r1', path, { size: data?.length ?? 0, lastModified: 1000 });
    lib.records.set(r.id, r); ids.push(r.id);
  }
  lib.getFile = async (id) => {
    const data = files.find(([p]) => lib.get(id).path === p)?.[1];
    if (data == null) throw new Error('missing');
    return { name: lib.get(id).name, size: data.length, lastModified: 5000, stream() { return { data }; } };
  };
  return { lib, ids };
}

// A fake ZipWriter: records each add, lets one add at a time run, and fails on request.
function fakeZip({ failOn } = {}) {
  const log = { adds: [], open: 0, maxOpen: 0, closed: false, options: null };
  class ZipWriter {
    constructor(writer, options) { log.writer = writer; log.options = options; }
    async add(name, reader, opts) {
      log.open++; log.maxOpen = Math.max(log.maxOpen, log.open);
      await new Promise(r => setTimeout(r, 2));
      log.open--;
      if (name === failOn) throw new Error('read error');
      log.adds.push({ name, data: reader.data, opts });
    }
    async close() { log.closed = true; return 'ZIP'; }
  }
  return { zipLib: { ZipWriter, BlobReader: class {} }, log };
}

{
  const { lib, ids } = makeLib([['x/IMG_1.jpg', 'ONE'], ['y/IMG_1.jpg', 'OTHER'], ['y/raw.dng', 'RAW'], ['y/clip.MOV', 'MOVIE'], ['gone.jpg', null]]);
  assert.deepEqual(zipEntries(lib, [...ids, ids[0]]).map(e => e.name), ['IMG_1.jpg', 'IMG_1 (2).jpg', 'raw.dng', 'clip.MOV', 'gone.jpg'], 'names unique, duplicates of an id dropped');

  const { zipLib, log } = fakeZip();
  const seen = [];
  lib.jobs.onProgress(p => { if (p.kind === 'export') seen.push(p.kinds.export); });
  const r = await exportZip(lib, ids, { zipLib, writer: 'STREAM' });
  assert.deepEqual({ ...r }, { copied: 4, failed: 1, total: 5, cancelled: false, result: 'ZIP' });
  assert.equal(log.writer, 'STREAM', 'the save stream goes straight to the ZipWriter');
  assert.equal(log.options.zip64, false);
  assert.equal(log.maxOpen, 1, 'one entry streams at a time');
  assert.deepEqual(log.adds.map(a => a.name), ['IMG_1.jpg', 'IMG_1 (2).jpg', 'raw.dng', 'clip.MOV'], 'entries in order');
  assert.deepEqual(log.adds.map(a => a.data), ['ONE', 'OTHER', 'RAW', 'MOVIE'], 'each original is streamed, not re-encoded');
  assert.deepEqual(log.adds.map(a => a.opts.level), [0, 0, undefined, 0], 'stored for compressed formats, default level otherwise');
  assert.equal(log.adds[0].opts.lastModDate.getTime(), 5000);
  assert.ok(log.closed);
  await lib.jobs.idle();
  assert.ok(seen.length && seen.at(-1).total === 5 && seen.at(-1).failed === 1, 'progress runs on lib.jobs as kind export');
}

{
  // A failure inside an entry stops the export and aborts the stream.
  const { lib, ids } = makeLib([['a.jpg', 'A'], ['b.jpg', 'B'], ['c.jpg', 'C'], ['d.jpg', 'D'], ['e.jpg', 'E'], ['f.jpg', 'F']]);
  const { zipLib, log } = fakeZip({ failOn: 'b.jpg' });
  let aborted = false;
  await assert.rejects(exportZip(lib, ids, { zipLib, writer: { abort: async () => { aborted = true; } } }), /zip export stopped: read error/);
  assert.ok(aborted, 'the save stream is aborted');
  assert.equal(log.closed, false);
  assert.deepEqual(log.adds.map(a => a.name), ['a.jpg'], 'nothing is added after the failure');
  await lib.jobs.idle();
}

{
  // Cancelling keeps what was written and closes the zip.
  const { lib, ids } = makeLib(Array.from({ length: 20 }, (_, i) => [`p${i}.jpg`, `D${i}`]));
  const { zipLib, log } = fakeZip();
  const p = exportZip(lib, ids, { zipLib, writer: 'STREAM' });
  setTimeout(() => lib.jobs.cancel('export'), 7);
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.ok(r.copied > 0 && r.copied < 20, `some entries written before the cancel (${r.copied})`);
  assert.equal(log.adds.length, r.copied);
  assert.ok(log.closed, 'the zip is closed, so it opens with what it holds');
}

{
  const { lib } = makeLib([]);
  const { zipLib, log } = fakeZip();
  assert.deepEqual({ ...(await exportZip(lib, [], { zipLib, writer: 'S' })) }, { copied: 0, failed: 0, total: 0, cancelled: false, result: 'ZIP' });
  assert.ok(log.closed);
}

console.log('Slate library export zip: PASS');
