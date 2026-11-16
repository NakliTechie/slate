// Edit list embedded in an exported file (plan/pending.md, 2026-10-12): Slate writes the
// operations that made an export into the file, so reopening it shows what was done and the
// same edits can be applied to another image. Off by default (Export dialog), because the
// list is metadata and Slate strips metadata unless asked.
//
// Transport, adapted from Muse (NakliTechie/Muse, same author): the payload "slate\0<json>"
//   PNG   a tEXt chunk with keyword "slate", spliced before IEND
//   JPEG  a COM (0xFFFE) segment after SOI and APP0
// WebP and TIFF exports carry no list. The JSON is ASCII (non-ASCII is \u-escaped), so
// Latin-1 bytes round-trip exactly.
//
// Recipe JSON: { app: 'slate', v: 1, w, h, ops: [{ op, params }] }. A LUT's table is too large
// for a COM segment, so a LUT op keeps its name, title and strength and drops `data`.

export const RECIPE_KEYWORD = 'slate';
const MAX_JSON = 60000; // a JPEG COM segment holds at most 65,533 bytes

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const latin1Bytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
const latin1Str = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// The recipe for the ops up to the history pointer, or null when there is nothing to record.
export function buildRecipe(ops, { w, h } = {}) {
  if (!ops?.length) return null;
  const list = ops.map(({ op, params }) => {
    if (op === 'lut') { const { data, ...rest } = params || {}; return { op, params: { ...rest, dataOmitted: true } }; }
    // A depth map is about 200 KB, too large for a COM segment; the blur is recorded without it.
    if (op === 'lensblur') { const { depth, ...rest } = params || {}; return { op, params: { ...rest, depthOmitted: true } }; }
    return { op, params };
  });
  const json = asciiJson({ app: 'slate', v: 1, w, h, ops: list });
  return json.length <= MAX_JSON ? json : null;
}

export function parseRecipe(json) {
  try {
    const r = JSON.parse(json);
    if (r?.app !== 'slate' || r.v !== 1 || !Array.isArray(r.ops)) return null;
    return { w: r.w, h: r.h, ops: r.ops.filter(o => o && typeof o.op === 'string') };
  } catch { return null; }
}

export function embedRecipePNG(png, json) {
  if (png.length < 20 || png[0] !== 0x89 || png[1] !== 0x50) return png;
  const type = latin1Bytes('tEXt');
  const data = latin1Bytes(RECIPE_KEYWORD + '\0' + json);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length); crcIn.set(type, 0); crcIn.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcIn));
  const iend = png.length - 12;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

export function readRecipePNG(png) {
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = latin1Str(png.subarray(p + 4, p + 8));
    if (type === 'tEXt') {
      const data = png.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z >= 0 && latin1Str(data.subarray(0, z)) === RECIPE_KEYWORD) return latin1Str(data.subarray(z + 1));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}

export function embedRecipeJPEG(jpeg, json) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const payload = latin1Bytes(RECIPE_KEYWORD + '\0' + json);
  const segLen = payload.length + 2;
  if (segLen > 0xffff) return jpeg;
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff; seg[1] = 0xfe; seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
  seg.set(payload, 4);
  // After the leading APPn segments (JFIF APP0 and EXIF APP1 come first), else after SOI.
  let at = 2;
  while (jpeg[at] === 0xff && jpeg[at + 1] >= 0xe0 && jpeg[at + 1] <= 0xef) {
    const alen = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (alen < 2 || at + 2 + alen > jpeg.length) break;
    at += 2 + alen;
  }
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

export function readRecipeJPEG(jpeg) {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) { p++; continue; }
    const marker = jpeg[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (len < 2) break;
    if (marker === 0xfe) {
      const data = jpeg.subarray(p + 4, p + 2 + len);
      const z = data.indexOf(0);
      if (z >= 0 && latin1Str(data.subarray(0, z)) === RECIPE_KEYWORD) return latin1Str(data.subarray(z + 1));
    }
    p += 2 + len;
  }
  return null;
}

// Embed into an encoded Blob (PNG or JPEG); other formats come back unchanged.
export async function embedRecipe(blob, format, json) {
  if (!json || (format !== 'png' && format !== 'jpeg')) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = format === 'png' ? embedRecipePNG(bytes, json) : embedRecipeJPEG(bytes, json);
  return new Blob([out], { type: blob.type });
}

// Read a recipe from a File. JPEG segments sit at the start; a PNG chunk sits before IEND,
// so a PNG is read whole (only when under 64 MB).
export async function readRecipe(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head[0] === 0xff && head[1] === 0xd8) return parseRecipe(readRecipeJPEG(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())) ?? '');
    if (head[0] === 0x89 && head[1] === 0x50 && file.size < 64 * 1024 * 1024) return parseRecipe(readRecipePNG(new Uint8Array(await file.arrayBuffer())) ?? '');
  } catch { /* unreadable: no recipe */ }
  return null;
}
