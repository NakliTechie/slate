import { emit } from '../core/events.js';
import { importPinned, fetchPinned, ENTRIES } from './pinned.js';
import { checkJxl } from './limits.js';

// @jsquash/jxl from esm.sh. The module and its WebAssembly file are each checked against
// their pinned SHA-256 (pinned.js, SECURITY.md); the checked wasm bytes are handed to
// init(), so the module never fetches its own copy.

let _decodePromise = null;

async function getDecoder() {
  if (_decodePromise) return _decodePromise;
  emit('toast', { message: 'Loading JPEG-XL decoder…', level: 'info', duration: 6000 });
  _decodePromise = (async () => {
    const [mod, wasm] = await Promise.all([importPinned(ENTRIES.jxl), fetchPinned(ENTRIES.jxlWasm)]);
    // init(module, options): a null module makes it instantiate wasmBinary itself.
    // locateFile keeps it from building a URL from import.meta.url, which is a blob: URL here.
    await mod.init(null, { wasmBinary: new Uint8Array(wasm), locateFile: (p) => p });
    return mod.default;
  })().catch(err => { _decodePromise = null; throw new Error('Could not load JPEG-XL decoder: ' + err.message); });
  return _decodePromise;
}

export async function decodeJxl(blob) {
  const buf = await blob.arrayBuffer();
  checkJxl(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536)));
  const decode = await getDecoder();
  const imageData = await decode(buf);
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.transferToImageBitmap();
}
