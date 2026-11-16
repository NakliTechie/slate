export async function apply(canvas, { w, h }) {
  const ow = Math.max(1, Math.round(w));
  const oh = Math.max(1, Math.round(h));
  const out = new OffscreenCanvas(ow, oh);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, ow, oh);
  return out;
}
