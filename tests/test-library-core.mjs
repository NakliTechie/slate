// Spine tests: schema, library file, query, job queue, Library writes and undo, command table.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Library } from '../src/library/library.js';
import { memoryStore } from '../src/library/store.js';
import { newRecord, makeId, splitId, dayKey, wallClockToTime } from '../src/library/schema.js';
import { parseLibFile, serialiseLibFile, rematchMoved } from '../src/library/libfile.js';
import { groupBy } from '../src/library/query.js';
import { JobQueue } from '../src/library/jobs.js';
import { COMMANDS, manifest, runCommand, MAX_WRITE_IDS } from '../src/library/commands.js';

const NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/;

function fakePersist() {
  const files = new Map();
  return { files, async load(root) { return files.has(root.id) ? parseLibFile(files.get(root.id)).file : null; }, async save(root, f) { files.set(root.id, serialiseLibFile(f)); }, canWrite: () => true };
}
function fakeTrash() {
  const moved = new Set();
  return { moved, async move(root, p) { moved.add(p); }, async restore(root, p) { moved.delete(p); }, async purge(root, p) { moved.delete(p); } };
}
// A fake scanner: the root carries `fake` = [{ path, size, mtime, time }].
async function fakeScan(lib, root) {
  const upserts = [], seen = new Set();
  for (const f of root.fake ?? root.files ?? []) {
    const rec = newRecord(root.id, f.path, { size: f.size, lastModified: f.mtime });
    if (f.time) { rec.time = f.time; rec.timeSource = 'exif'; }
    seen.add(rec.id);
    const old = lib.get(rec.id);
    if (!old || old.size !== rec.size || old.mtime !== rec.mtime) upserts.push(rec);
  }
  await lib.applyScan(root.id, { upserts, seen });
}

async function makeLib(fake) {
  const persist = fakePersist(), trash = fakeTrash();
  const lib = new Library({ store: memoryStore(), services: { scanRoot: fakeScan, persist, trash }, saveDelay: 5 });
  await lib.load();
  const root = await lib.addRoot({ handle: null, name: 'Photos', files: fake });
  return { lib, root, persist, trash };
}

const T = (d, h = 12) => wallClockToTime(2024, 3, d, h);
const fake = [
  { path: '2024/goa/IMG_1.jpg', size: 100, mtime: 1, time: T(1) },
  { path: '2024/goa/IMG_2.jpg', size: 200, mtime: 1, time: T(1, 15) },
  { path: '2024/home/IMG_3.heic', size: 300, mtime: 1, time: T(5) },
  { path: 'clip.mp4', size: 400, mtime: 1, time: T(9) },
];

// schema
assert.deepEqual(splitId(makeId('r1', '/a//b.jpg')), { rootId: 'r1', path: 'a/b.jpg' });
assert.equal(dayKey(T(1, 23)), '2024-03-01', 'capture time groups by its own wall-clock day');

// load, search, group
{
  const { lib, root } = await makeLib(fake);
  assert.equal(lib.records.size, 4);
  assert.equal(lib.search().map(r => r.name)[0], 'clip.mp4', 'newest first');
  assert.equal(lib.search({ kind: 'video' }).length, 1);
  assert.equal(lib.search({ folder: '2024/goa' }).length, 2);
  assert.equal(lib.search({ q: 'goa march 2024' }).length, 2, 'words AND together; month and year match capture date');
  assert.deepEqual(groupBy(lib.search({ sort: 'time-asc' })).map(g => [g.key, g.count]), [['2024-03-01', 2], ['2024-03-05', 1], ['2024-03-09', 1]]);

  // writes, undo, persistence
  const ids = lib.search({ folder: '2024/goa' }).map(r => r.id);
  const dry = lib.setFavourite(ids, true, { dryRun: true });
  assert.deepEqual(dry, { changed: 2, dryRun: true });
  assert.equal(lib.search({ fav: true }).length, 0, 'dry run changes nothing');
  const res = lib.setFavourite(ids, true);
  assert.equal(res.changed, 2);
  assert.equal(lib.search({ fav: true }).length, 2);
  lib.setRating([ids[0]], 4); lib.setFlag([ids[0]], 'pick'); lib.tag([ids[0]], { add: ['Trips/Goa', 'beach'] });
  assert.equal(lib.search({ tag: 'trips' }).length, 1, 'parent tag matches child');
  assert.equal(lib.search({ minRating: 4 }).length, 1);
  assert.equal(lib.search({ flag: 'pick' }).length, 1);
  await lib.undo(res.undo);
  assert.equal(lib.search({ fav: true }).length, 0, 'undo restores');
  lib.setHidden([ids[1]], true);
  assert.equal(lib.search().length, 3, 'hidden left out by default');
  assert.equal(lib.search({ hidden: 'only' }).length, 1);

  const al = lib.albumCreate('Goa', { ids });
  assert.equal(lib.search({ album: al.albumId, hidden: 'include' }).length, 2);
  assert.equal(lib.search({ q: 'goa' }).length >= 1, true);
  await lib.flush();
}

