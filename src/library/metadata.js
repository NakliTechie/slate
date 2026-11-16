// Reads capture metadata from the head of a photo with exifr. See docs/architecture.md "Scan".
//
//   readMetadata(file, record) -> { time, timeSource: 'exif', w, h, orient, camera, lens, lat, lon, xmpTags, xmpRating, motion }
//
// `motion` (row M6) marks a Google Motion Photo: { offset, length } in bytes, where the
// embedded MP4 starts `offset` bytes before the end of the file and runs `length` bytes.
// motionFromXmp(text) reads it from the XMP packet; readMetadata keeps it only when the
// bytes at that place start an MP4 ('ftyp' box).
//
// Only the fields found are set. It never throws: unreadable metadata gives {}.
// Capture time is the EXIF wall clock stored as if it were UTC (schema.wallClockToTime),
// so no time-zone shift happens here. Videos (MP4, MOV, M4V) get only a capture date here,
// from videoTime(); thumbs.js reads their duration and size.

import { parse } from '../vendor/exifr.mjs';
import { wallClockToTime, instantToWallClock, extOf } from './schema.js';

// Formats exifr can read. Others (gif, bmp, svg, psd, tga, dds, jxl) have no EXIF to find.
const EXIF_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff',
  'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'raf', 'cr3']);
