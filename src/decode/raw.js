// RAW decode via embedded JPEG preview extraction.
// Most RAW formats (CR2, NEF, ARW, DNG, RAF, ORF) are TIFF-based containers that
// embed a full-resolution JPEG preview. For a viewer/editor app, extracting that
// preview gives a usable image without the ~5 MB libraw wasm.
// True sensor-level demosaicing is a v3+ feature.

export async function decodeRaw(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const jpegs = findEmbeddedJpegs(buf);
  if (jpegs.length === 0) throw new Error('No embedded JPEG preview found in this RAW file');

  // Pick the largest preview (usually the full-res one)
  jpegs.sort((a, b) => b.size - a.size);
  const largest = jpegs[0];
  const jpegBytes = buf.subarray(largest.start, largest.start + largest.size);
  const jpegBlob = new Blob([jpegBytes], { type: 'image/jpeg' });
  return createImageBitmap(jpegBlob);
}

// Scan for JPEG SOI/EOI pairs. Returns [{ start, size }] of each embedded JPEG.
// The first SOI must be followed by a valid marker (FFE0-FFEF or FFDB/FFC0) to
// reduce false positives from random 0xFFD8 bytes in sensor data.
function findEmbeddedJpegs(buf) {
  const out = [];
  const len = buf.length;
  let i = 0;
  while (i < len - 3) {
    // Find SOI marker
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      const third = buf[i + 3];
      // Valid next marker: APP0-APP15 (E0-EF), DQT (DB), SOF0 (C0), COM (FE)
      const isValid = (third >= 0xE0 && third <= 0xEF) || third === 0xDB || third === 0xC0 || third === 0xFE;
      if (isValid) {
        // Walk segments to find the EOI. A robust walker respects segment lengths
        // so we don't accidentally stop at an FFD9 inside compressed data.
        const end = walkJpeg(buf, i);
        if (end > i) {
          out.push({ start: i, size: end - i });
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

// Walk a JPEG segment-by-segment from SOI to find the EOI.
// Returns the byte offset JUST AFTER the EOI, or -1 on malformation.
function walkJpeg(buf, start) {
  const len = buf.length;
  let p = start + 2; // skip SOI (FFD8)
  while (p < len - 1) {
    if (buf[p] !== 0xFF) return -1;
    // Skip any fill bytes (0xFF)
    while (p < len - 1 && buf[p + 1] === 0xFF) p++;
    const marker = buf[p + 1];

    // Standalone markers (no length field)
    if (marker === 0xD9) return p + 2; // EOI — done
    if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }

    // Segment with length (big-endian uint16)
    if (p + 3 >= len) return -1;
    const segLen = (buf[p + 2] << 8) | buf[p + 3];
    p += 2 + segLen;

    // SOS: entropy-coded data follows until next non-RST marker
    if (marker === 0xDA) {
      while (p < len - 1) {
        if (buf[p] === 0xFF) {
          // skip fill bytes
          while (p < len - 1 && buf[p + 1] === 0xFF) p++;
          const m = buf[p + 1];
          if (m !== 0x00 && !(m >= 0xD0 && m <= 0xD7)) break; // real marker
        }
        p++;
      }
    }
  }
  return -1;
}
