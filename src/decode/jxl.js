import { emit } from '../core/events.js';

// Exact version pin per SECURITY.md.
const URL = 'https://esm.sh/@jsquash/jxl@1.3.0/decode';

let _decodePromise = null;

async function getDecoder() {
  if (_decodePromise) return _decodePromise;
  emit('toast', { message: 'Loading JPEG-XL decoder…', level: 'info', duration: 6000 });
  _decodePromise = import(URL)
    .then(mod => mod.default ?? mod.decode ?? mod)
    .catch(err => { _decodePromise = null; throw new Error('Could not load JPEG-XL decoder: ' + err.message); });
  return _decodePromise;
}

export async function decodeJxl(blob) {
  const decode = await getDecoder();
  const buf = await blob.arrayBuffer();
  const imageData = await decode(buf);
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
