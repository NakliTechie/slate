// Stacks (row B9) and Live Photo pairing (row M7) on lists of names and times. Node only.
import assert from 'node:assert/strict';
import { buildStacks, editInfo } from '../src/library/stacks.js';
import { pairLivePhotos } from '../src/library/scan.js';
import { newRecord } from '../src/library/schema.js';

// ── Live Photos ──────────────────────────────────────────────────────────────
{
  const { live, movs } = pairLivePhotos([
    'IMG_1234.HEIC', 'IMG_1234.MOV',          // pair
    'trip/IMG_2.JPG', 'trip/img_2.mov',       // pair, case differs
    'trip/IMG_3.MOV',                          // no photo: stays a video
    'other/IMG_1234.MOV',                      // other folder: stays a video
    'IMG_9.JPG', 'IMG_9.HEIC', 'IMG_9.MOV',   // HEIC preferred
    'clip.mp4', 'clip.jpg',                    // only MOV pairs
  ]);
  assert.deepEqual(Object.fromEntries(live), { 'IMG_1234.HEIC': 'IMG_1234.MOV', 'trip/IMG_2.JPG': 'trip/img_2.mov', 'IMG_9.HEIC': 'IMG_9.MOV' });
  assert.deepEqual([...movs].sort(), ['IMG_1234.MOV', 'IMG_9.MOV', 'trip/img_2.mov']);
}

// ── edit names ───────────────────────────────────────────────────────────────
assert.deepEqual(editInfo('IMG_1-261116101010.jpg'), { base: 'IMG_1', edit: '261116101010' });
assert.deepEqual(editInfo('IMG_1-261116101010-261117090000.png'), { base: 'IMG_1', edit: '261117090000' });
assert.deepEqual(editInfo('IMG_1.jpg'), { base: 'IMG_1', edit: null });
assert.deepEqual(editInfo('IMG-2024.jpg'), { base: 'IMG-2024', edit: null }, 'only a 12-digit suffix');

// ── stacks ───────────────────────────────────────────────────────────────────
const T = Date.UTC(2025, 5, 1, 10);
const rec = (path, { time = T, camera = '', src = 'exif', root = 'r' } = {}) => {
  const r = newRecord(root, path, { size: 1, lastModified: 1 });
  r.time = time; r.camera = camera; r.timeSource = src;
  return r;
};
{
  const records = [
    rec('a/IMG_1.CR2'), rec('a/IMG_1.JPG'),                                   // RAW plus JPEG
    rec('a/IMG_2.jpg'), rec('a/IMG_2-261116101010.jpg'), rec('a/IMG_2-261117090000.png'), // original plus 2 edits
    rec('b/IMG_1.JPG'),                                                         // other folder, alone
    rec('a/IMG_3-261116101010.jpg'),                                            // edit without its original
    rec('a/IMG_4.png'), rec('a/IMG_4.jpg'),                                     // same stem, no RAW, no edit
    ...[0, 400, 900, 1800].map((d, k) => rec(`c/B${k}.jpg`, { time: T + d, camera: 'Pixel 9' })), // burst of 4
    rec('c/X0.jpg', { time: T + 5000, camera: 'Pixel 9' }), rec('c/X1.jpg', { time: T + 5500, camera: 'Pixel 9' }), // 2 only
    ...[0, 100, 200].map((d, k) => rec(`c/Y${k}.jpg`, { time: T + 9000 + d, camera: k === 1 ? 'Canon' : 'Pixel 9' })), // camera breaks it
    ...[0, 100, 200].map((d, k) => rec(`c/Z${k}.jpg`, { time: T + 20000 + d, camera: 'Pixel 9', src: 'file' })), // no capture time
    rec('a/clip.mov'), rec('a/clip.jpg'),
  ];
  records.find(r => r.name === 'clip.mov').kind = 'video';
  const { stacks, stackOf } = buildStacks(records);
  const by = Object.fromEntries(stacks.map(s => [s.kind + ':' + s.top.split('/').pop(), s.members.map(id => id.slice(2))]));
  assert.deepEqual(by, {
    'raw:IMG_1.JPG': ['a/IMG_1.JPG', 'a/IMG_1.CR2'],
    'edit:IMG_2-261117090000.png': ['a/IMG_2-261117090000.png', 'a/IMG_2.jpg', 'a/IMG_2-261116101010.jpg'],
    'burst:B0.jpg': ['c/B0.jpg', 'c/B1.jpg', 'c/B2.jpg', 'c/B3.jpg'],
  });
  assert.equal(stackOf.get('r/a/IMG_1.CR2').top, 'r/a/IMG_1.JPG');
  for (const id of ['r/b/IMG_1.JPG', 'r/a/IMG_3-261116101010.jpg', 'r/a/IMG_4.png', 'r/c/X0.jpg', 'r/c/Y0.jpg', 'r/c/Z0.jpg', 'r/a/clip.jpg']) assert.ok(!stackOf.has(id), id);
}
{
  // Same names in two roots never stack together.
  const { stacks } = buildStacks([rec('IMG_1.CR2', { root: 'r1' }), rec('IMG_1.JPG', { root: 'r2' })]);
  assert.equal(stacks.length, 0);
}

console.log('test-library-stacks: all passed');
