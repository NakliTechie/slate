// Places (spec rows P1, P2): nearestCity against a brute-force search over the real built
// gazetteer, placeOf on known positions, grouping by country, and map clustering.
// Needs assets/places/ (node scripts/build-places.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlaces, groupByPlace, clusterPoints, haversineKm } from '../src/library/places.js';

const root = new URL('../', import.meta.url);
const fakeFetch = async (url) => {
  const buf = readFileSync(new URL(url.replace(/^\.\//, ''), root));
  return {
    ok: true, status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
};

let n = 0;
const failed = [];
const check = async (fn, msg) => {
  try { await fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message); }
};

const places = createPlaces({ fetch: fakeFetch });
const t0 = performance.now();
await places.load();
console.log(`loaded and indexed ${places._data().n} places in ${Math.round(performance.now() - t0)} ms`);

await check(async () => {
  assert.equal(places.ready, true);
  assert.ok(places._data().n > 50000, 'gazetteer has over 50,000 places');
  assert.ok(places.outlines().length > 150, 'over 150 country outlines');
  assert.equal(await places.load(), places, 'a second load shares the first');
}, 'assets load and index');

await check(() => {
  const d = places._data();
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worst = 0;
  for (let k = 0; k < 1000; k++) {
    // Uniform on the sphere, plus points near the poles and the 180th meridian.
    let lat = Math.asin(2 * rnd() - 1) * 180 / Math.PI, lon = rnd() * 360 - 180;
    if (k % 10 === 0) lon = 179.9 + rnd() * 0.2;
    if (lon > 180) lon -= 360;
    if (k % 25 === 0) lat = 89 * Math.sign(lat || 1);
    let bi = -1, bd = Infinity;
    for (let i = 0; i < d.n; i++) {
      const dist = haversineKm(lat, lon, d.lat[i] / 1e5, d.lon[i] / 1e5);
      if (dist < bd) { bd = dist; bi = i; }
    }
    const got = places.nearestCity(lat, lon);
    worst = Math.max(worst, Math.abs(got.distanceKm - bd));
    assert.ok(Math.abs(got.distanceKm - bd) < 1e-6, `(${lat}, ${lon}): got ${got.name} at ${got.distanceKm} km, brute force ${d.names[bi]} at ${bd} km`);
  }
  console.log(`  worst distance difference over 1,000 points: ${worst} km`);
}, 'nearestCity matches a brute-force search on 1,000 random points');

await check(() => {
  const cases = [
    { id: 'r/panaji.jpg', lat: 15.4909, lon: 73.8278, city: /Panaji|Panjim/, cc: 'IN' },
    { id: 'r/lisbon.jpg', lat: 38.7223, lon: -9.1393, city: /Lisbon|Lisboa/, cc: 'PT' },
    { id: 'r/sydney.jpg', lat: -33.8688, lon: 151.2093, city: /Sydney/, cc: 'AU' },
  ];
  for (const c of cases) {
    const p = places.placeOf(c);
    assert.ok(p, `${c.id}: no place`);
    assert.match(p.city, c.city, `${c.id}: city ${p.city}`);
    assert.equal(p.country, c.cc);
    assert.ok(p.distanceKm < 10, `${c.id}: ${p.distanceKm} km`);
    console.log(`  ${c.id} -> ${p.city}, ${p.countryName} (${p.distanceKm.toFixed(1)} km)`);
  }
  assert.equal(places.countryName('IN'), 'India');
  assert.equal(places.placeOf({ id: 'r/none.jpg', lat: null, lon: null }), null);
}, 'placeOf on Panaji, Lisbon and Sydney');

await check(() => {
  const a = { id: 'r/a.jpg', lat: 15.4909, lon: 73.8278 };
  const first = places.placeOf(a);
  assert.equal(places.placeOf(a), first, 'cached result reused');
  const moved = places.placeOf({ ...a, lat: 38.7223, lon: -9.1393 });
  assert.equal(moved.country, 'PT', 'a changed position is looked up again');
}, 'placeOf caches per record and notices a changed position');

await check(() => {
  const recs = [
    { id: 'r/1', lat: 15.4909, lon: 73.8278 }, { id: 'r/2', lat: 15.491, lon: 73.828 },
    { id: 'r/3', lat: 19.076, lon: 72.8777 }, { id: 'r/4', lat: 38.7223, lon: -9.1393 },
    { id: 'r/5', lat: null, lon: null },
  ];
  const g = groupByPlace(recs, places);
  assert.deepEqual(g.map(c => [c.cc, c.count]), [['IN', 3], ['PT', 1]]);
  assert.equal(g[0].name, 'India');
  assert.equal(g[0].cities[0].count, 2, 'two photos in Panaji');
  assert.deepEqual(g[0].cities[0].ids, ['r/1', 'r/2']);
  assert.equal(g[0].cities.length, 2);
}, 'groupByPlace counts photos per country and city');

await check(() => {
  const cl = clusterPoints([{ x: 1, y: 1, id: 'a' }, { x: 9, y: 9, id: 'b' }, { x: 30, y: 1, id: 'c' }], 20);
  assert.equal(cl.length, 2);
  const ab = cl.find(c => c.ids.length === 2);
  assert.deepEqual([ab.x, ab.y], [5, 5]);
}, 'clusterPoints groups pins by grid cell');

console.log(`test-library-places: ${n} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
