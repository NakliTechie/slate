// Faces (F1 to F3): the YuNet decode, the five-point alignment, clustering on
// synthetic vectors, the people operations (name, merge, hide, not this person,
// cover, delete all) through initFaces with a fake detector, and MWG face
// regions written and read back through xmp.js.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  decodeYunet, nms, similarityTransform, warpAffine, l2normalise, cosineDistance,
  clusterFaces, emptyState, mergePeople, markNotPerson, initFaces, memoryFaceStore,
  workerSource, TEMPLATE, MODEL_ID, SETTING_KEY, OPT_IN_TEXT,
} from '../src/library/faces.js';
import { buildXmp, parseXmp, parseRegions } from '../src/library/xmp.js';
import { JobQueue } from '../src/library/jobs.js';
import { memoryStore } from '../src/library/store.js';
import { cropStyle } from '../src/ui/library/people.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok -', name); }
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// A seeded random source, so the synthetic clusters are the same every run.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const randVec = (r) => l2normalise(Float32Array.from({ length: 128 }, () => gauss(r)));
const near = (r, c, sd) => l2normalise(Float32Array.from(c, v => v + gauss(r) * sd));

await test('similarity transform from five landmarks recovers scale, rotation and shift', () => {
  const s = 1.7, t = 0.3, tx = 40, ty = -12;
  const src = [];
  for (let i = 0; i < 5; i++) {
    const x = TEMPLATE[2 * i], y = TEMPLATE[2 * i + 1];
    src.push(s * (Math.cos(t) * x - Math.sin(t) * y) + tx, s * (Math.sin(t) * x + Math.cos(t) * y) + ty);
  }
  const m = similarityTransform(src, TEMPLATE);
  close(Math.hypot(m[0], m[3]), 1 / s, 1e-9, 'scale');
  close(Math.atan2(m[3], m[0]), -t, 1e-9, 'rotation');
  for (let i = 0; i < 5; i++) {
    const x = src[2 * i], y = src[2 * i + 1];
    close(m[0] * x + m[1] * y + m[2], TEMPLATE[2 * i], 1e-9, `x of point ${i}`);
    close(m[3] * x + m[4] * y + m[5], TEMPLATE[2 * i + 1], 1e-9, `y of point ${i}`);
  }
  // Noisy landmarks: the fit is least squares, so the mean error stays near the noise.
  const r = rng(7), noisy = src.map(v => v + (r() - 0.5));
  const n = similarityTransform(noisy, TEMPLATE);
  let err = 0;
  for (let i = 0; i < 5; i++) err += Math.hypot(n[0] * noisy[2 * i] + n[1] * noisy[2 * i + 1] + n[2] - TEMPLATE[2 * i], n[3] * noisy[2 * i] + n[4] * noisy[2 * i + 1] + n[5] - TEMPLATE[2 * i + 1]);
  assert.ok(err / 5 < 0.5, 'mean error under half a pixel');
});

await test('warpAffine samples bilinearly through the inverse map', () => {
  // A 4 x 4 image whose red channel is 10 * x + y; the identity map shifted by 0.5 averages neighbours.
  const w = 4, h = 4, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[(y * w + x) * 4] = 10 * x + y;
  const crop = warpAffine(px, w, h, [1, 0, -0.5, 0, 1, 0], 3);
  assert.equal(crop[0], 5, 'x = 0.5 is half of 0 and 10');
  assert.equal(crop[(1 * 3 + 1) * 4], 16, 'x = 1.5, y = 1 gives 16');
  const out = warpAffine(px, w, h, [1, 0, 10, 0, 1, 0], 2);
  assert.equal(out[0], 0, 'outside the image is black');
  assert.equal(out[3], 255, 'alpha is opaque');
});

