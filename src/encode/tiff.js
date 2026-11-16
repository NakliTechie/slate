import { emit } from '../core/events.js';

// Reuses the same utif build that decode/tiff.js uses.
const URL = 'https://esm.sh/utif@3.1.0';

let _utifPromise = null;

async function getUtif() {
  if (_utifPromise) return _utifPromise;
  emit('toast', { message: 'Loading TIFF encoder…', level: 'info', duration: 6000 });
  _utifPromise = import(URL)
    .then(mod => mod.default ?? mod)
    .catch(err => { _utifPromise = null; throw new Error('Could not load TIFF encoder: ' + err.message); });
  return _utifPromise;
}

export async function encodeTiff(canvas) {
  const UTIF = await getUtif();
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // utif.encodeImage(rgba, width, height) -> ArrayBuffer with a single-IFD TIFF
  const buf = UTIF.encodeImage(imageData.data, imageData.width, imageData.height);
  return new Blob([buf], { type: 'image/tiff' });
}
