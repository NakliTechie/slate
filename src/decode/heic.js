import { emit } from '../core/events.js';

// libheif-js loaded lazily from esm.sh. Exact version pin per SECURITY.md.
// To upgrade: fetch the new bundle, audit the JS bytes, update the version +
// content hash in SECURITY.md, then update this constant.
const LIBHEIF_URL = 'https://esm.sh/libheif-js@1.19.8/wasm-bundle.js';

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
  _libheifPromise = import(LIBHEIF_URL)
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

  const imageData = new ImageData(width, height);
  await new Promise((resolve, reject) => {
    image.display(imageData, (err) => err ? reject(err) : resolve());
  });

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
