// Inline EXIF parser — JPEG APP1 + PNG eXIf. No external library.

const TAGS = {
  0x010F: 'make', 0x0110: 'model', 0x0112: 'orientation',
  0x0131: 'software', 0x0132: 'dateTime', 0x013B: 'artist',
  0x8298: 'copyright', 0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized',
  0x8769: 'exifIFD', 0x8825: 'gpsIFD',
  0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8822: 'exposureProgram',
  0x8827: 'isoSpeedRatings', 0x9201: 'shutterSpeedValue', 0x9202: 'apertureValue',
  0x9204: 'exposureBiasValue', 0x9205: 'maxApertureValue', 0x9207: 'meteringMode',
  0x9208: 'lightSource', 0x9209: 'flash', 0x920A: 'focalLength',
  0xA002: 'pixelXDimension', 0xA003: 'pixelYDimension', 0xA405: 'focalLengthIn35mm',
  0xA431: 'bodySerialNumber', 0xA432: 'lensSpecification', 0xA434: 'lensModel',
};

const GPS_TAGS = {
  0x0000: 'versionID', 0x0001: 'latitudeRef', 0x0002: 'latitude',
  0x0003: 'longitudeRef', 0x0004: 'longitude', 0x0005: 'altitudeRef',
  0x0006: 'altitude', 0x001D: 'dateStamp', 0x001C: 'areaInformation',
};

const TYPES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 12: 8 };

function readIFD(view, offset, le, tagMap = TAGS) {
  const result = {};
  try {
    const count = view.getUint16(offset, le);
    offset += 2;
    for (let i = 0; i < count; i++) {
      const tag = view.getUint16(offset, le);
      const type = view.getUint16(offset + 2, le);
      const cnt = view.getUint32(offset + 4, le);
      const valOff = offset + 8;
      offset += 12;

      const name = tagMap[tag];
      if (!name) continue;

      const size = (TYPES[type] ?? 1) * cnt;
      const dataOff = size > 4 ? view.getUint32(valOff, le) : valOff;

      result[name] = readValue(view, dataOff, type, cnt, le);
    }
  } catch {}
  return result;
}

function readValue(view, off, type, cnt, le) {
  try {
    if (type === 2) {
      let s = '';
      for (let i = 0; i < cnt - 1; i++) s += String.fromCharCode(view.getUint8(off + i));
      return s.trim();
    }
    if (type === 3) return cnt === 1 ? view.getUint16(off, le) : Array.from({ length: cnt }, (_, i) => view.getUint16(off + i * 2, le));
    if (type === 4) return cnt === 1 ? view.getUint32(off, le) : Array.from({ length: cnt }, (_, i) => view.getUint32(off + i * 4, le));
    if (type === 5) {
      const vals = Array.from({ length: cnt }, (_, i) => [view.getUint32(off + i * 8, le), view.getUint32(off + i * 8 + 4, le)]);
      return cnt === 1 ? vals[0] : vals;
    }
    if (type === 9) return cnt === 1 ? view.getInt32(off, le) : Array.from({ length: cnt }, (_, i) => view.getInt32(off + i * 4, le));
    if (type === 10) {
      const vals = Array.from({ length: cnt }, (_, i) => [view.getInt32(off + i * 8, le), view.getInt32(off + i * 8 + 4, le)]);
      return cnt === 1 ? vals[0] : vals;
    }
    if (type === 1) return cnt === 1 ? view.getUint8(off) : null;
  } catch {}
  return null;
}

function parseTiff(buffer, baseOffset = 0) {
  const view = new DataView(buffer, baseOffset);
  const byteOrder = view.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) return null;
  const le = byteOrder === 0x4949;
  if (view.getUint16(2, le) !== 42) return null;
  const ifd0Offset = view.getUint32(4, le);

  const ifd0 = readIFD(view, ifd0Offset, le, TAGS);

  if (ifd0.exifIFD) {
    const exifData = readIFD(view, ifd0.exifIFD, le, TAGS);
    Object.assign(ifd0, exifData);
  }
  if (ifd0.gpsIFD) {
    const gpsData = readIFD(view, ifd0.gpsIFD, le, GPS_TAGS);
    ifd0.gps = gpsData;
    ifd0.hasGPS = !!(gpsData.latitude && gpsData.longitude);
  }

  return ifd0;
}

