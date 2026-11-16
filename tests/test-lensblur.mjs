// Background blur (src/ops/lensblur.js): the radius rule, the level blend and the edge guard,
// on synthetic images and depth maps. Pure Node, no model.
import assert from 'node:assert/strict';
import {
  depthBytes, resampleDepth, depthAt, maxRadius, radiusMap, lensBlurPixels, renderLensBlur,
} from '../src/ops/lensblur.js';
import { DEPTH_MODEL, DEPTH_REVISION, DEPTH_WEIGHTS, normaliseDepth } from '../src/ops/depth.js';
import { LICENCES } from '../src/library/licences.js';
import { readFileSync } from 'node:fs';

let n = 0;
const failed = [];
const check = (fn, msg) => {
  try { fn(); n++; console.log('ok', msg); }
  catch (e) { failed.push(msg); console.log('FAIL', msg, '\n ', e.message); }
};

// A W x H RGBA image from f(x, y) -> [r, g, b].
function image(W, H, f) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = f(x, y), p = (y * W + x) * 4;
    px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
  }
  return px;
}
// A noisy pattern, so blur changes it measurably.
const noise = (x, y) => { const v = ((x * 73856093) ^ (y * 19349663)) & 255; return [v, 255 - v, (v * 7) & 255]; };
// Mean absolute difference from the source over a pixel range of rows.
function change(a, b, W, y0, y1) {
  let s = 0, k = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) { s += Math.abs(a[p + c] - b[p + c]); k++; }
  }
  return s / k;
}

check(() => {
  const dep = { w: 2, h: 2, data: new Uint8Array([0, 255, 0, 255]) };
  const d = resampleDepth(dep, 4, 4);
  assert.equal(d.length, 16);
  assert.equal(d[0], 0, 'left edge keeps the left value');
  assert.equal(d[3], 1, 'right edge keeps the right value');
  assert.ok(Math.abs(d[1] - 0.25) < 1e-6 && Math.abs(d[2] - 0.75) < 1e-6, `inner columns interpolate: ${d[1]}, ${d[2]}`);
  assert.equal(d[5], d[1], 'rows match when the map is constant in y');
  const same = resampleDepth({ w: 3, h: 2, data: new Uint8Array([10, 20, 30, 40, 50, 60]) }, 3, 2);
  assert.deepEqual([...same].map(v => Math.round(v * 255)), [10, 20, 30, 40, 50, 60], 'same size is the identity');
  assert.ok(Math.abs(depthAt(dep, 0, 0.5) - 0) < 1e-6 && Math.abs(depthAt(dep, 1, 0.5) - 1) < 1e-6, 'depthAt reads the edges');
  assert.ok(Math.abs(depthAt(dep, 0.5, 0.5) - 0.5) < 1e-6, 'depthAt interpolates the centre');
}, 'depth map resampling is bilinear and the identity at the same size');

check(() => {
  const plain = depthBytes({ w: 2, h: 1, data: { 0: 7, 1: 9 } });
  assert.deepEqual([...plain.data], [7, 9], 'an object with numeric keys (JSON of a typed array) is read');
  assert.throws(() => depthBytes({ w: 4, h: 4, data: new Uint8Array(3) }), /shorter/);
  assert.throws(() => depthBytes(null), /no depth map/);
}, 'depth params survive JSON and reject a short map');

check(() => {
  const W = 64, H = 48, px = image(W, H, noise);
  const flat = { w: 8, h: 6, data: new Uint8Array(48).fill(128) };
  const out = renderLensBlur(px, W, H, { focus: { x: 0.3, y: 0.7 }, strength: 100, depth: flat });
  assert.deepEqual([...out], [...px], 'every pixel at the focus depth is unchanged');
  const r = radiusMap(new Float32Array([0.2, 0.5, 0.9]), 0.5, 10);
  assert.ok(Math.abs(r[0] - 3) < 1e-5 && r[1] === 0 && Math.abs(r[2] - 4) < 1e-5, 'r = maxR * |d - d0|');
  assert.equal(maxRadius(0, 4000, 3000), 0);
  assert.equal(maxRadius(100, 4000, 3000), 200);
  assert.equal(maxRadius(250, 4000, 3000), 200, 'strength is clamped to 100');
}, 'radius 0 at the focus depth leaves pixels unchanged');

check(() => {
  // Depth falls from 1 (near, top) to 0 (far, bottom); focus on the near top rows.
  const W = 96, H = 96, px = image(W, H, noise);
  const data = new Uint8Array(96 * 96);
  for (let y = 0; y < 96; y++) data.fill(Math.round(255 * (1 - y / 95)), y * 96, (y + 1) * 96);
  const out = renderLensBlur(px, W, H, { focus: { x: 0.5, y: 0 }, strength: 100, depth: { w: 96, h: 96, data } });
  const near = change(px, out, W, 0, 8), mid = change(px, out, W, 40, 56), far = change(px, out, W, 88, 96);
  assert.ok(near < mid && mid < far, `blur grows with distance from focus: near ${near.toFixed(1)}, mid ${mid.toFixed(1)}, far ${far.toFixed(1)}`);
  assert.ok(far > 20, `the far plane is clearly blurred (${far.toFixed(1)})`);
}, 'a far plane is blurred more than a near plane');