await test('YuNet decode places a box and landmarks from one strong cell, and NMS keeps the best', () => {
  const S = 64, out = {};
  for (const s of [8, 16, 32]) {
    const cells = (S / s) ** 2;
    out['cls_' + s] = new Float32Array(cells); out['obj_' + s] = new Float32Array(cells);
    out['bbox_' + s] = new Float32Array(cells * 4); out['kps_' + s] = new Float32Array(cells * 10);
  }
  const i = 2 * 8 + 3;                       // stride 8, row 2, column 3
  out.cls_8[i] = 0.9; out.obj_8[i] = 1.0;
  out.bbox_8.set([0.5, 0.5, Math.log(2), Math.log(3)], i * 4);
  out.kps_8.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
  out.cls_16[0] = 0.8; out.obj_16[0] = 0.8; // a weaker overlapping box
  out.bbox_16.set([1.75, 1.25, Math.log(1.2), Math.log(1.6)], 0);
  const faces = decodeYunet(out, S, 0.7);
  assert.equal(faces.length, 2);
  const [best] = nms(faces, 0.3);
  close(best.score, Math.sqrt(0.9), 1e-6, 'score is sqrt(cls * obj)');
  const [x, y, bw, bh] = best.box;
  close(x + bw / 2, (3 + 0.5) * 8, 1e-5, 'centre x'); close(y + bh / 2, (2 + 0.5) * 8, 1e-5, 'centre y');
  close(bw, 16, 1e-4, 'width'); close(bh, 24, 1e-4, 'height');
  assert.deepEqual(best.landmarks.slice(0, 4).map(v => Math.round(v)), [24, 16, 32, 16]);
  assert.equal(nms(faces, 0.3).length, 1, 'the overlapping weaker box is suppressed');
});

await test('clustering finds three people and leaves noise ungrouped, incrementally', () => {
  const r = rng(42);
  const centres = [randVec(r), randVec(r), randVec(r)];
  const faces = [];
  centres.forEach((c, k) => { for (let j = 0; j < 6; j++) faces.push({ id: `c${k}/${j}#0`, vector: near(r, c, 0.04) }); });
  for (let j = 0; j < 5; j++) faces.push({ id: `noise${j}#0`, vector: randVec(r) });
  assert.ok(cosineDistance(faces[0].vector, faces[1].vector) < 0.3, 'members are close');
  const st = emptyState();
  clusterFaces(faces, st);
  assert.equal(Object.keys(st.people).length, 3, 'three people');
  for (let k = 0; k < 3; k++) {
    const pids = new Set(faces.filter(f => f.id.startsWith(`c${k}/`)).map(f => st.assign[f.id]));
    assert.equal(pids.size, 1, `cluster ${k} is one person`);
    assert.ok([...pids][0]);
  }
  assert.ok(faces.filter(f => f.id.startsWith('noise')).every(f => !st.assign[f.id]), 'noise stays ungrouped');
  // New faces join existing people; two lone faces (under the minimum of 3) start nobody.
  faces.push({ id: 'c1/new#0', vector: near(r, centres[1], 0.04) });
  const lone = randVec(r);
  faces.push({ id: 'lone1#0', vector: near(r, lone, 0.02) }, { id: 'lone2#0', vector: near(r, lone, 0.02) });
  clusterFaces(faces, st);
  assert.equal(Object.keys(st.people).length, 3, 'still three people');
  assert.equal(st.assign['c1/new#0'], st.assign['c1/0#0'], 'the new face joins its person');
  assert.ok(!st.assign['lone1#0'] && !st.assign['lone2#0'], 'two similar faces are not enough for a person');
});

await test('merge and not-this-person on the state', () => {
  const st = emptyState();
  st.people = { p1: { id: 'p1', name: '', hidden: false, cover: 'a#0' }, p2: { id: 'p2', name: 'Asha', hidden: false, cover: null } };
  st.assign = { 'a#0': 'p1', 'b#0': 'p1', 'c#0': 'p2' };
  st.notPerson = { 'x#0': ['p2'] };
  assert.equal(mergePeople(st, 'p1', 'p2'), true);
  assert.deepEqual(st.assign, { 'a#0': 'p1', 'b#0': 'p1', 'c#0': 'p1' });
  assert.equal(st.people.p1.name, 'Asha', 'the unnamed target takes the name');
  assert.equal(st.people.p2, undefined);
  assert.deepEqual(st.notPerson['x#0'], ['p1'], 'a not-this-person mark follows the merge');
  assert.equal(mergePeople(st, 'p1', 'p1'), false);
  assert.equal(markNotPerson(st, 'a#0'), 'p1');
  assert.equal(st.assign['a#0'], undefined);
  assert.equal(st.people.p1.cover, null, 'the cover is cleared when its face leaves');
  // Clustering never puts that face back into p1, even when it is close.
  const v = randVec(rng(3));
  const faces = ['a', 'b', 'c'].map(k => ({ id: `${k}#0`, vector: v }));
  clusterFaces(faces, st);
  assert.notEqual(st.assign['a#0'], 'p1');
});