function findJpegApp1(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xFFD8) return null;
  let offset = 2;
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFDA) break;
    const segLen = view.getUint16(offset + 2);
    if (marker === 0xFFE1) {
      if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
        return offset + 10; // offset of TIFF header within buffer
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

// Returns the full raw APP1 segment (marker + length + data) for EXIF re-injection
function extractJpegApp1Raw(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xFFD8) return null;
  let offset = 2;
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFDA) break;
    const segLen = view.getUint16(offset + 2);
    if (marker === 0xFFE1) {
      if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
        return buffer.slice(offset, offset + 2 + segLen);
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

function findPngExif(buffer) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const view = new DataView(buffer);
  for (let i = 0; i < sig.length; i++) {
    if (view.getUint8(i) !== sig[i]) return null;
  }
  let offset = 8;
  while (offset < buffer.byteLength - 8) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    if (type === 'eXIf') return offset + 8;
    if (type === 'IEND') break;
    offset += 4 + 4 + len + 4;
  }
  return null;
}

// Returns structured EXIF or null
export async function parseExif(file) {
  try {
    const slice = file.slice(0, Math.min(file.size, 128 * 1024));
    const buffer = await slice.arrayBuffer();
    const view = new DataView(buffer);

    let tiffOffset = null;
    const magic = view.getUint16(0);

    let app1Raw = null;
    if (magic === 0xFFD8) {
      tiffOffset = findJpegApp1(buffer);
      if (tiffOffset != null) app1Raw = extractJpegApp1Raw(buffer);
    } else if (view.getUint32(0) === 0x89504E47) {
      tiffOffset = findPngExif(buffer);
    } else if (
      view.getUint32(0) === 0x52494646 && // RIFF
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)) === 'WEBP'
    ) {
      // WebP EXIF chunk search (simplified — look for "EXIF" chunk)
      let off = 12;
      while (off < buffer.byteLength - 8) {
        const chunkId = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
        const chunkLen = view.getUint32(off + 4, true);
        if (chunkId === 'EXIF') { tiffOffset = off + 8; break; }
        off += 8 + chunkLen + (chunkLen % 2);
      }
    }

    if (tiffOffset == null) return null;
    const result = parseTiff(buffer, tiffOffset);
    if (result && app1Raw) result.raw = app1Raw;
    return result;
  } catch {
    return null;
  }
}

export function formatExposureTime(rational) {
  if (!rational) return null;
  const [n, d] = rational;
  if (n === 0) return null;
  if (d / n >= 1) return `1/${Math.round(d / n)}s`;
  return `${(n / d).toFixed(1)}s`;
}

export function formatRational(rational, decimals = 1) {
  if (!rational) return null;
  const [n, d] = rational;
  if (d === 0) return null;
  return (n / d).toFixed(decimals);
}

export function formatGPS(exif) {
  if (!exif?.gps?.latitude || !exif?.gps?.longitude) return null;
  const lat = dmsToDecimal(exif.gps.latitude, exif.gps.latitudeRef === 'S');
  const lon = dmsToDecimal(exif.gps.longitude, exif.gps.longitudeRef === 'W');
  if (lat == null || lon == null) return null;
  return { lat, lon, display: `${lat.toFixed(6)}, ${lon.toFixed(6)}` };
}

function dmsToDecimal(dms, negate) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const toFloat = (r) => Array.isArray(r) ? r[0] / (r[1] || 1) : r;
  const deg = toFloat(dms[0]);
  const min = toFloat(dms[1]);
  const sec = toFloat(dms[2]);
  const result = deg + min / 60 + sec / 3600;
  return negate ? -result : result;
}

// Strip EXIF from JPEG buffer — removes all APP1 EXIF segments
export function stripJpegExif(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xFFD8) return buffer;
  const out = [new Uint8Array([0xFF, 0xD8])];
  let offset = 2;
  while (offset < buffer.byteLength - 2) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFDA) {
      out.push(new Uint8Array(buffer, offset));
      break;
    }
    if (marker < 0xFF00) break;
    const segLen = view.getUint16(offset + 2);
    const isExifApp1 = marker === 0xFFE1 &&
      view.getUint32(offset + 4) === 0x45786966 &&
      view.getUint16(offset + 8) === 0x0000;
    if (!isExifApp1) {
      out.push(new Uint8Array(buffer, offset, 2 + segLen));
    }
    offset += 2 + segLen;
  }
  const total = out.reduce((a, b) => a + b.byteLength, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of out) { result.set(chunk, pos); pos += chunk.byteLength; }
  return result.buffer;
}
