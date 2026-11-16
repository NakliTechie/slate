// Review 2026-11-17, S6 and S7: the lock on hidden photos (locked.js) hides a hidden photo
// from every named path while it is set, and removing or resetting it never reveals one
// without the passphrase.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryStore } from '../src/library/store.js';
import { Library } from '../src/library/library.js';
import { newRecord } from '../src/library/schema.js';
import { initLocked, SEALED_KEY } from '../src/library/locked.js';
import { runCommand } from '../src/library/commands.js';
import { initFaces, memoryFaceStore } from '../src/library/faces.js';
import { confirmText } from '../src/library/door.js';
import { COMMANDS } from '../src/library/commands.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok -', name); }

async function makeLib() {
  const lib = new Library({ store: memoryStore(), saveDelay: 5, services: { trash: { async move() {}, async restore() {}, async purge() {} } } });
  await lib.load();
  const recs = ['open.jpg', 'secret.jpg', 'gone.jpg'].map((p, i) => ({ ...newRecord('r1', p, { size: 10 + i, lastModified: 1 }), thumb: 'ok', w: 400, h: 300 }));
  await lib.applyScan('r1', { upserts: recs });
  lib.roots.set('r1', { id: 'r1', name: 'Photos', mode: 'fsa' });
  const [open, secret, toTrash] = recs.map(r => r.id);
  await lib.setHidden([secret, toTrash], true);
  await lib.trash([toTrash]);
  // Trash may give the record a new id; find it by its choice.
  const gone = [...lib.records.keys()].find(id => lib.choice(id).trashed);
  assert.ok(gone && lib.choice(gone).hidden, 'a hidden photo in the trash');
  const al = lib.albumCreate('Goa', { ids: [secret] });
  lib.albums.get(al.albumId).cover = secret;
  lib.services.thumbs = { dataUrl: async () => 'data:image/webp;base64,AA==', url: async () => null };
  lib.getFile = async (id) => ({ id });
  const lock = initLocked(lib, { crypto: webcrypto, iterations: 1000 });
  await lock.ready;
  await lock.set('blue heron 7');
  return { lib, lock, open, secret, gone, albumId: al.albumId };
}

await test('S6: a locked hidden photo is unknown to photo.get, photo.thumb, photo.hide and the other id commands', async () => {
  const { lib, secret, open, albumId } = await makeLib();
  assert.equal(lib.visible(secret), false);
  assert.equal(lib.visible(open), true);
  for (const [name, args] of [
    ['photo.get', { id: secret }], ['photo.thumb', { id: secret }], ['photo.open', { id: secret }], ['photo.similar', { id: secret }],
    ['photo.hide', { ids: [secret], value: false }], ['photo.hide', { ids: [secret], value: false, dryRun: true }],
    ['photo.favourite', { ids: [secret] }], ['photo.tag', { ids: [secret], add: ['x'] }], ['photo.trash', { ids: [secret] }],
    ['photo.bulk', { op: 'hide', ids: [secret], value: false }], ['photo.move', { moves: [{ id: secret, toPath: 'x.jpg' }] }],
    ['album.add', { album: albumId, ids: [secret] }], ['album.cover', { album: albumId, id: secret }],
  ]) await assert.rejects(runCommand(lib, name, args), /unknown photo id/, `${name} answers as for an unknown id`);
  assert.equal(lib.choice(secret).hidden, true, 'nothing changed');
  assert.ok((await runCommand(lib, 'photo.get', { id: open })).id, 'a visible photo still answers');
});

