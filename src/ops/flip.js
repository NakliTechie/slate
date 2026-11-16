export async function apply(canvas, { axis }) {
  const { width: W, height: H } = canvas;
  const out = new OffscreenCanvas(W, H);
  const ctx = out.getContext('2d');
  if (axis === 'h') { ctx.translate(W, 0); ctx.scale(-1, 1); }
  else              { ctx.translate(0, H); ctx.scale(1, -1); }
  ctx.drawImage(canvas, 0, 0);
  return out;
}
