export async function apply(canvas, { deg }) {
  const rad = deg * Math.PI / 180;
  const W = canvas.width, H = canvas.height;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.round(W * cos + H * sin);
  const outH = Math.round(W * sin + H * cos);
  const out = new OffscreenCanvas(outW, outH);
  const ctx = out.getContext('2d');
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -W / 2, -H / 2);
  return out;
}
