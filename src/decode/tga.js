// tga-js is vendored locally — see src/vendor/tga-js.mjs and SECURITY.md.
import TGA from '../vendor/tga-js.mjs';

export async function decodeTga(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const inst = new TGA();
  inst.load(buf);
  const id = inst.getImageData();
  if (!id?.width || !id?.height) throw new Error('TGA decoded with empty dimensions');
  const out = new OffscreenCanvas(id.width, id.height);
  out.getContext('2d').putImageData(new ImageData(id.data, id.width, id.height), 0, 0);
  return out.transferToImageBitmap();
}
