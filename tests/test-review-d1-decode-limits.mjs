// Review finding S16: decoder headers that claim more than 100 megapixels, or more data than
// the file holds, are refused before any pixel buffer is allocated; a thumbnail that needs a
// main-thread decode is saved as 'pending' first; and a 'pending' found at start-up becomes 'fail'.

import assert from 'node:assert/strict';

let canvases = 0, imageDatas = 0;
globalThis.OffscreenCanvas = class { constructor() { canvases++; } getContext() { return { putImageData() {} }; } transferToImageBitmap() { return {}; } };
globalThis.ImageData = class { constructor() { imageDatas++; } };

const { MAX_PIXELS, checkPixels, checkTga, checkDdsHeader, jxlSize, checkJxl, checkPsd } = await import('../src/decode/limits.js');
const { decodeTga } = await import('../src/decode/tga.js');
const { decodeDds } = await import('../src/decode/dds.js');
const TGA = (await import('../src/vendor/tga-js.mjs')).default;
const { createThumbs } = await import('../src/library/thumbs.js');

let n = 0;
const ok = (msg) => { n++; console.log('ok', msg); };

let tgaLoads = 0;
const load = TGA.prototype.load;
TGA.prototype.load = function (...a) { tgaLoads++; return load.apply(this, a); };

function tga(w, h, { type = 2, depth = 32, data = 4 } = {}) {
  const b = new Uint8Array(18 + data);
  b[2] = type; b[12] = w & 255; b[13] = w >> 8; b[14] = h & 255; b[15] = h >> 8; b[16] = depth;
  return b;
}
function dds(w, h, size = 128) {
  const b = new ArrayBuffer(size), v = new DataView(b);
  v.setUint32(0, 0x20534444, true); v.setUint32(4, 124, true); v.setUint32(8, 0x1007, true);
  v.setInt32(12, h, true); v.setInt32(16, w, true);
  v.setUint32(80, 4, true); v.setUint32(84, 0x31545844, true); // DDPF_FOURCC, 'DXT1'
  return b;
}

assert.equal(MAX_PIXELS, 100_000_000);
assert.doesNotThrow(() => checkPixels(10000, 10000));
assert.throws(() => checkPixels(10001, 10000), /100-megapixel limit/);
assert.throws(() => checkPixels(0, 10), /no usable size/);
ok('checkPixels allows 100 megapixels and refuses more');

// The 22-byte TGA from the review: a 4096 × 4096 header with 4 bytes of data.
await assert.rejects(decodeTga(new Blob([tga(4096, 4096)])), /needs at least/);
// Over the pixel budget: 65535 × 65535 (4.3 gigapixels).
await assert.rejects(decodeTga(new Blob([tga(65535, 65535)])), /100-megapixel limit/);
// Run-length: a 22-byte RLE file still cannot hold 4096 × 4096 pixels.
await assert.rejects(decodeTga(new Blob([tga(4096, 4096, { type: 10 })])), /needs at least/);
assert.equal(tgaLoads, 0, 'tga-js never ran');
assert.equal(canvases + imageDatas, 0, 'no canvas or ImageData was made');
assert.deepEqual(checkTga(tga(2, 2, { data: 16 })), { w: 2, h: 2 }, 'a complete 2 × 2 TGA passes');
ok('TGA: short data and oversized headers are refused before tga-js or a canvas runs');

// DDS: 16384 × 16384 (268 megapixels), and a 128-byte 1024 × 1024 file with no data.
await assert.rejects(decodeDds(new Blob([dds(16384, 16384)])), /100-megapixel limit/);
await assert.rejects(decodeDds(new Blob([dds(1024, 1024)])), /needs 524416/);
await assert.rejects(decodeDds(new Blob([dds(-4, 4)])), /no usable size/);
assert.equal(canvases + imageDatas, 0, 'no canvas or ImageData was made');
assert.deepEqual(checkDdsHeader(dds(4, 4, 136)), { w: 4, h: 4 });
ok('DDS: oversized headers and missing data are refused before decoding');

