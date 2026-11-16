import { emit } from '../core/events.js';

// Reuses the same hash-checked utif build that decode/tiff.js uses (decode/pinned.js, review S8).
import { importPinned, ENTRIES } from '../decode/pinned.js';

let _utifPromise = null;

async function getUtif() {
  if (_utifPromise) return _utifPromise;
  emit('toast', { message: 'Loading TIFF encoder…', level: 'info', duration: 6000 });
  _utifPromise = importPinned(ENTRIES.utif)
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
