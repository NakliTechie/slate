// Size limits for Slate's own JavaScript and WebAssembly decoders (review finding S16).
//
// A file header states the picture's width and height, and these decoders allocate
// width × height × 4 bytes before they read any pixel data. A 22-byte TGA can claim
// 4096 × 4096 (64 MB), and a TGA or DDS header can claim far more. Each decoder calls
// these checks on the header first, so an oversized or truncated file is refused before
// anything is allocated.
//
// Formats the browser decodes itself (JPEG, PNG, WebP, GIF, AVIF, BMP, the JPEG inside a
// RAW file) are not checked here: the browser bounds its own decoders, and cameras with
// sensors above 100 megapixels exist.

export const MAX_PIXELS = 100_000_000; // 100 megapixels

export function checkPixels(w, h, what = 'This image') {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`${what} has no usable size in its header (${w} × ${h})`);
  }
  if (w * h > MAX_PIXELS) {
    throw new Error(`${what} claims ${w} × ${h} pixels, over Slate's ${MAX_PIXELS / 1e6}-megapixel limit, so Slate did not open it`);
  }
  return { w, h };
}

// TGA: header size, then enough data for the pixels the header claims.
// Uncompressed types (1, 2, 3) need width × height × bytes per pixel. Run-length types
// (9, 10, 11) pack at most 128 pixels into 1 + bytes-per-pixel bytes, which sets the minimum.
export function checkTga(bytes) {
  if (bytes.length < 18) throw new Error('TGA file is shorter than its 18-byte header');
  const idLength = bytes[0], colorMapType = bytes[1], imageType = bytes[2];
  const cmapLength = bytes[5] | (bytes[6] << 8), cmapDepth = bytes[7];
  const w = bytes[12] | (bytes[13] << 8), h = bytes[14] | (bytes[15] << 8);
  const bpp = Math.ceil(bytes[16] / 8);
  checkPixels(w, h, 'This TGA file');
  if (!bpp) throw new Error('TGA header has no pixel depth');
  const start = 18 + idLength + (colorMapType ? cmapLength * Math.ceil(cmapDepth / 8) : 0);
  const px = w * h;
  const rle = imageType === 9 || imageType === 10 || imageType === 11;
  const need = start + (rle ? Math.ceil(px / 128) * (1 + bpp) : px * bpp);
  if (bytes.length < need) {
    throw new Error(`TGA file is ${bytes.length} bytes, but its ${w} × ${h} header needs at least ${need}`);
  }
  return { w, h };
}

// DDS: the 128-byte header holds height at byte 12 and width at byte 16 (little-endian).
// Checked before dds-parser reads it; the data length is checked against the top image after.
export function checkDdsHeader(buf) {
  if (buf.byteLength < 128) throw new Error('DDS file is shorter than its 128-byte header');
  const v = new DataView(buf);
  const h = v.getInt32(12, true), w = v.getInt32(16, true);
  return checkPixels(w, h, 'This DDS file');
}

export function checkDdsData(buf, top) {
  if (top.offset + top.length > buf.byteLength) {
    throw new Error(`DDS file is ${buf.byteLength} bytes, but its ${top.shape.width} × ${top.shape.height} header needs ${top.offset + top.length}`);
  }
}

// PSD and PSB: '8BPS', version, 6 reserved bytes, channels, then height and width (big-endian uint32).
export function checkPsd(bytes) {
  if (bytes.length < 26 || bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) {
    throw new Error('This is not a Photoshop file (no 8BPS signature)');
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return checkPixels(v.getUint32(18), v.getUint32(14), 'This Photoshop file');
}

// JPEG XL: the size header at the start of the codestream, which is either the whole file
// (FF 0A) or the contents of a jxlc box or the first jxlp box in the ISO container.
// Returns null when no codestream start is found in `bytes`; the decoder then reports its own error.
export function jxlSize(bytes) {
  let cs = null;
  if (bytes[0] === 0xFF && bytes[1] === 0x0A) cs = 2;
  else if (bytes.length >= 12 && bytes[4] === 0x4A && bytes[5] === 0x58 && bytes[6] === 0x4C && bytes[7] === 0x20) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    while (off + 8 <= bytes.length) {
      let size = v.getUint32(off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      let head = 8;
      if (size === 1) { if (off + 16 > bytes.length) break; size = Number(v.getBigUint64(off + 8)); head = 16; }
      const body = off + head + (type === 'jxlp' ? 4 : 0);
      if (type === 'jxlc' || type === 'jxlp') {
        if (bytes[body] === 0xFF && bytes[body + 1] === 0x0A) cs = body + 2;
        break;
      }
      if (size === 0 || size < head) break;
      off += size;
    }
  }
  if (cs == null) return null;
  // Bits are read least significant first.
  let pos = cs * 8;
  const bit = () => { const b = (bytes[pos >> 3] >> (pos & 7)) & 1; pos++; return b; };
  const u = (n) => { let r = 0; for (let i = 0; i < n; i++) r += bit() * 2 ** i; return r; };
  const u32 = () => [9, 13, 18, 30][u(2)];
  if (pos + 64 > bytes.length * 8) return null;
  const small = bit();
  const h = small ? (u(5) + 1) * 8 : u(u32()) + 1;
  const ratio = u(3);
  const RATIOS = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
  let w;
  if (ratio) w = Math.floor(h * RATIOS[ratio][0] / RATIOS[ratio][1]);
  else w = small ? (u(5) + 1) * 8 : u(u32()) + 1;
  return { w, h };
}

export function checkJxl(bytes) {
  const s = jxlSize(bytes);
  if (s) checkPixels(s.w, s.h, 'This JPEG XL file');
  return s;
}