await test('S6: album.list, library.stats, library.roots, search and the trash leave the locked photos out', async () => {
  const { lib, secret, gone, open } = await makeLib();
  const albums = (await runCommand(lib, 'album.list', {})).albums;
  assert.equal(albums[0].count, 0, 'the album count leaves out the locked photo');
  assert.equal(albums[0].cover, null, 'no hidden cover');
  const stats = await runCommand(lib, 'library.stats', {});
  assert.equal(stats.hidden, 0, 'the hidden count leaves out locked photos');
  assert.equal(stats.hiddenLocked, true);
  assert.equal((await runCommand(lib, 'library.roots', {})).roots[0].photos, 1);
  const all = await runCommand(lib, 'library.search', { hidden: 'include', trashed: 'include' });
  assert.deepEqual(all.items.map(x => x.id), [open]);
  // Empty trash with no ids leaves the locked trashed photo alone.
  const dry = await runCommand(lib, 'trash.empty', { dryRun: true });
  assert.equal(dry.changed, 0);
  await runCommand(lib, 'trash.empty', {});
  assert.ok(lib.get(gone), 'the locked trashed photo is not deleted');
  // The WebMCP question names visible photos only.
  const c = COMMANDS.find(x => x.name === 'photo.trash');
  assert.doesNotMatch(confirmText(lib, c, { ids: [secret] }), /secret/);
});

await test('S6: People and the face job skip a locked hidden photo; unlocking brings it back', async () => {
  const { lib, lock, secret, open } = await makeLib();
  const seen = [];
  const vec = Float32Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
  const detector = { async detect(file) { seen.push(file.id); return { faces: [{ box: [0.1, 0.1, 0.2, 0.2], landmarks: new Array(10).fill(0.3), score: 0.9, vector: vec }], w: 400, h: 300 }; }, stop() {} };
  const faces = initFaces(lib, { faceStore: memoryFaceStore(), detector, readSidecar: async () => null });
  await faces.ready;
  await faces.setEnabled(true);
  await lib.jobs.idle();
  assert.deepEqual(seen, [open], 'the locked photo is not scanned');
  assert.deepEqual(faces.facesIn(secret), []);
  assert.equal(await lock.unlock('blue heron 7'), true);
  await lib.jobs.idle();
  assert.ok(seen.includes(secret), 'unlocked: the face job picks it up');
  assert.equal(faces.facesIn(secret).length, 1);
  lock.lock();
  assert.deepEqual(faces.facesIn(secret), [], 'locked again: its faces leave People');
  faces._recluster();
  for (const p of faces.people({ hidden: true })) assert.ok(!faces.photosOf(p.id).includes(secret));
});

await test('S7: removing the lock needs the passphrase', async () => {
  const { lib, lock, secret } = await makeLib();
  assert.equal(await lock.remove('guess'), false);
  assert.equal(lock.isSet(), true);
  assert.equal(lib.visible(secret), false);
  assert.equal(await lock.remove('blue heron 7'), true);
  assert.equal(lib.visible(secret), true);
});

await test('S7: "Forgot the passphrase" reveals nothing, even after unlocking with the new one', async () => {
  const { lib, lock, secret, open } = await makeLib();
  await lock.forgotPassphrase('new pass 1');
  assert.equal(lock.isSet(), true);
  assert.equal(lock.sealedCount(), 2, 'the two hidden photos are sealed under the old passphrase');
  assert.equal(await lock.unlock('new pass 1'), true);
  assert.equal(lib.visible(secret), false, 'the new passphrase does not show the photos hidden before');
  await assert.rejects(runCommand(lib, 'photo.get', { id: secret }), /unknown photo id/);
  assert.deepEqual((await runCommand(lib, 'library.search', { hidden: 'include' })).items.map(x => x.id), [open]);
  // A photo hidden after the reset is under the new passphrase.
  await lib.setHidden([open], true);
  assert.equal(lib.visible(open), true, 'unlocked with the new passphrase');
  lock.lock();
  assert.equal(lib.visible(open), false);
  // The seal survives a new session, and the old passphrase opens it.
  assert.ok((await lib.store.getKv(SEALED_KEY))?.length === 1);
  assert.equal(await lock.unlock('new pass 1'), true);
  assert.equal(await lock.unlock('blue heron 7'), true);
  assert.equal(lib.visible(secret), true, 'the old passphrase opens the sealed photos');
  assert.ok(!JSON.stringify(await lib.store.getKv(SEALED_KEY)).includes('heron'), 'no passphrase is stored');
});

console.log(`test-review-c-lock: ${passed} passed`);
