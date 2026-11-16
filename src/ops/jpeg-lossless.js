// Lossless JPEG rotate via EXIF orientation manipulation.
// The pixel bytes are untouched — we only flip the orientation tag.
// Works in any viewer that honours EXIF orientation (most do).

// CW rotation sequence for non-flipped orientations
const CW_NORMAL  = [1, 6, 3, 8];
// Same sequence for flipped orientations
const CW_FLIPPED = [2, 5, 4, 7];

export function computeNewOrientation(current, cwTurns) {
  const t = ((cwTurns % 4) + 4) % 4;
  const i = CW_NORMAL.indexOf(current);
  if (i !== -1) return CW_NORMAL[(i + t) % 4];
  const fi = CW_FLIPPED.indexOf(current);
  if (fi !== -1) return CW_FLIPPED[(fi + t) % 4];
  return current;
}

// Returns a new Blob with the rotated orientation tag.
// cwTurns: 1 = 90° CW, 2 = 180°, 3 = 90° CCW
export async function rotateJpegLossless(blob, cwTurns) {
  if (blob.type && blob.type !== 'image/jpeg') throw new Error('Not a JPEG');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint16(0) !== 0xFFD8) throw new Error('Not a JPEG (missing SOI marker)');

  // Walk APP0-APP15 segments looking for EXIF APP1
  let offset = 2;
  while (offset < buf.length - 2) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFDA) break; // SOS — no more metadata
    if (marker < 0xFFE0 || marker > 0xFFEF) {
      // Not an APP marker; move past it if it has a length
      const segLen = view.getUint16(offset + 2);
      offset += 2 + segLen;
      continue;
    }
    const segLen = view.getUint16(offset + 2);
    if (marker === 0xFFE1 &&
        view.getUint32(offset + 4) === 0x45786966 &&
        view.getUint16(offset + 8) === 0x0000) {
      // EXIF APP1 found — locate orientation tag (0x0112) in IFD0
      const tiffStart = offset + 10;
      const byteOrder = view.getUint16(tiffStart);
      if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) throw new Error('Invalid TIFF byte order');
      const le = byteOrder === 0x4949;
      if (view.getUint16(tiffStart + 2, le) !== 42) throw new Error('Invalid TIFF magic');
      const ifd0Off = tiffStart + view.getUint32(tiffStart + 4, le);
      const count = view.getUint16(ifd0Off, le);
      for (let i = 0; i < count; i++) {
        const entryOff = ifd0Off + 2 + i * 12;
        if (view.getUint16(entryOff, le) === 0x0112) {
          // Orientation entry: value is inline at entryOff + 8 (type SHORT, count 1)
          const current = view.getUint16(entryOff + 8, le);
          const next = computeNewOrientation(current, cwTurns);
          // Return a copy with the new value
          const out = new Uint8Array(buf);
          const outView = new DataView(out.buffer);
          outView.setUint16(entryOff + 8, next, le);
          return new Blob([out], { type: 'image/jpeg' });
        }
      }
      // APP1 exists but no orientation tag — inject one
      return insertOrientationInExif(buf, offset, segLen, tiffStart, computeNewOrientation(1, cwTurns));
    }
    offset += 2 + segLen;
  }

  // No EXIF segment at all — inject a minimal one
  return injectMinimalExif(buf, computeNewOrientation(1, cwTurns));
}

// Build a minimal APP1 EXIF segment containing just orientation = `ori`.
// Little-endian TIFF, IFD0 with 1 entry, orientation (0x0112 / SHORT / count=1 / value).
function buildMinimalExifSegment(ori) {
  const tiffLen = 8 /*header*/ + 2 /*count*/ + 12 /*entry*/ + 4 /*next IFD*/;
  const segLen  = 2 /*length field*/ + 6 /*Exif\0\0*/ + tiffLen;
  const segBuf  = new Uint8Array(2 + segLen);
  const dv      = new DataView(segBuf.buffer);
  let p = 0;
  dv.setUint16(p, 0xFFE1);                              p += 2; // APP1 marker
  dv.setUint16(p, segLen);                              p += 2; // length (excludes marker)
  new Uint8Array(segBuf.buffer, p, 6).set([0x45,0x78,0x69,0x66,0x00,0x00]); p += 6; // "Exif\0\0"
  const tiffStart = p;
  dv.setUint16(p, 0x4949);                              p += 2; // II (little-endian)
  dv.setUint16(p, 42, true);                            p += 2;
  dv.setUint32(p, 8, true);                             p += 4; // IFD0 offset (from tiffStart)
  dv.setUint16(p, 1, true);                             p += 2; // entry count
  dv.setUint16(p, 0x0112, true);                        p += 2; // tag
  dv.setUint16(p, 3, true);                             p += 2; // type SHORT
  dv.setUint32(p, 1, true);                             p += 4; // count
  dv.setUint16(p, ori, true);                           p += 2; // value
  dv.setUint16(p, 0, true);                             p += 2; // padding to 4 bytes
  dv.setUint32(p, 0, true);                             p += 4; // next IFD offset (none)
  return segBuf;
}

function injectMinimalExif(buf, ori) {
  const seg = buildMinimalExifSegment(ori);
  const out = new Uint8Array(2 + seg.length + (buf.length - 2));
  out[0] = 0xFF; out[1] = 0xD8;
  out.set(seg, 2);
  out.set(buf.subarray(2), 2 + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}

// Replace the existing APP1 segment with a version that has the orientation tag added.
// This is rare: only fires when EXIF exists but lacks orientation. For simplicity we
// swap it for a minimal EXIF rather than splicing into the old IFD.
function insertOrientationInExif(buf, segStart, oldSegLen, _tiffStart, ori) {
  const seg = buildMinimalExifSegment(ori);
  const before = buf.subarray(0, segStart);
  const after  = buf.subarray(segStart + 2 + oldSegLen);
  const out = new Uint8Array(before.length + seg.length + after.length);
  out.set(before, 0);
  out.set(seg, before.length);
  out.set(after, before.length + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}
