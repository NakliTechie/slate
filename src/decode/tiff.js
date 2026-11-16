import { emit } from '../core/events.js';
import { importPinned, ENTRIES } from './pinned.js';
import { checkPixels } from './limits.js';

// UTIF — pure-JS TIFF decoder (~50 KB). Loaded from esm.sh on first use, each file
// checked against its pinned SHA-256 (pinned.js, SECURITY.md).

let _utifPromise = null;

async function getUtif() {
  if (_utifPromise) return _utifPromise;
  emit('toast', { message: 'Loading TIFF decoder…', level: 'info', duration: 6000 });
  _utifPromise = importPinned(ENTRIES.utif)
    .then(mod => mod.default ?? mod)
    .catch(err => { _utifPromise = null; throw new Error('Could not load TIFF decoder: ' + err.message); });
  return _utifPromise;
}

export async function decodeTiff(blob) {
  const UTIF = await getUtif();
  const buf = await blob.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds || ifds.length === 0) throw new Error('No images found in TIFF');
  const ifd = ifds[0];
  // UTIF.decode reads only the directories; check the size they claim before decoding pixels.
  checkPixels(ifd.t256?.[0], ifd.t257?.[0], 'This TIFF file');
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  const width = ifd.width;
  const height = ifd.height;
  const canvas = new OffscreenCanvas(width, height);
  const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer ?? rgba), width, height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