// ── the service with a fake library and detector ──────────────────────────
function fakeLib() {
  const handlers = new Map();
  const records = new Map();
  const choices = new Map();
  const lib = {
    records, roots: new Map(), store: memoryStore(), jobs: new JobQueue({ concurrency: 2 }), services: {},
    get: (id) => records.get(id) ?? null,
    choice: (id) => choices.get(id) ?? {},
    on(t, fn) { (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(fn); },
    emit(t, d) { for (const fn of handlers.get(t) ?? []) fn(d); },
    async getFile(id) { return { id }; },
  };
  return lib;
}

await test('initFaces: opt-in, detect on jobs, group, name, merge, hide, mark wrong, cover, regions, delete all', async () => {
  const lib = fakeLib();
  const r = rng(11);
  const centres = [randVec(r), randVec(r)];
  const plan = new Map();     // photo id -> faces the fake detector returns
  for (let k = 0; k < 2; k++) for (let j = 0; j < 4; j++) {
    const id = `root/p${k}-${j}.jpg`;
    lib.records.set(id, { id, rootId: 'root', name: `p${k}-${j}.jpg`, kind: 'photo', size: 10, mtime: 1, time: j, w: 400, h: 300 });
    plan.set(id, [{ box: [0.1 + 0.4 * k, 0.2, 0.2, 0.3], landmarks: new Array(10).fill(0.3), score: 0.9, vector: near(r, centres[k], 0.03) }]);
  }
  lib.records.set('root/clip.mp4', { id: 'root/clip.mp4', rootId: 'root', name: 'clip.mp4', kind: 'video', size: 5, mtime: 1 });
  const seen = [];
  const detector = { async detect(file) { seen.push(file.id); return { faces: plan.get(file.id) ?? [], w: 400, h: 300 }; }, stop() {} };
  const fstore = memoryFaceStore();
  const sidecars = { 'root/p0-0.jpg': buildXmp({ regions: { w: 400, h: 300, regions: [
    { name: 'Asha', type: 'Face', x: 0.2, y: 0.35, w: 0.2, h: 0.3 },          // over the detected face
    { name: 'Ravi', type: 'Face', x: 0.9, y: 0.1, w: 0.1, h: 0.1 },           // somewhere else
  ] } }) };
  const queued = [];
  lib.services.xmpWrite = { queue: (ids) => queued.push(...ids) };
  const faces = initFaces(lib, { faceStore: fstore, detector, readSidecar: async (id) => sidecars[id] ?? null });
  await faces.ready;

  assert.equal(faces.enabled(), false, 'off by default');
  assert.equal(seen.length, 0, 'nothing runs while off');
  assert.equal(OPT_IN_TEXT.length, 4);
  assert.match(OPT_IN_TEXT.join(' '), /MB/, 'the opt-in text gives sizes');
  assert.equal(faces.regionsFor('root/p0-0.jpg'), undefined);

  await faces.setEnabled(true);
  assert.equal(await lib.store.getKv(SETTING_KEY), true, 'the setting is stored');
  await lib.jobs.idle();
  faces._recluster();
  assert.equal(seen.length, 8, 'every photo once, the video skipped');
  assert.equal(lib.jobs.status().kinds.faces.done, 8, "work ran as jobs of kind 'faces'");
  const stored = await fstore.allPhotos();
  assert.equal(stored.length, 8);
  assert.ok(stored.every(p => p.model === MODEL_ID && p.faces[0].vector.length === 128), 'model id stored with each vector');

  let people = faces.people();
  assert.equal(people.length, 2, 'two people');
  const asha = people.find(p => p.name === 'Asha');
  assert.ok(asha, 'a named XMP region names the person whose face it covers');
  const other = people.find(p => p !== asha);
  assert.equal(other.name, '');
  assert.equal(faces.photosOf(asha.id).length, 4);

  // Regions for XMP: ours plus the sidecar's region that ours does not overlap.
  const reg = faces.regionsFor('root/p0-0.jpg');
  assert.deepEqual(reg.regions.map(x => x.name).sort(), ['Asha', 'Ravi']);
  assert.equal(reg.w, 400);
  assert.equal(faces.regionsFor('root/p1-0.jpg'), undefined, 'no named person: leave the sidecar alone');

  faces.name(other.id, 'Meera');
  assert.ok(queued.includes('root/p1-0.jpg'), 'naming queues XMP writes for that person\'s photos');
  assert.equal(faces.regionsFor('root/p1-0.jpg').regions[0].name, 'Meera');

  // Cover and not-this-person.
  const mf = faces.facesOf(other.id);
  faces.setCover(other.id, mf[2].id);
  assert.equal(faces.coverFace(other.id).id, mf[2].id);
  faces.notThisPerson(mf[2].id);
  assert.equal(faces.facesOf(other.id).length, 3);
  assert.notEqual(faces.coverFace(other.id).id, mf[2].id, 'cover falls back to another face');
  faces._recluster();
  assert.equal(faces.facesOf(other.id).length, 3, 'the marked face does not come back');
  assert.equal(faces.people().length, 2, 'the marked face does not start a person of its own');
  assert.throws(() => faces.setCover(other.id, mf[2].id), /not in this person/);

  // Hide, then merge.
  faces.hide(asha.id, true);
  assert.equal(faces.people().length, 1, 'a hidden person leaves the grid');
  assert.equal(faces.people({ hidden: true }).length, 2);
  assert.equal(faces.regionsFor('root/p0-0.jpg').regions.length, 2, 'hiding does not change what XMP gets');
  faces.hide(asha.id, false);
  faces.merge(asha.id, other.id);
  people = faces.people();
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Asha');
  assert.equal(faces.photosOf(asha.id).length, 7);

  // State survives a reload from the face store.
  const again = initFaces(lib, { faceStore: fstore, detector, readSidecar: async () => null });
  await again.ready;
  assert.equal(again.people()[0].name, 'Asha');
  assert.equal(again.facesOf(asha.id).length, 7);

  // Delete all face data.
  await again.deleteAll();
  assert.equal(again.enabled(), false);
  assert.equal(await lib.store.getKv(SETTING_KEY), false);
  assert.equal((await fstore.allPhotos()).length, 0, 'faces and vectors removed');
  assert.equal(await fstore.getKv('people'), undefined, 'people and names removed');
  assert.equal(again.hasData(), false);
});

await test('pause stops face jobs and resume finishes them', async () => {
  const lib = fakeLib();
  for (let j = 0; j < 6; j++) lib.records.set(`r/${j}.jpg`, { id: `r/${j}.jpg`, rootId: 'r', name: `${j}.jpg`, kind: 'photo', size: 1, mtime: 1 });
  let calls = 0, release;
  const gate = new Promise(res => { release = res; });
  const detector = { async detect() { calls++; await gate; return { faces: [], w: 1, h: 1 }; }, stop() {} };
  const faces = initFaces(lib, { faceStore: memoryFaceStore(), detector, readSidecar: async () => null });
  await faces.ready;
  await faces.setEnabled(true);
  faces.pause();
  release();
  await lib.jobs.idle();
  assert.ok(faces.status().done < 6, 'paused before finishing');
  assert.equal(faces.paused(), true);
  faces.resume();
  await lib.jobs.idle();
  assert.equal(faces.status().done, 6);
  assert.ok(calls >= 6);
});

await test('the worker source is complete script text', () => {
  const src = workerSource();
  new vm.Script(src);               // throws on a syntax error
  for (const name of ['decodeYunet', 'nms', 'similarityTransform', 'warpAffine', 'l2normalise', 'onmessage']) assert.ok(src.includes(name), name);
  assert.match(src, /onnxruntime-web@\d+\.\d+\.\d+/, 'an exact runtime version');
});

await test('face crop CSS stays inside the thumbnail', () => {
  assert.match(cropStyle([0.4, 0.4, 0.2, 0.2]), /background-size:357\.1\d*% 357\.1\d*%/);
  assert.match(cropStyle([0, 0, 1, 1]), /background-position:0% 0%/);
});

await test('MWG face regions: write, read back, keep, replace and remove', () => {
  const regions = { w: 4000, h: 3000, regions: [{ name: 'Asha & Co', type: 'Face', x: 0.5, y: 0.4, w: 0.1, h: 0.125 }] };
  const text = buildXmp({ rating: 3, tags: ['trips/goa'], regions });
  assert.match(text, /xmlns:mwg-rs=/);
  assert.match(text, /stArea:unit="normalized"/);
  const back = parseRegions(text);
  assert.deepEqual(back, { w: 4000, h: 3000, regions: [{ name: 'Asha & Co', type: 'Face', x: 0.5, y: 0.4, w: 0.1, h: 0.125 }] });
  assert.equal(parseXmp(text).rating, 3, 'the other properties still read');
  assert.deepEqual(parseXmp(text).tags, ['trips/goa']);

  // A Lightroom-style sidecar: element form, rdf:parseType="Resource" list items.
  const lr = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/"
    xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#" xmlns:stDim="http://ns.adobe.com/xap/1.0/sType/Dimensions#" xmp:Rating="2">
   <mwg-rs:Regions rdf:parseType="Resource">
    <mwg-rs:AppliedToDimensions rdf:parseType="Resource"><stDim:w>6000</stDim:w><stDim:h>4000</stDim:h><stDim:unit>pixel</stDim:unit></mwg-rs:AppliedToDimensions>
    <mwg-rs:RegionList><rdf:Bag>
     <rdf:li rdf:parseType="Resource"><mwg-rs:Type>Face</mwg-rs:Type><mwg-rs:Name>Ravi</mwg-rs:Name>
      <mwg-rs:Area rdf:parseType="Resource"><stArea:x>0.25</stArea:x><stArea:y>0.5</stArea:y><stArea:w>0.05</stArea:w><stArea:h>0.075</stArea:h><stArea:unit>normalized</stArea:unit></mwg-rs:Area></rdf:li>
     <rdf:li rdf:parseType="Resource"><mwg-rs:Type>Face</mwg-rs:Type>
      <mwg-rs:Area stArea:x="0.7" stArea:y="0.5" stArea:w="0.05" stArea:h="0.075" stArea:unit="normalized"/></rdf:li>
    </rdf:Bag></mwg-rs:RegionList>
   </mwg-rs:Regions>
  </rdf:Description></rdf:RDF></x:xmpmeta>`;
  const p = parseRegions(lr);
  assert.equal(p.w, 6000); assert.equal(p.h, 4000);
  assert.deepEqual(p.regions.map(x => [x.name, x.x]), [['Ravi', 0.25], ['', 0.7]]);

  const kept = buildXmp({ rating: 4, existing: lr });
  assert.deepEqual(parseRegions(kept).regions.map(x => x.name), ['Ravi', ''], 'regions left undefined stay as they were');
  assert.equal(parseXmp(kept).rating, 4);
  const replaced = buildXmp({ rating: 4, existing: lr, regions });
  assert.deepEqual(parseRegions(replaced).regions.map(x => x.name), ['Asha & Co']);
  assert.equal((replaced.match(/mwg-rs:Regions /g) ?? []).length, 1, 'one Regions block');
  const removed = buildXmp({ rating: 4, existing: lr, regions: { regions: [] } });
  assert.equal(parseRegions(removed), null, 'an empty list removes the block');
  assert.equal(parseRegions('<x:xmpmeta/>'), null);
});

console.log(`\n${passed} faces tests passed`);
