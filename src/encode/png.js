export async function encodePng(canvas) {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out.convertToBlob({ type: 'image/png' });
}