// TIFF-based RAW files keep the preview size in IFD0, so IFD0 width and height are not the photo's.
const RAW_EXTS = new Set(['dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'raf', 'cr3']);
// Videos in the ISO base media format (QuickTime and MP4 boxes). WebM is Matroska and has no mvhd.
const ISO_VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v']);
// Formats a Motion Photo can be (row M6).
const MOTION_EXTS = new Set(['jpg', 'jpeg', 'heic', 'heif']);
// The main XMP packet sits in the first APP1 blocks of a JPEG; HEIC keeps it near the head too.
const XMP_BYTES = 256 * 1024;
// Bytes read where exifr cannot read a Blob in chunks itself (Node has no FileReader).
const HEAD_BYTES = 512 * 1024;

const OPTIONS = {
  tiff: true, ifd0: true, exif: true, gps: true, xmp: true, iptc: true,
  ifd1: false, interop: false, icc: false, jfif: false, ihdr: false,
  translateKeys: true, translateValues: false, reviveValues: false,
  mergeOutput: true, silentErrors: true,
};

export async function readMetadata(file, record) {
  try {
    const ext = record?.ext ?? extOf(file.name);
    if ((record?.kind ?? 'photo') === 'video') {
      if (!ISO_VIDEO_EXTS.has(ext)) return {};
      const time = await videoTime(file);
      return time != null ? { time, timeSource: 'video' } : {};
    }
    if (!EXIF_EXTS.has(ext)) return {};
    // In the browser exifr reads the File in chunks from its head; elsewhere hand it the head.
    const input = typeof FileReader === 'function' ? file : new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const m = await parse(input, OPTIONS);
    const out = m ? fieldsFrom(m, RAW_EXTS.has(ext)) : {};
    if (MOTION_EXTS.has(ext)) {
      const motion = await readMotion(file);
      if (motion) out.motion = motion;
    }
    return out;
  } catch {
    return {};
  }
}

function fieldsFrom(m, isRaw) {
  const out = {};
  const time = parseWallClock(m.DateTimeOriginal ?? m.CreateDate ?? m.DateCreated ?? m.ModifyDate);
  if (time != null) { out.time = time; out.timeSource = 'exif'; }

  const orient = Number(m.Orientation);
  if (orient >= 1 && orient <= 8) out.orient = orient;
  let w = num(m.ExifImageWidth ?? m.PixelXDimension ?? (isRaw ? null : m.ImageWidth));
  let h = num(m.ExifImageHeight ?? m.PixelYDimension ?? (isRaw ? null : m.ImageHeight));
  if (w && h) {
    if (orient >= 5) [w, h] = [h, w];
    out.w = w; out.h = h;
  }

  const make = str(m.Make), model = str(m.Model);
  const camera = model && make && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : [make, model].filter(Boolean).join(' ');
  if (camera) out.camera = camera;
  const lens = str(m.LensModel ?? m.Lens);
  if (lens) out.lens = lens;

  if (Number.isFinite(m.latitude) && Number.isFinite(m.longitude) && !(m.latitude === 0 && m.longitude === 0)) {
    out.lat = m.latitude; out.lon = m.longitude;
  }

  const tags = [...list(m.subject), ...list(m.Keywords)].map(t => String(t).trim()).filter(Boolean);
  if (tags.length) out.xmpTags = [...new Set(tags)];
  const rating = Number(m.Rating);
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) out.xmpRating = rating;
  return out;
}

// "2024:05:01 09:30:15", "2024-05-01T09:30:15+05:30" -> stored time; any zone suffix is ignored.
export function parseWallClock(v) {
  if (typeof v !== 'string') return null;
  const x = /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v.trim());
  if (!x) return null;
  const [y, mo, d, hh = 0, mi = 0, s = 0] = x.slice(1).map(n => (n == null ? 0 : Number(n)));
  if (y < 1800 || mo < 1 || mo > 12 || d < 1 || d > 31) return null; // "0000:00:00 00:00:00" from some cameras
  return wallClockToTime(y, mo, d, hh, mi, s);
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
function str(v) { return typeof v === 'string' ? v.replace(/\0+$/, '').trim() : ''; }
function list(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

// ── Motion Photos (row M6) ─────────────────────────────────────────────────

async function readMotion(file) {
  const head = latin1(new Uint8Array(await file.slice(0, XMP_BYTES).arrayBuffer()));
  const motion = motionFromXmp(head);
  if (!motion || motion.offset > file.size || motion.length > motion.offset) return null;
  const at = file.size - motion.offset;
  const box = latin1(new Uint8Array(await file.slice(at + 4, at + 8).arrayBuffer()));
  return box === 'ftyp' ? motion : null;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

// A property written as an attribute (ns:Name="v") or as an element (<ns:Name>v</ns:Name>).
function prop(text, names) {
  for (const n of names) {
    const x = new RegExp(`${n}\\s*=\\s*["']([^"']*)["']|<${n}>([^<]*)<`).exec(text);
    if (x) return (x[1] ?? x[2]).trim();
  }
  return null;
}

/**
 * The embedded video of a Google Motion Photo, from XMP text (or any text holding the packet).
 * Reads the Container directory (Container:Item with Item:Length and Item:Padding, or the
 * older GContainer:Item with GContainer:ItemLength), else the older GCamera:MicroVideoOffset.
 * @returns {{ offset: number, length: number } | null}  bytes from the end of the file
 */
export function motionFromXmp(text) {
  if (typeof text !== 'string' || !text) return null;
  const flag = prop(text, ['GCamera:MotionPhoto', 'GCamera:MicroVideo']);
  if (flag === '0') return null;

  // Container directory: items in file order; the video is the item whose semantic is
  // MotionPhoto (or whose mime is video/*). Everything from it to the end follows the image.
  const starts = [...text.matchAll(/<(?:Container|GContainer):Item\b/g)].map(m => m.index);
  const items = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : text.indexOf('</rdf:Seq>', s) >>> 0;
    const part = text.slice(s, end);
    return {
      semantic: prop(part, ['Item:Semantic', 'GContainer:ItemSemantic']) || '',
      mime: prop(part, ['Item:Mime', 'GContainer:ItemMime']) || '',
      length: Number(prop(part, ['Item:Length', 'GContainer:ItemLength']) || 0),
      padding: Number(prop(part, ['Item:Padding', 'GContainer:ItemPadding']) || 0),
    };
  });
  let k = items.findIndex(i => i.semantic === 'MotionPhoto');
  if (k < 0) k = items.findIndex(i => i.mime.startsWith('video/'));
  if (k > 0 && items[k].length > 0) {
    let offset = 0;
    for (let j = k; j < items.length; j++) offset += (items[j].length || 0) + (j < items.length - 1 ? items[j].padding || 0 : 0);
    if (Number.isFinite(offset)) return { offset, length: items[k].length };
  }

  const micro = Number(prop(text, ['GCamera:MicroVideoOffset']));
  if (micro > 0 && flag !== '0') return { offset: micro, length: micro };
  return null;
}

// ── video capture date (review S9) ─────────────────────────────────────────
// An MP4 or MOV is a list of boxes: 4-byte size, 4-byte type, then the body (size 1 means a
// 64-bit size follows; size 0 means "to the end of the file"). The `moov` box sits at the head
// or the tail of the file. Inside it:
//   mvhd   creation time, seconds since 1904-01-01 UTC: a true instant, so it is turned into
//          this browser's local wall clock (schema.instantToWallClock). Zero means unset.
//   meta   QuickTime metadata: `keys` names each item and `ilst` holds the values. The key
//          com.apple.quicktime.creationdate is "2023-05-01T09:30:15+0530", the wall clock where
//          it was filmed, kept as written (the zone is ignored, as for EXIF).
// The QuickTime date wins, because it carries the place's own wall clock.
// Only box headers are read while walking, and only mvhd, meta and udta bodies are read whole.

const MAC_EPOCH_S = 2082844800;      // seconds from 1904-01-01 to 1970-01-01
const MAX_BOXES = 4096;
const MAX_META_BYTES = 4 * 1024 * 1024;

async function readBytes(file, at, len) {
  return new Uint8Array(await file.slice(at, Math.min(file.size, at + len)).arrayBuffer());
}
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// Children of the box body [start, end) in the file, from headers only.
async function boxesIn(file, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end && out.length < MAX_BOXES) {
    const h = await readBytes(file, at, 16);
    if (h.length < 8) break;
    let size = u32(h, 0), head = 8;
    const type = type4(h, 4);
    if (size === 1) { if (h.length < 16) break; size = u64(h, 8); head = 16; }
    else if (size === 0) size = end - at;
    if (size < head || at + size > end) break;
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}

// The same walk over bytes already in memory.
function boxesInBytes(b, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end && out.length < MAX_BOXES) {
    let size = u32(b, at), head = 8;
    const type = type4(b, at + 4);
    if (size === 1) { if (at + 16 > end) break; size = u64(b, at + 8); head = 16; }
    else if (size === 0) size = end - at;
    if (size < head || at + size > end) break;
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}

/** mvhd body (after the 8-byte header) -> stored time, or null. */
export function mvhdTime(b) {
  if (!b || b.length < 12) return null;
  const secs = b[0] === 1 ? (b.length >= 12 ? u64(b, 4) : 0) : u32(b, 4);
  if (!secs || secs <= MAC_EPOCH_S) return null;       // unset, or before 1970
  return instantToWallClock((secs - MAC_EPOCH_S) * 1000);
}

/** A QuickTime `meta` body -> { 'com.apple.quicktime.creationdate': '...' , ... } (strings only). */
export function quickTimeKeys(b) {
  const out = {};
  // QuickTime writes meta without the version and flags word that ISO meta has; tell them apart
  // by where the first child box (hdlr) starts.
  const start = b.length >= 8 && type4(b, 4) === 'hdlr' ? 0 : 4;
  const kids = boxesInBytes(b, start, b.length);
  const keysBox = kids.find(k => k.type === 'keys'), ilst = kids.find(k => k.type === 'ilst');
  if (!keysBox || !ilst) return out;
  const names = [];
  const n = u32(b, keysBox.start + 4);
  let at = keysBox.start + 8;
  for (let i = 0; i < n && at + 8 <= keysBox.end; i++) {
    const size = u32(b, at);
    if (size < 8 || at + size > keysBox.end) break;
    names.push(new TextDecoder().decode(b.subarray(at + 8, at + size)));
    at += size;
  }
  for (const item of boxesInBytes(b, ilst.start, ilst.end)) {
    const idx = u32(b, item.start - 4) - 1;  // the item's type is its 1-based key index
    const name = names[idx];
    if (!name) continue;
    const data = boxesInBytes(b, item.start, item.end).find(k => k.type === 'data');
    if (!data || data.end - data.start < 8) continue;
    const kind = u32(b, data.start) & 0xffffff;
    if (kind === 1) out[name] = new TextDecoder().decode(b.subarray(data.start + 8, data.end)).trim();
  }
  return out;
}

/** The capture date of an MP4 or MOV file, as a stored time, or null. Never throws. */
export async function videoTime(file) {
  try {
    const top = await boxesIn(file, 0, file.size);
    if (!top.length || !['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(top[0].type)) return null;
    const moov = top.find(x => x.type === 'moov');
    if (!moov) return null;
    let mvhd = null, qt = null;
    const scanMeta = async (box) => {
      if (box.end - box.start > MAX_META_BYTES) return;
      const t = quickTimeKeys(await readBytes(file, box.start, box.end - box.start))['com.apple.quicktime.creationdate'];
      const v = t ? parseWallClock(t) : null;
      if (v != null && qt == null) qt = v;
    };
    for (const k of await boxesIn(file, moov.start, moov.end)) {
      if (k.type === 'mvhd' && mvhd == null) mvhd = mvhdTime(await readBytes(file, k.start, Math.min(k.end - k.start, 32)));
      else if (k.type === 'meta') await scanMeta(k);
      else if (k.type === 'udta') for (const u of await boxesIn(file, k.start, k.end)) if (u.type === 'meta') await scanMeta(u);
    }
    return qt ?? mvhd;
  } catch {
    return null;
  }
}
