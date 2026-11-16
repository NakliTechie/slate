// Locked hidden photos (row O9, src/library/locked.js) with Node's webcrypto:
// set a passphrase, verify it, refuse a wrong one, remove it with the passphrase; and the query gate.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryStore } from '../src/library/store.js';
import { Library } from '../src/library/library.js';
import { newRecord } from '../src/library/schema.js';
import { query } from '../src/library/query.js';
import { createLock, initLocked, LOCK_KEY, LOCK_ITERATIONS } from '../src/library/locked.js';

const store = memoryStore();
const lock = createLock(store, { crypto: webcrypto });
await lock.ready;
assert.equal(lock.isSet(), false);
assert.equal(lock.isLocked(), false);
assert.equal(await lock.unlock('anything'), true, 'no lock: nothing to unlock');
await assert.rejects(lock.set('abc'), /at least 4/);

// Set: the verifier is a salt and a PBKDF2-SHA-256 hash at 600,000 iterations, never the passphrase.
await lock.set('blue heron 7');
const v = await store.getKv(LOCK_KEY);
assert.equal(v.iterations, LOCK_ITERATIONS);
assert.equal(LOCK_ITERATIONS, 600000);
assert.equal(v.kdf, 'PBKDF2-SHA-256');
assert.equal(Buffer.from(v.salt, 'base64').length, 16);
assert.equal(Buffer.from(v.hash, 'base64').length, 32);
assert.ok(!JSON.stringify(v).includes('heron'), 'the passphrase is not stored');
assert.equal(lock.isSet(), true);
assert.equal(lock.isLocked(), true, 'locked as soon as it is set');
await assert.rejects(lock.set('other'), /already set/);

// A second lock on the same store (a new session) starts locked; wrong then right passphrase.
const s2 = createLock(store, { crypto: webcrypto });
assert.equal(s2.isLocked(), true, 'locked while the verifier loads');
await s2.ready;
assert.equal(s2.isLocked(), true);
assert.equal(await s2.unlock('blue heron 8'), false);
assert.equal(s2.isLocked(), true);
assert.equal(await s2.unlock('blue heron 7'), true);
assert.equal(s2.isLocked(), false);
s2.lock();
assert.equal(s2.isLocked(), true);

// Two salts differ for the same passphrase.
const other = memoryStore();
const l3 = createLock(other, { crypto: webcrypto, iterations: 1000 });
await l3.set('blue heron 7');
assert.notEqual((await other.getKv(LOCK_KEY)).salt, v.salt);

// Removing the lock needs the current passphrase; then it removes the lock and nothing else.
assert.equal(await s2.remove('wrong one'), false, 'a wrong passphrase removes nothing');
assert.ok((await store.getKv(LOCK_KEY))?.hash);
assert.equal(await s2.remove('blue heron 7'), true);
assert.equal(await store.getKv(LOCK_KEY), undefined);
assert.equal(s2.isSet(), false);
assert.equal(s2.isLocked(), false);

// The library gate: while locked, no hidden photo matches any query; the hidden choice is untouched.
{
  const lib = new Library({ store: memoryStore(), saveDelay: 5 });
  await lib.load();
  const recs = ['a.jpg', 'b.jpg'].map(p => newRecord('r1', p, { size: 1, lastModified: 1 }));
  await lib.applyScan('r1', { upserts: recs });
  lib.setHidden([recs[1].id], true);
  const lk = initLocked(lib, { crypto: webcrypto, iterations: 1000 });
  let events = 0;
  lib.on('choices', (e) => { if (e.reason === 'lock') events++; });
  await lk.ready;
  const names = (opts) => query(lib.records.values(), lib.choices, lib.albums, { ...opts, lockHidden: lib.hiddenLocked() }).map(r => r.name);
  assert.deepEqual(names({ hidden: 'only' }), ['b.jpg'], 'no lock: the Hidden view shows its photos');
  await lk.set('passphrase');
  assert.ok(events >= 1, 'the view is told to query again');
  assert.deepEqual(names({ hidden: 'only' }), [], 'locked: the Hidden view is empty');
  assert.deepEqual(names({ hidden: 'include' }), ['a.jpg']);
  assert.deepEqual(names({ hidden: 'include', trashed: 'include' }), ['a.jpg']);
  assert.equal(lib.choice(recs[1].id).hidden, true, 'the photo stays hidden in the library file');
  assert.equal(await lk.unlock('passphrase'), true);
  assert.deepEqual(names({ hidden: 'only' }), ['b.jpg']);
  // Rebuild clears kv; the lock writes its verifier back.
  await lib.store.clear();
  lib.emit('records', { ids: null, reason: 'rebuild' });
  await new Promise(r => setTimeout(r, 10));
  assert.ok((await lib.store.getKv(LOCK_KEY))?.hash, 'the lock survives Rebuild index');
}

console.log('Slate library locked hidden photos: PASS');