// PSD header: height at 14, width at 18.
const psd = new Uint8Array(26); psd.set([0x38, 0x42, 0x50, 0x53, 0, 1]);
new DataView(psd.buffer).setUint32(14, 30000); new DataView(psd.buffer).setUint32(18, 30000);
assert.throws(() => checkPsd(psd), /100-megapixel limit/);
new DataView(psd.buffer).setUint32(14, 300);
assert.deepEqual(checkPsd(psd), { w: 30000, h: 300 });
ok('PSD: the header size is checked before ag-psd loads');

// JPEG XL size header, written least significant bit first.
function jxl(fields) {
  const bits = [];
  for (const [v, n] of fields) for (let i = 0; i < n; i++) bits.push((v >> i) & 1);
  const out = new Uint8Array(2 + 16); out[0] = 0xFF; out[1] = 0x0A;
  bits.forEach((b, i) => { out[2 + (i >> 3)] |= b << (i & 7); });
  return out;
}
assert.deepEqual(jxlSize(jxl([[1, 1], [7, 5], [1, 3]])), { w: 64, h: 64 }, 'small header, ratio 1:1');
assert.deepEqual(jxlSize(jxl([[1, 1], [7, 5], [7, 3]])), { w: 128, h: 64 }, 'small header, ratio 2:1');
const big = jxl([[0, 1], [3, 2], [19999, 30], [0, 3], [3, 2], [19999, 30]]);
assert.deepEqual(jxlSize(big), { w: 20000, h: 20000 });
assert.throws(() => checkJxl(big), /100-megapixel limit/);
const boxed = new Uint8Array(12 + 8 + big.length);
boxed.set([0, 0, 0, 12, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A]);
new DataView(boxed.buffer).setUint32(12, 8 + big.length); boxed.set([0x6A, 0x78, 0x6C, 0x63], 16); boxed.set(big, 20);
assert.deepEqual(jxlSize(boxed), { w: 20000, h: 20000 }, 'codestream inside a jxlc box');
ok('JPEG XL: the size header is read from a bare codestream and from a container');

// Thumbnails: a main-thread decode is preceded by a saved 'pending', and fails cleanly.
const calls = [];
const records = new Map([
  ['r1/bomb.tga', { id: 'r1/bomb.tga', ext: 'tga', kind: 'photo', thumb: null }],
  ['r1/old.tga', { id: 'r1/old.tga', ext: 'tga', kind: 'photo', thumb: 'pending' }],
]);
const runs = [];
const lib = {
  records, loaded: true,
  get: (id) => records.get(id),
  on() {},
  async patchRecords(list, reason) { calls.push(list.map(p => `${p.id}:${p.thumb}`).join(',') + ` (${reason})`); for (const p of list) Object.assign(records.get(p.id), p); return list.length; },
  getFile: async () => new File([tga(4096, 4096)], 'bomb.tga'),
  jobs: { add(kind, list, fn) { for (const it of list) runs.push(fn(it, { aborted: false }).catch(e => e)); } },
};
const thumbs = createThumbs(lib);
assert.deepEqual(calls, ['r1/old.tga:fail (thumb)'], "a 'pending' found at start-up becomes 'fail'");
thumbs.enqueue([records.get('r1/bomb.tga')]);
const err = await runs[0];
assert.match(String(err?.message), /needs at least/);
assert.equal(calls[1], 'r1/bomb.tga:pending (thumb)', "'pending' is saved before the decode starts");
await new Promise(r => setTimeout(r, 400)); // the 'fail' patch is batched for 250 ms
assert.equal(calls[2], 'r1/bomb.tga:fail (thumb)');
assert.equal(records.get('r1/bomb.tga').thumb, 'fail');
ok("thumbnails: 'pending' before a main-thread decode, 'fail' after a refused one, stale 'pending' becomes 'fail'");

console.log(`${n} checks pass`);