check(() => {
  // One pixel row of noise; the radius rises in fine steps; output must change in small steps.
  const W = 128, H = 64, px = image(W, H, noise);
  let worst = 0;
  const outs = [];
  for (let k = 0; k <= 400; k++) {
    const rr = k * 0.05; // 0 .. 20 px, crossing levels at 2, 4, 8, 16
    outs.push(lensBlurPixels(px, W, H, new Float32Array(W * H).fill(rr)));
  }
  for (let k = 1; k < outs.length; k++) worst = Math.max(worst, change(outs[k - 1], outs[k], W, 0, H));
  assert.ok(worst < 3, `largest mean change for a 0.05 px step in radius is ${worst.toFixed(2)} (limit 3)`);
}, 'the level blend is continuous in the radius');

check(() => {
  // Left half: white subject at the focus depth (near). Right half: black background (far).
  const W = 200, H = 60, edge = 100;
  const px = image(W, H, (x) => (x < edge ? [255, 255, 255] : [0, 0, 0]));
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = x < edge ? 255 : 0;
  const out = renderLensBlur(px, W, H, { focus: { x: 0.1, y: 0.5 }, strength: 100, depth: { w: W, h: H, data } });
  let leak = 0, subject = 0;
  for (let y = 0; y < H; y++) {
    for (let x = edge + 1; x < W; x++) leak = Math.max(leak, out[(y * W + x) * 4]);
    for (let x = 0; x < edge; x++) subject = Math.max(subject, 255 - out[(y * W + x) * 4]);
  }
  assert.equal(subject, 0, 'the in-focus subject is unchanged');
  assert.ok(leak <= 8, `brightest background pixel past the edge is ${leak} (tolerance 8 of 255)`);
  // The same background, uniform but noisy, is still blurred: the guard does not switch blur off.
  const bg = image(W, H, (x, y) => (x < edge ? [255, 255, 255] : noise(x, y)));
  const out2 = renderLensBlur(bg, W, H, { focus: { x: 0.1, y: 0.5 }, strength: 100, depth: { w: W, h: H, data } });
  let s = 0, k = 0;
  for (let y = 0; y < H; y++) for (let x = edge + 20; x < W; x++) { s += Math.abs(out2[(y * W + x) * 4] - bg[(y * W + x) * 4]); k++; }
  assert.ok(s / k > 20, `the background is still blurred (mean change ${(s / k).toFixed(1)})`);
}, 'a sharp foreground edge does not smear into the blurred background');

check(() => {
  assert.deepEqual([...normaliseDepth(new Float32Array([2, 4, 6]))], [0, 128, 255], 'min-max to bytes');
  assert.deepEqual([...normaliseDepth(new Uint8Array([9, 0, 0, 9, 0, 0]), 3)], [0, 0], 'reads channel 0 of a multi-channel map; flat map is 0');
  const lic = LICENCES.find(l => l.name === DEPTH_MODEL);
  assert.ok(lic, 'the depth model is in licences.js');
  assert.equal(lic.licence, 'Apache-2.0');
  assert.match(DEPTH_REVISION, /^[0-9a-f]{40}$/, 'the model is pinned to a full commit');
  assert.equal(lic.version, `revision ${DEPTH_REVISION.slice(0, 7)}`, 'licences.js names the pinned revision');
  const sec = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
  assert.ok(sec.includes(DEPTH_MODEL) && sec.includes(DEPTH_REVISION.slice(0, 7)), 'SECURITY.md names the model and revision');
  assert.equal(Math.round(DEPTH_WEIGHTS.q8.bytes / 1e6), 27);
}, 'depth model is pinned, Apache-2.0, and listed in licences.js and SECURITY.md');

check(() => {
  // 12 MP: 4000 x 3000, a 512 x 384 depth map with a near-to-far ramp, Strength 100.
  const W = 4000, H = 3000, px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24;
  const data = new Uint8Array(512 * 384);
  for (let i = 0; i < data.length; i++) data[i] = (i % 512) >> 1;
  const t = performance.now();
  renderLensBlur(px, W, H, { focus: { x: 0.2, y: 0.5 }, strength: 100, depth: { w: 512, h: 384, data } });
  const ms = performance.now() - t;
  console.log(`  12 MP render: ${Math.round(ms)} ms`);
  assert.ok(ms < 4000, `12 MP render took ${Math.round(ms)} ms (limit 4000 here; target about 2000)`);
}, '12 MP render time');

console.log(failed.length ? `Slate background blur: ${failed.length} FAILED of ${n + failed.length}` : `Slate background blur: PASS (${n} checks)`);
if (failed.length) process.exit(1);
