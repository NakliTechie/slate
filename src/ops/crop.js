export async function apply(canvas, { x, y, w, h }) {
  const ox = Math.max(0, Math.round(x));
  const oy = Math.max(0, Math.round(y));
  const ow = Math.max(1, Math.round(w));
  const oh = Math.max(1, Math.round(h));
  const out = new OffscreenCanvas(ow, oh);
  out.getContext('2d').drawImage(canvas, -ox, -oy);
  return out;
}
