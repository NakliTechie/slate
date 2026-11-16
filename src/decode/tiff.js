import { emit } from '../core/events.js';

// UTIF — pure-JS TIFF decoder (~50 KB). Lazy-loaded from esm.sh on first use.
const UTIF_URL = 'https://esm.sh/utif@3.1.0';

let _utifPromise = null;

async function getUtif() {
  if (_utifPromise) return _utifPromise;
  emit('toast', { message: 'Loading TIFF decoder…', level: 'info', duration: 6000 });
  _utifPromise = import(UTIF_URL)
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
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  const width = ifd.width;
  const height = ifd.height;
  const canvas = new OffscreenCanvas(width, height);
  const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer ?? rgba), width, height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
