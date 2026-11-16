// Review finding S19: with "Strip EXIF" off, the exported JPEG gets a cleaned copy of the
// original EXIF: no embedded thumbnail, orientation 1, and no GPS unless the person keeps it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExif, sanitiseExifApp1 } from '../src/exif.js';

let n = 0;
const ok = (msg) => { n++; console.log('ok', msg); };

// A little-endian EXIF APP1: IFD0 (orientation 6, GPS pointer), GPS IFD (N 19° 4' 12.34"),
// IFD1 pointing at a 17-byte "thumbnail".
function app1() {
  const tiff = new Uint8Array(139), v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  const entry = (at, tag, type, count, value) => { v.setUint16(at, tag, true); v.setUint16(at + 2, type, true); v.setUint32(at + 4, count, true); v.setUint32(at + 8, value, true); };
  v.setUint16(8, 2, true); entry(10, 0x0112, 3, 1, 6); entry(22, 0x8825, 4, 1, 38); v.setUint32(34, 92, true);
  v.setUint16(38, 2, true); entry(40, 0x0001, 2, 2, 0x4E); entry(52, 0x0002, 5, 3, 68); v.setUint32(64, 0, true);
  [[19, 1], [4, 1], [1234, 100]].forEach(([a, b], i) => { v.setUint32(68 + i * 8, a, true); v.setUint32(72 + i * 8, b, true); });
  v.setUint16(92, 2, true); entry(94, 0x0201, 4, 1, 122); entry(106, 0x0202, 4, 1, 17); v.setUint32(118, 0, true);
  tiff.set(new TextEncoder().encode('THUMBNAIL-PICTURE'), 122);
  const seg = new Uint8Array(10 + tiff.length);
  seg.set([0xFF, 0xE1, (seg.length - 2) >> 8, (seg.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}
const jpeg = (seg) => new Blob([new Uint8Array([0xFF, 0xD8]), seg, new Uint8Array([0xFF, 0xDA, 0, 2, 0xFF, 0xD9])]);
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));
const ifd1Pointer = (seg) => { const v = new DataView(seg.buffer, seg.byteOffset + 10); const ifd0 = v.getUint32(4, true); return v.getUint32(ifd0 + 2 + v.getUint16(ifd0, true) * 12, true); };

const original = app1();
const before = await parseExif(jpeg(original));
assert.equal(before.orientation, 6);
assert.ok(before.gps?.latitude, 'the test block has a GPS latitude');
assert.ok(has(original, 'THUMBNAIL-PICTURE') && ifd1Pointer(original) === 92);
ok('the synthetic EXIF block has a thumbnail, orientation 6 and GPS');

const clean = sanitiseExifApp1(original.buffer.slice(0));
const after = await parseExif(jpeg(clean));
assert.equal(after.orientation, 1, 'orientation is 1');
assert.equal(after.gpsIFD, undefined, 'no GPS pointer');
assert.equal(after.gps, undefined, 'no GPS directory');
assert.equal(ifd1Pointer(clean), 0, 'IFD1 is unlinked');
assert.ok(!has(clean, 'THUMBNAIL-PICTURE'), 'the thumbnail bytes are gone');
assert.ok(clean.subarray(10 + 38, 10 + 92).every(b => b === 0), 'the GPS directory and its rationals are zeroed');
assert.equal(clean.length, original.length, 'other offsets are unchanged');
ok('cleaned: no thumbnail, orientation 1, no GPS');

const keep = sanitiseExifApp1(original, { removeLocation: false });
const kept = await parseExif(jpeg(keep));
assert.deepEqual(kept.gps?.latitude, [[19, 1], [4, 1], [1234, 100]], 'GPS stays when removeLocation is false');
assert.equal(kept.orientation, 1);
assert.ok(!has(keep, 'THUMBNAIL-PICTURE') && ifd1Pointer(keep) === 0);
ok('with removeLocation false: GPS kept, thumbnail and orientation still cleaned');

const broken = app1(); new DataView(broken.buffer).setUint32(10 + 4, 9999, true); // IFD0 past the end
assert.equal(sanitiseExifApp1(broken), null, 'an unreadable block gives null, so no EXIF is written');
assert.equal(sanitiseExifApp1(new Uint8Array([0xFF, 0xE1, 0, 8, 1, 2, 3, 4, 5, 6])), null);
ok('a block that cannot be cleaned is dropped');

const enc = readFileSync(new URL('../src/encode/jpeg.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
assert.match(enc, /sanitiseExifApp1\(exifRaw, \{ removeLocation \}\)/, 'encodeJpeg writes only the cleaned block');
assert.match(enc, /removeLocation = true/, 'remove location is on by default');
assert.match(app, /encodeJpeg\(flat, exp\.quality, exifRaw, \{ removeLocation: exp\.removeLocation !== false \}\)/, 'the editor export passes the switch');
ok('the editor export goes through the cleaned path, location removed by default');

console.log(`${n} checks pass`);