// library file round trip, then rebuild from disk: choices come back unchanged
{
  const { lib, root, persist } = await makeLib(fake);
  const id = lib.search({ q: 'IMG_3' })[0].id;
  lib.setFavourite([id], true); lib.setRating([id], 5);
  const al = lib.albumCreate('Home', { ids: [id] });
  await lib.flush();
  const text = persist.files.get(root.id);
  const parsed = parseLibFile(text);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.file.items['2024/home/IMG_3.heic'], { size: 300, fav: true, rating: 5, flag: null, hidden: false, tags: [], trashed: null });
  assert.equal(parsed.file.albums[0].name, 'Home');
  const before = JSON.stringify([...lib.choices]);
  await lib.rebuild();
  assert.equal(lib.records.size, 4);
  assert.equal(JSON.stringify([...lib.choices]), before, 'rebuild keeps choices');
  assert.equal(lib.albums.get(al.albumId).items.size, 1);
}

// import meta: older files without it still parse; a meta-only item round-trips; bad meta is dropped
{
  const old = parseLibFile(JSON.stringify({ format: 'slate-library', version: 1, items: { 'a.jpg': { size: 1, fav: true } }, albums: [] }));
  assert.ok(old.ok);
  assert.equal(old.file.items['a.jpg'].meta, undefined, 'a file without meta parses');
  const m = parseLibFile(JSON.stringify({ format: 'slate-library', version: 1, items: {
    'b.jpg': { size: 2, meta: { taken: '2019-07-03T15:26:30', lat: 15.5, lon: 73.8, caption: 'Sunset', source: 'takeout', junk: 1 } },
    'c.jpg': { size: 3, meta: { taken: 'not a date', lat: 'x', source: 'other' } },
  } }));
  assert.deepEqual(m.file.items['b.jpg'].meta, { taken: '2019-07-03T15:26:30', lat: 15.5, lon: 73.8, caption: 'Sunset', source: 'takeout' });
  assert.equal(m.file.items['c.jpg'].meta, undefined, 'meta with nothing usable is dropped');
  const lib = new Library({ store: memoryStore() });
  lib.roots.set('r1', { id: 'r1', name: 'R' });
  lib.applyLibFile('r1', m.file);
  assert.equal(lib.meta.get('r1/b.jpg').caption, 'Sunset');
  assert.equal(lib.choices.get('r1/b.jpg').meta, undefined, 'meta is kept apart from choices');
  const back = lib.libFileFor('r1');
  assert.deepEqual(back.items['b.jpg'], { size: 2, meta: m.file.items['b.jpg'].meta }, 'a meta-only item is written back');
  assert.equal(back.items['c.jpg'], undefined);
}

// a moved file keeps its choices (same name and size)
{
  const { lib, root } = await makeLib(fake);
  const id = lib.search({ q: 'IMG_1' })[0].id;
  lib.setFavourite([id], true);
  root.fake = fake.map(f => f.path === '2024/goa/IMG_1.jpg' ? { ...f, path: '2024/moved/IMG_1.jpg' } : f);
  await lib.rescan(root.id);
  const moved = lib.search({ fav: true });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].path, '2024/moved/IMG_1.jpg');
  assert.deepEqual(rematchMoved({ 'a/x.jpg': { size: 5 } }, ['b/x.jpg', 'c/y.jpg'], () => 5), new Map([['a/x.jpg', 'b/x.jpg']]));
}

