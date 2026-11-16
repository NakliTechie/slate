// dds-parser is vendored locally — see src/vendor/dds-parser.mjs and SECURITY.md.
import { parseHeaders, decodeDds } from '../vendor/dds-parser.mjs';

export async function decodeDdsBlob(blob) {
  const buf = await blob.arrayBuffer();
  const headers = parseHeaders(buf);
  if (!headers?.images?.length) throw new Error('DDS file has no images');
  const top = headers.images[0];
  const bytes = new Uint8Array(buf, top.offset, top.length);
  const rgba = decodeDds(bytes, headers.format, top.shape.width, top.shape.height);
  const out = new OffscreenCanvas(top.shape.width, top.shape.height);
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), top.shape.width, top.shape.height), 0, 0);
  return out.transferToImageBitmap();
}

// Keep the original symbol name so registry.js doesn't have to change.
export { decodeDdsBlob as decodeDds };
