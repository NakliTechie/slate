// Review S9: file dates and video dates land on the local day.
// Runs with TZ=Asia/Kolkata (set below, before any Date is made).
process.env.TZ = 'Asia/Kolkata';
import assert from 'node:assert/strict';
import { newRecord, dayKey, instantToWallClock } from '../src/library/schema.js';
import { readMetadata, videoTime, mvhdTime } from '../src/library/metadata.js';
import { buildLayout } from '../src/ui/library/grid-model.js';

// 1. A file modified at 01:30 IST on 2 January (20:00 UTC on 1 January) groups under 2 January.
{
  const instant = Date.UTC(2026, 0, 1, 20, 0, 0);
  assert.equal(new Date(instant).getHours(), 1, 'the test runs in IST');
  const rec = newRecord('r', 'a/late.jpg', { size: 10, lastModified: instant });
  assert.equal(rec.timeSource, 'file');
  assert.equal(rec.mtime, instant, 'mtime stays the raw lastModified (change detection)');
  assert.equal(dayKey(rec.time), '2026-01-02');
  assert.equal(new Date(rec.time).getUTCHours(), 1);
  assert.equal(new Date(rec.time).getUTCMinutes(), 30);
  const layout = buildLayout([rec], { width: 1000, zoom: 1, grouped: true });
  const header = layout.rows.find(r => r.type === 'header');
  assert.equal(header.unit, 'day');
  assert.equal(header.key, '2026-01-02', 'the grid groups it under 2 January');
  assert.equal(instantToWallClock(NaN), 0);
}

// ── tiny MP4 / MOV builders ──────────────────────────────────────────────────
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const box = (type, body) => [...be32(8 + body.length), ...ascii(type), ...body];
const MAC = 2082844800;
function mvhd(unixSeconds, version = 0) {
  const t = unixSeconds + MAC;
  if (version === 1) return box('mvhd', [1, 0, 0, 0, ...be32(Math.floor(t / 2 ** 32)), ...be32(t >>> 0), ...be32(0), ...be32(0), ...new Array(80).fill(0)]);
  return box('mvhd', [0, 0, 0, 0, ...be32(t), ...be32(t), ...be32(600), ...be32(0), ...new Array(80).fill(0)]);
}
function qtMeta(key, value) {
  const k = ascii(key), v = [...new TextEncoder().encode(value)];
  const hdlr = box('hdlr', [0, 0, 0, 0, ...be32(0), ...ascii('mdta'), ...new Array(12).fill(0), 0]);
  const keys = box('keys', [0, 0, 0, 0, ...be32(1), ...be32(8 + k.length), ...ascii('mdta'), ...k]);
  const item = [...be32(8 + 16 + v.length), ...be32(1), ...box('data', [...be32(1), ...be32(0), ...v])];
  const ilst = box('ilst', item);
  return box('meta', [...hdlr, ...keys, ...ilst]);  // QuickTime form: no version word
}
const ftyp = box('ftyp', [...ascii('isom'), ...be32(512), ...ascii('isomiso2mp41')]);
const mdat = box('mdat', new Array(5000).fill(7));
const fileOf = (bytes, name) => new File([new Uint8Array(bytes)], name);
const vrec = (name) => newRecord('r', name, { size: 1, lastModified: Date.UTC(2030, 0, 1) });

// 2. mvhd at the head: 10:00 UTC on 5 March 2024 is 15:30 IST, stored as that wall clock.
{
  const secs = Date.UTC(2024, 2, 5, 10, 0, 0) / 1000;
  const f = fileOf([...ftyp, ...box('moov', mvhd(secs)), ...mdat], 'clip.mp4');
  const m = await readMetadata(f, vrec('clip.mp4'));
  assert.equal(m.timeSource, 'video');
  assert.equal(m.time, Date.UTC(2024, 2, 5, 15, 30, 0));
  assert.equal(dayKey(m.time), '2024-03-05');
}

// 3. moov at the tail, mvhd version 1, late evening UTC crosses into the next local day.
{
  const secs = Date.UTC(2023, 11, 31, 20, 0, 0) / 1000;  // 01:30 IST on 1 January 2024
  const f = fileOf([...ftyp, ...mdat, ...box('moov', mvhd(secs, 1))], 'tail.mov');
  assert.equal(dayKey(await videoTime(f)), '2024-01-01');
}

// 4. QuickTime creationdate wins and keeps its own wall clock (the +0200 zone is ignored).
{
  const secs = Date.UTC(2022, 5, 1, 0, 0, 0) / 1000;
  const moov = box('moov', [...mvhd(secs), ...qtMeta('com.apple.quicktime.creationdate', '2022-06-01T08:15:00+0200')]);
  const f = fileOf([...box('ftyp', [...ascii('qt  '), ...be32(0), ...ascii('qt  ')]), ...moov, ...mdat], 'IMG_9.MOV');
  const m = await readMetadata(f, vrec('IMG_9.MOV'));
  assert.equal(m.timeSource, 'video');
  assert.equal(m.time, Date.UTC(2022, 5, 1, 8, 15, 0));
}

// 5. An unset mvhd time, a WebM file and junk bytes give no date and do not throw.
{
  assert.equal(mvhdTime(new Uint8Array(100)), null);
  assert.deepEqual(await readMetadata(fileOf([...ftyp, ...box('moov', mvhd(-MAC))], 'zero.mp4'), vrec('zero.mp4')), {});
  assert.deepEqual(await readMetadata(fileOf([26, 69, 223, 163, 1, 2, 3], 'a.webm'), vrec('a.webm')), {});
  assert.deepEqual(await readMetadata(fileOf(new Array(64).fill(255), 'bad.mp4'), vrec('bad.mp4')), {});
}

console.log('review d2 dates (S9): PASS');