// trash, restore, empty
{
  const { lib, trash } = await makeLib(fake);
  const id = lib.search({ q: 'clip' })[0].id;
  const t = await lib.trash([id]);
  assert.equal(t.changed, 1);
  assert.ok(trash.moved.has('clip.mp4'));
  assert.equal(lib.search().length, 3);
  assert.equal(lib.search({ trashed: 'only' }).length, 1);
  await lib.restore([id]);
  assert.equal(lib.search().length, 4);
  await lib.trash([id]);
  assert.deepEqual(await lib.emptyTrash({ dryRun: true }), { changed: 1, dryRun: true });
  await lib.emptyTrash();
  assert.equal(lib.records.size, 3);
}

// job queue: pause, resume, failures counted, idle
{
  const q = new JobQueue({ concurrency: 2 });
  const ran = [];
  q.pause();
  q.add('t', [1, 2, 3, 4], async (n) => { ran.push(n); if (n === 3) throw new Error('bad'); });
  assert.equal(ran.length, 0, 'paused queue starts nothing');
  q.resume();
  await q.idle();
  assert.deepEqual(q.status().kinds.t, { done: 3, failed: 1, total: 4 });
}

// commands: names, scopes, manifest file, behaviour
{
  assert.ok(COMMANDS.length <= 64, 'at most 64 tools reach chat');
  for (const c of COMMANDS) {
    assert.match(c.name, NAME, `${c.name} is a valid rail name`);
    assert.ok(['read', 'write', 'destructive'].includes(c.scope), `${c.name} scope`);
    assert.equal(c.input.type, 'object');
    for (const k of c.input.required ?? []) assert.ok(k in c.input.properties, `${c.name} requires a declared property ${k}`);
    if (c.scope === 'write' && c.input.properties.ids) assert.equal(c.input.properties.ids.maxItems, MAX_WRITE_IDS, `${c.name} caps ids`);
  }
  assert.equal(readFileSync(new URL('../commands.json', import.meta.url), 'utf8'), JSON.stringify(manifest(), null, 2) + '\n', 'commands.json matches manifest(); run node scripts/gen-commands.mjs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const c of COMMANDS) assert.ok(html.includes(`'${c.name}'`), `${c.name} appears literally in the built index.html`);

  const { lib } = await makeLib(fake);
  const s = await runCommand(lib, 'library.search', { q: 'goa', limit: 1 });
  assert.equal(s.total, 2); assert.equal(s.items.length, 1); assert.equal(s.cursor, '1');
  const s2 = await runCommand(lib, 'library.search', { q: 'goa', limit: 1, cursor: s.cursor });
  assert.equal(s2.items.length, 1); assert.equal(s2.cursor, undefined);
  const many = Array.from({ length: 201 }, () => s.items[0].id);
  await assert.rejects(runCommand(lib, 'photo.favourite', { ids: many }), /photo\.bulk/);
  const r = await runCommand(lib, 'photo.rate', { ids: [s.items[0].id], rating: 3 });
  assert.ok(r.undo);
  await runCommand(lib, 'library.undo', { token: r.undo });
  assert.equal(lib.rating(s.items[0].id), 0);
  await assert.rejects(runCommand(lib, 'photo.get', {}), /id is required/);
}

// two overlapping rescans of one root scan it once
{
  let calls = 0;
  const slowScan = async (lib, root) => { calls++; await new Promise(r => setTimeout(r, 30)); await lib.applyScan(root.id, { upserts: [], seen: new Set() }); };
  const lib = new Library({ store: memoryStore(), services: { scanRoot: slowScan, persist: fakePersist(), trash: fakeTrash() }, saveDelay: 5 });
  await lib.load();
  const root = await lib.addRoot({ handle: null, name: 'P', files: [] });
  calls = 0;
  await Promise.all([lib.rescan(root.id), lib.rescan(root.id), lib.rescan()]);
  assert.equal(calls, 1, 'concurrent rescans join the running scan');
  await lib.rescan(root.id);
  assert.equal(calls, 2, 'a later rescan scans again');
}

console.log('Slate library core: PASS');
