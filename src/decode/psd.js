import { emit } from '../core/events.js';

// ag-psd returns a flattened canvas via its initialized canvas factory.
// Exact version pin per SECURITY.md.
const URL = 'https://esm.sh/ag-psd@30.1.1';

let _libPromise = null;

async function getLib() {
  if (_libPromise) return _libPromise;
  emit('toast', { message: 'Loading PSD decoder…', level: 'info', duration: 8000 });
  _libPromise = import(URL)
    .then(mod => {
      const lib = mod.default ?? mod;
      // ag-psd needs to be told how to make a canvas in non-DOM contexts;
      // in a browser main thread it picks up `document` automatically.
      if (lib.initializeCanvas && typeof OffscreenCanvas !== 'undefined') {
        lib.initializeCanvas(
          (w, h) => new OffscreenCanvas(w, h),
          (img) => { const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0); return c; }
        );
      }
      return lib;
    })
    .catch(err => { _libPromise = null; throw new Error('Could not load PSD decoder: ' + err.message); });
  return _libPromise;
}

export async function decodePsd(blob) {
  const lib = await getLib();
  const buf = await blob.arrayBuffer();
  const psd = lib.readPsd(buf, { skipLayerImageData: true, skipThumbnail: true });
  if (!psd?.canvas) throw new Error('PSD has no rendered composite — file may be empty or unsupported');
  const W = psd.width ?? psd.canvas.width;
  const H = psd.height ?? psd.canvas.height;
  const out = new OffscreenCanvas(W, H);
  out.getContext('2d').drawImage(psd.canvas, 0, 0);
  return out.transferToImageBitmap();
}
