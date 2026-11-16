export async function encodeWebp(canvas, quality = 0.9, lossless = false) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out.convertToBlob({
    type: 'image/webp',
    quality: lossless ? undefined : quality / 100
  });
}
