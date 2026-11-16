import { sanitiseExifApp1 } from '../exif.js';

// exifRaw: the original APP1 EXIF segment to carry over, or null. It is written cleaned
// (exif.js sanitiseExifApp1): no embedded thumbnail, orientation 1, and no GPS unless
// removeLocation is false. A segment that cannot be cleaned is left out.
export async function encodeJpeg(canvas, quality = 0.9, exifRaw = null, { removeLocation = true } = {}) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });

  const app1 = exifRaw ? sanitiseExifApp1(exifRaw, { removeLocation }) : null;
  if (!app1) return blob;

  // Inject raw APP1 EXIF segment right after the SOI marker
  const jpegBuf = await blob.arrayBuffer();
  const rest = new Uint8Array(jpegBuf, 2); // skip SOI
  const merged = new Uint8Array(2 + app1.byteLength + rest.byteLength);
  merged[0] = 0xFF; merged[1] = 0xD8;       // SOI
  merged.set(app1, 2);
  merged.set(rest, 2 + app1.byteLength);
  return new Blob([merged], { type: 'image/jpeg' });
}
