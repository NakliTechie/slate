import { emit } from '../core/events.js';
import { importPinned, ENTRIES } from './pinned.js';
import { checkPixels } from './limits.js';

// libheif-js loaded lazily from esm.sh, each file checked against its pinned SHA-256
// (pinned.js, SECURITY.md). To upgrade: change the path in pinned.js, fetch and read the
// new files, and record their hashes there and in SECURITY.md.

let _libheifPromise = null;
let _triedNative = false;
let _nativeSupport = false;

async function tryNative(blob) {
  if (_triedNative && !_nativeSupport) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    _triedNative = true;
    _nativeSupport = true;
    return bitmap;
  } catch (err) {
    _triedNative = true;
    _nativeSupport = false;
    return null;
  }
}

async function getLibheif() {
  if (_libheifPromise) return _libheifPromise;
  emit('toast', { message: 'Loading HEIC decoder…', level: 'info', duration: 8000 });
  _libheifPromise = importPinned(ENTRIES.libheif)
    .then(mod => {
      const libheif = mod.default ?? mod;
      // Some builds export a factory; others export the class directly.
      if (typeof libheif === 'function') return libheif();
      return libheif;
    })
    .catch(err => {
      _libheifPromise = null; // allow retry
      throw new Error('Could not load HEIC decoder — check your connection: ' + err.message);
    });
  return _libheifPromise;
}

export async function decodeHeic(blob) {
  // Try native decode first (Safari has it; newer Chrome builds may too)
  const native = await tryNative(blob);
  if (native) return native;

  // Fallback: libheif-js via CDN
  const libheif = await getLibheif();
  const decoder = new libheif.HeifDecoder();
  const buf = await blob.arrayBuffer();
  const images = decoder.decode(buf);
  if (!images || images.length === 0) throw new Error('No image found in HEIC');

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  checkPixels(width, height, 'This HEIC file');

  const imageData = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display(imageData, (err) => err ? reject(err) : resolve());
  });

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
