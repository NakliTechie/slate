// Review S11: a sidecar Slate cannot parse is never replaced; the file is reported once.
import assert from 'node:assert/strict';
import { buildXmp, canEditXmp } from '../src/library/xmp.js';
import { initXmpWrite } from '../src/library/xmpwrite.js';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord } from '../src/library/schema.js';

const GOOD = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:crs="c" crs:Exposure2012="+0.50"/></rdf:RDF></x:xmpmeta>';
const UPPER = GOOD.replace(/rdf:/g, 'RDF:');
// A UTF-16LE file with a BOM, as File.text() (UTF-8) hands it over.
const UTF16 = new TextDecoder('utf-8').decode(new Uint8Array([0xff, 0xfe, ...Buffer.from(GOOD, 'utf16le')]));

// buildXmp and canEditXmp
{
  assert.equal(canEditXmp(null), true);
  assert.equal(canEditXmp('  \n'), true, 'an empty sidecar may be written');
  assert.equal(canEditXmp(GOOD), true);
  assert.equal(canEditXmp(UPPER), false, 'RDF: prefix');
  assert.equal(canEditXmp(UTF16), false, 'UTF-16 with a BOM');
  assert.equal(canEditXmp('<x:xmpmeta>garbage</x:xmpmeta>'), false, 'no rdf:Description');
  assert.equal(buildXmp({ rating: 3, existing: UPPER }), null);
  assert.equal(buildXmp({ rating: 3, existing: UTF16 }), null);
  assert.match(buildXmp({ rating: 3, existing: GOOD }), /crs:Exposure2012="\+0.50"/, 'a parseable sidecar is still merged');
  assert.match(buildXmp({ rating: 3, existing: '' }), /<xmp:Rating>3<\/xmp:Rating>/, 'an empty sidecar gets a new packet');
}

// The write path leaves both files alone and reports each once.
{
  const err = (name) => Object.assign(new Error(name), { name });
  const files = new Map([['a.jpg', 'A'], ['a.jpg.xmp', UTF16], ['b.jpg', 'B'], ['b.xmp', UPPER], ['c.jpg', 'C']]);
  const writes = [];
  const dir = {
    kind: 'directory', name: 'p',
    async queryPermission() { return 'granted'; },
    async getFileHandle(n, { create = false } = {}) {
      if (!files.has(n)) { if (!create) throw err('NotFoundError'); files.set(n, ''); }
      return {
        async getFile() { const d = files.get(n); return { name: n, size: d.length, async text() { return d; } }; },
        async createWritable() { let buf = ''; return { write: async (x) => { buf += x; }, close: async () => { files.set(n, buf); writes.push(n); } }; },
      };
    },
  };
  const lib = new Library({ store: memoryStore(), saveDelay: 10_000 });
  lib.roots.set('r', { id: 'r', name: 'r', handle: dir, mode: 'fsa', added: 0, lastScan: 0 });
  lib.getHandle = async () => dir;
  const ids = ['a.jpg', 'b.jpg', 'c.jpg'].map(p => { const r = newRecord('r', p, { size: 1, lastModified: 1 }); lib.records.set(r.id, r); return r.id; });
  const errors = [];
  lib.on('error', (e) => errors.push(e.message));
  const w = initXmpWrite(lib, { delay: 10_000 });
  await w.ready;
  await w.setEnabled(true);

  lib.setRating(ids, 4);
  assert.equal(await w.flush(), 1, 'only the photo with no sidecar is written');
  assert.deepEqual(writes, ['c.jpg.xmp']);
  assert.equal(files.get('a.jpg.xmp'), UTF16, 'the UTF-16 sidecar is unchanged');
  assert.equal(files.get('b.xmp'), UPPER, 'the RDF: sidecar is unchanged');
  assert.ok(!files.has('b.jpg.xmp'), 'no full-name sidecar made from an unreadable stem');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /a\.jpg\.xmp/);
  assert.match(errors[1], /b\.xmp/);

  lib.setRating(ids, 5);
  await w.flush();
  assert.equal(errors.length, 2, 'each file is reported once');
  assert.equal(files.get('a.jpg.xmp'), UTF16);
}

console.log('review d2 xmp (S11): PASS');
